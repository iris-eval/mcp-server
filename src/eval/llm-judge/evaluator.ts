import { verdictAnswer, type JudgeAnswer } from './answer.js';
import { callLLMJudge, estimateInputTokens, LLMJudgeError, type LLMJudgeResponse, type LLMProvider } from './client.js';
import { DEFAULT_JUDGE_DEADLINE_MS } from './deadline.js';
import { estimateCostUsd, findPricing, worstCaseRequestUsd } from './pricing.js';
import { answerObject, shownReply, shownValue, unitNumber } from './reply.js';
import { getTemplate, type TemplateName } from './templates/index.js';

/**
 * The pre-check refused the call: the worst-case spend (two attempts) would
 * exceed the cap. Typed so the tool can answer IRIS_BUDGET_EXCEEDED with both
 * numbers; nothing was spent.
 */
export class CostCapError extends Error {
  constructor(
    public readonly estimatedUsd: number,
    public readonly capUsd: number,
  ) {
    super(
      `Estimated max cost ${estimatedUsd.toFixed(4)} USD (including one retry on a malformed judge reply) exceeds cap ${capUsd.toFixed(4)} USD — refusing to call. Raise IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL or max_cost_usd, or trim prompts/maxOutputTokens.`,
    );
    this.name = 'CostCapError';
  }
}

export interface LLMJudgeEvaluateParams {
  output: string;
  template: TemplateName;
  provider: LLMProvider;
  model: string;
  apiKey: string;
  // Optional context per-template
  input?: string;
  expected?: string;
  sourceMaterial?: string;
  // Cost + latency bounds
  maxCostUsdPerEval?: number;
  maxOutputTokens?: number;
  timeoutMs?: number;
  temperature?: number;
  maxInputTokensEstimate?: number;
}

export interface LLMJudgeEvaluationResult {
  /**
   * The verdict, and it is the THRESHOLD's, not the model's.
   *
   * Until 0.10.0 the model's own `passed` boolean won whenever it supplied
   * one, and the template's threshold was a fallback the product rarely
   * reached. That let a judge return `score: 0.2` with `passed: true` and
   * be believed — a scoring rubric whose score did not decide anything.
   * Now the score is the measurement and the threshold is the rule.
   */
  passed: boolean;
  score: number;
  /** The threshold the score was read against, so a reader can check the arithmetic. */
  passThreshold: number;
  /** What the model said about passing, when it said anything. Recorded, never obeyed. */
  selfReportedPass?: boolean;
  /**
   * True when the model's own boolean disagrees with the threshold verdict.
   * Worth surfacing: a judge that scores 0.95 and says "fail", or scores
   * 0.2 and says "pass", is telling you its rubric and its judgement have
   * come apart on this output.
   */
  disagreement?: boolean;
  rationale: string;
  dimensions: Record<string, number>;
  // Provenance so the dashboard / audit log / trace detail can show the
  // user exactly which model produced this score at what cost.
  model: string;
  provider: LLMProvider;
  template: TemplateName;
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  latencyMs: number;
  rawResponseId?: string;
}

// Malformed judge response — retried once by `evaluate`, surfaced as
// LLMJudgeError('malformed_response') if the retry also fails.
function parseJudgeResponse(raw: string, structured: boolean | undefined): {
  score: number;
  passed?: boolean;
  rationale: string;
  dimensions: Record<string, number>;
} {
  /*
   * The answer object (reply.ts, answerObject): the whole reply where it was
   * asked for as structured output, which is the object alone; else, from a
   * model that offers none, the object from the reply's first brace to its
   * last, so a model that writes "Here is the evaluation:" first, or fences
   * the object, still gave it.
   */
  const obj = answerObject(raw, structured);
  if (obj === null) {
    throw new LLMJudgeError(
      structured === true ? `Judge reply is not the JSON object it was asked for: ${shownReply(raw)}` : `Judge reply holds no JSON object: ${shownReply(raw)}`,
      'malformed_response',
    );
  }

  /*
   * The score is the judge's answer, and it is read only when the reply
   * gives one: a JSON number from 0 to 1 (reply.ts). A reply whose score
   * was `null`, `false`, `""` or `[]` used to read as a score of 0, which
   * fails the output, and one whose score was `true` as 1, which passes it:
   * a verdict from a reply that gave none. Such a reply is malformed, and is
   * asked for again once like any other.
   */
  const score = unitNumber(obj.score);
  if (score === null) {
    throw new LLMJudgeError(`Judge score is not a number from 0 to 1: ${shownValue(obj.score)}`, 'malformed_response');
  }

  const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
  // A dimension is kept when the reply gives a number for it. Anything else is left out, where it used to read as 0 or as 1.
  const dimensions: Record<string, number> = {};
  if (obj.dimensions && typeof obj.dimensions === 'object' && !Array.isArray(obj.dimensions)) {
    for (const [k, v] of Object.entries(obj.dimensions as Record<string, unknown>)) {
      if (typeof v === 'number' && Number.isFinite(v)) dimensions[k] = v;
    }
  }

  return {
    score: Math.round(score * 100) / 100,
    // The model's own boolean is recorded only when it is one; "true" in quotes is not.
    passed: typeof obj.passed === 'boolean' ? obj.passed : undefined,
    rationale,
    dimensions,
  };
}

