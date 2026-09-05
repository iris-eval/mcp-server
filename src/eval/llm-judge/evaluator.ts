import { callLLMJudge, estimateInputTokens, LLMJudgeError, type LLMProvider } from './client.js';
import { estimateCostUsd, findPricing } from './pricing.js';
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
function parseJudgeResponse(raw: string): {
  score: number;
  passed?: boolean;
  rationale: string;
  dimensions: Record<string, number>;
} {
  // Strip common wrapping patterns (markdown fences, leading prose) to
  // give the JSON parser the best chance.
  const trimmed = raw
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/```$/i, '')
    .trim();

  // Find the first { and last } — models sometimes prepend "Here's the
  // evaluation:" despite being told not to. Parse the substring.
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    throw new LLMJudgeError(
      `Judge response did not contain a JSON object: ${raw.slice(0, 200)}`,
      'malformed_response',
    );
  }
  const slice = trimmed.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch (err) {
    throw new LLMJudgeError(
      `Judge response was not valid JSON: ${(err as Error).message} — raw: ${slice.slice(0, 200)}`,
      'malformed_response',
    );
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new LLMJudgeError('Judge response was not a JSON object', 'malformed_response');
  }
  const obj = parsed as Record<string, unknown>;

  const scoreRaw = obj.score;
  const score = typeof scoreRaw === 'number' ? scoreRaw : Number(scoreRaw);
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new LLMJudgeError(
      `Judge score out of [0..1]: ${String(scoreRaw)}`,
      'malformed_response',
    );
  }

  const rationale = typeof obj.rationale === 'string' ? obj.rationale : '';
  const dimensions: Record<string, number> = {};
  if (obj.dimensions && typeof obj.dimensions === 'object') {
    for (const [k, v] of Object.entries(obj.dimensions as Record<string, unknown>)) {
      const n = typeof v === 'number' ? v : Number(v);
      if (Number.isFinite(n)) dimensions[k] = n;
    }
  }

  return {
    score: Math.round(score * 100) / 100,
    passed: typeof obj.passed === 'boolean' ? obj.passed : undefined,
    rationale,
    dimensions,
  };
}

export async function evaluateWithLLMJudge(
  params: LLMJudgeEvaluateParams,
): Promise<LLMJudgeEvaluationResult> {
  const template = getTemplate(params.template);
  const maxOutputTokens = params.maxOutputTokens ?? 512;
  const temperature = params.temperature ?? 0;
  const maxCost = params.maxCostUsdPerEval ?? 0.25;

  // Pre-check pricing exists — if the model is unknown we can't enforce
  // the cap, so refuse upfront rather than silently skip cost control.
  if (!findPricing(params.model)) {
    throw new Error(
      `Unknown model "${params.model}" for provider "${params.provider}". Add its pricing to src/eval/llm-judge/pricing.ts before use, or pick a supported model.`,
    );
  }

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
  const strictSystem =
    systemPrompt +
    '\n\nIMPORTANT: your previous response was not valid JSON. Respond with ONLY the JSON object, no prefatory text, no code fences.';
  const retryMaxOutputTokens = Math.min(maxOutputTokens, 256);

  /*
   * Estimate worst-case cost and reject before the network call if it
   * would exceed the cap. Intentionally pessimistic — every input
   * character billed, the full output cap billed, AND the malformed-JSON
   * retry billed on top — because the cap is meant to be a hard ceiling,
   * not a soft hope. The estimate used to price a single call, so an eval
   * that fit just under the cap could bill nearly twice the cap whenever
   * the judge misformatted its first reply.
   */
  const firstAttemptCost = estimateCostUsd(
    params.model,
    estimateInputTokens(systemPrompt, userPrompt),
    maxOutputTokens,
  );
  const retryCost = estimateCostUsd(
    params.model,
    estimateInputTokens(strictSystem, userPrompt),
    retryMaxOutputTokens,
  );
  const estimatedCost =
    firstAttemptCost === null || retryCost === null ? null : firstAttemptCost + retryCost;
  if (estimatedCost !== null && estimatedCost > maxCost) {
    throw new CostCapError(estimatedCost, maxCost);
  }

  // First attempt
  let raw = await callLLMJudge({
    provider: params.provider,
    model: params.model,
    systemPrompt,
    userPrompt,
    maxOutputTokens,
    temperature,
    apiKey: params.apiKey,
    timeoutMs: params.timeoutMs,
    maxInputTokensEstimate: params.maxInputTokensEstimate,
  });

  /*
   * Running totals across BOTH attempts. A first call whose reply failed
   * to parse still completed at the provider and was billed; the retry's
   * usage used to overwrite it, so `cost_usd` (surfaced by
   * evaluate_with_llm_judge and stored on the eval result) understated the
   * real charge by roughly half whenever a retry ran.
   */
  let inputTokens = raw.inputTokens;
  let outputTokens = raw.outputTokens;
  let latencyMs = raw.latencyMs;

  let parsed;
  try {
    parsed = parseJudgeResponse(raw.content);
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
      timeoutMs: params.timeoutMs,
      maxInputTokensEstimate: params.maxInputTokensEstimate,
    });
    inputTokens += raw.inputTokens;
    outputTokens += raw.outputTokens;
    latencyMs += raw.latencyMs;
    parsed = parseJudgeResponse(raw.content);
  }

  /*
   * The threshold decides. The model's own boolean is evidence about the
   * model, not about the output, and it is recorded beside the verdict
   * rather than substituted for it.
   */
  const passed = parsed.score >= template.passThreshold;
  const disagreement = parsed.passed !== undefined && parsed.passed !== passed;
  const costUsd = estimateCostUsd(params.model, inputTokens, outputTokens);

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