/**
 * What the second request adds to the system prompt, after a first reply
 * that could not be read. It says what is true of every such reply (it used
 * to say the reply "was not valid JSON", also to a model whose JSON was
 * valid and whose score was in quotes), and asks for what is read: the JSON
 * object, and a score that is a number.
 *
 * Every character of it is priced: the worst case a call is checked at
 * before it is made counts this request too. So it stands in one place, and
 * whatever else prices a judge call (the proof runner) asks
 * `worstCaseJudgeCostUsd` and keeps no copy.
 */
export const SECOND_REQUEST =
  '\n\nIMPORTANT: your previous response could not be read. Respond with ONLY the JSON object: nothing before or after it, no code fences, and "score" as a number, not in quotes.';

/** What one judge evaluation will send, and the most it can cost. */
interface JudgePlan {
  systemPrompt: string;
  userPrompt: string;
  strictSystem: string;
  maxOutputTokens: number;
  retryMaxOutputTokens: number;
  /** The object both requests ask for: the template's answer (answer.ts). */
  answer: JudgeAnswer;
  /** The pessimistic worst case of both attempts; null when the model is unpriced. */
  estimatedCost: number | null;
}

type PlanParams = Pick<LLMJudgeEvaluateParams, 'template' | 'model' | 'output' | 'input' | 'expected' | 'sourceMaterial' | 'maxOutputTokens'>;

function planJudgeCall(params: PlanParams): JudgePlan {
  const template = getTemplate(params.template);
  const maxOutputTokens = params.maxOutputTokens ?? 512;
  const systemPrompt = template.buildSystem();
  const userPrompt = template.buildUser({
    output: params.output,
    expected: params.expected,
    input: params.input,
    sourceMaterial: params.sourceMaterial,
  });

  // The retry prompt is fixed up front so the pre-flight estimate can
  // price it: a malformed first reply triggers ONE more call with this
  // stricter system prompt and a smaller output cap.
  const strictSystem = systemPrompt + SECOND_REQUEST;
  const retryMaxOutputTokens = Math.min(maxOutputTokens, 256);
  // Both requests ask for the template's answer, and each carries its schema and the provider's instructions for it.
  const answer = verdictAnswer(template.dimensions);

  /*
   * Estimate worst-case cost and reject before the network call if it
   * would exceed the cap. Intentionally pessimistic — the input counted at
   * INPUT_ESTIMATE_MARGIN (pricing.ts) times its estimate, the full output cap billed,
   * AND the malformed-JSON retry billed on top — because the cap is meant
   * to be a ceiling, not a soft hope, for any text within that margin. The
   * estimate used to price a single call, so an eval that fit just under
   * the cap could bill nearly twice the cap whenever the judge misformatted
   * its first reply. Each request is priced on its own
   * (worstCaseRequestUsd), at the rates for its size.
   */
  const firstAttemptCost = worstCaseRequestUsd(
    params.model,
    estimateInputTokens(systemPrompt, userPrompt, answer),
    maxOutputTokens,
  );
  const retryCost = worstCaseRequestUsd(
    params.model,
    estimateInputTokens(strictSystem, userPrompt, answer),
    retryMaxOutputTokens,
  );
  const estimatedCost =
    firstAttemptCost === null || retryCost === null ? null : firstAttemptCost + retryCost;
  return { systemPrompt, userPrompt, strictSystem, maxOutputTokens, retryMaxOutputTokens, answer, estimatedCost };
}

/**
 * The most one judge evaluation can cost: the same pessimistic two-attempt
 * estimate the per-call cap refuses on. The relevance judge's daily budget
 * reserves this before a call and settles to the actual cost after, so the
 * two limits price a call identically. Null for an unpriced model.
 */
export function worstCaseJudgeCostUsd(params: PlanParams): number | null {
  return planJudgeCall(params).estimatedCost;
}

/** What one request cost, by its own size, with the input its reply says was read from or written to a cache priced at those rates. */
function requestCostUsd(model: string, raw: LLMJudgeResponse): number | null {
  return estimateCostUsd(model, raw.inputTokens, raw.outputTokens, { readTokens: raw.cacheReadTokens, writeTokens: raw.cacheWriteTokens });
}

export async function evaluateWithLLMJudge(
  params: LLMJudgeEvaluateParams,
): Promise<LLMJudgeEvaluationResult> {
  const template = getTemplate(params.template);
  const temperature = params.temperature ?? 0;
  const maxCost = params.maxCostUsdPerEval ?? 0.25;

  // Pre-check pricing exists — if the model is unknown we can't enforce
  // the cap, so refuse upfront rather than silently skip cost control.
  if (!findPricing(params.model)) {
    throw new Error(
      `Unknown model "${params.model}" for provider "${params.provider}". Add its pricing to src/eval/llm-judge/pricing.ts before use, or pick a supported model.`,
    );
  }

  const { systemPrompt, userPrompt, strictSystem, maxOutputTokens, retryMaxOutputTokens, answer, estimatedCost } = planJudgeCall(params);
  if (estimatedCost !== null && estimatedCost > maxCost) {
    throw new CostCapError(estimatedCost, maxCost);
  }

  // One deadline for the whole call: both requests, their replies and any wait after a rate limit end before it.
  // Read as a number, as a timer reads it: a length given as text is the number it names, not text joined to the clock.
  const timeoutMs = (params.timeoutMs ?? DEFAULT_JUDGE_DEADLINE_MS) * 1;
  const deadline = Date.now() + timeoutMs;

  // First attempt
  let raw = await callLLMJudge({
    provider: params.provider,
    model: params.model,
    systemPrompt,
    userPrompt,
    maxOutputTokens,
    temperature,
    apiKey: params.apiKey,
    timeoutMs,
    deadline,
    maxInputTokensEstimate: params.maxInputTokensEstimate,
    answer,
  });

  /*
   * Running totals across BOTH attempts. A first call whose reply failed
   * to parse still completed at the provider and was billed; the retry's
   * usage used to overwrite it, so `cost_usd` (surfaced by
   * evaluate_with_llm_judge and stored on the eval result) understated the
   * real charge by roughly half whenever a retry ran. The cost is the sum of
   * each request priced on its own, as the provider bills them: priced as
   * one request of their summed size, two requests each under a long
   * request's line were billed at its higher rates.
   */
  let inputTokens = raw.inputTokens;
  let outputTokens = raw.outputTokens;
  let latencyMs = raw.latencyMs;
  let costUsd = requestCostUsd(params.model, raw);

  let parsed;
  try {
    parsed = parseJudgeResponse(raw.content, raw.structured);
  } catch (err) {
    if (!(err instanceof LLMJudgeError) || err.kind !== 'malformed_response') throw err;
    // Retry once with the stricter prompt priced above.
    raw = await callLLMJudge({
      provider: params.provider,
      model: params.model,
      systemPrompt: strictSystem,
      userPrompt,
      maxOutputTokens: retryMaxOutputTokens,
      temperature,
      apiKey: params.apiKey,
      timeoutMs,
      deadline,
      maxInputTokensEstimate: params.maxInputTokensEstimate,
      answer,
    });
    inputTokens += raw.inputTokens;
    outputTokens += raw.outputTokens;
    latencyMs += raw.latencyMs;
    const retryCostUsd = requestCostUsd(params.model, raw);
    costUsd = costUsd === null || retryCostUsd === null ? null : Math.round((costUsd + retryCostUsd) * 1_000_000) / 1_000_000;
    parsed = parseJudgeResponse(raw.content, raw.structured);
  }

  /*
   * The threshold decides. The model's own boolean is evidence about the
   * model, not about the output, and it is recorded beside the verdict
   * rather than substituted for it.
   */
  const passed = parsed.score >= template.passThreshold;
  const disagreement = parsed.passed !== undefined && parsed.passed !== passed;

  return {
    passed,
    passThreshold: template.passThreshold,
    ...(parsed.passed !== undefined ? { selfReportedPass: parsed.passed } : {}),
    ...(disagreement ? { disagreement: true } : {}),
    score: parsed.score,
    rationale: parsed.rationale,
    dimensions: parsed.dimensions,
    model: params.model,
    provider: params.provider,
    template: params.template,
    inputTokens,
    outputTokens,
    costUsd,
    latencyMs,
    rawResponseId: raw.rawProviderResponseId,
  };
}
