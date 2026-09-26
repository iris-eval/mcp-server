/*
 * The relevance judge behind answers_the_ask (#649).
 *
 * answers_the_ask compares the words of the answer with the words of the
 * ask. At the shipped thresholds that failed correct answers that
 * paraphrase, so since 0.18.0 it advises rather than blocks unless a
 * deployment sets a threshold, and an answer on the wrong topic passes at
 * the defaults. A judge can read meaning where the lexical pair reads
 * words, so when a deployment installs one, answers_the_ask gates on the
 * judge's relevance verdict instead.
 *
 * "Installed" is deliberate and narrower than "a key is present". A key
 * reaching this process is what enables evaluate_with_llm_judge, a tool the
 * caller invokes and pays for per call. Every evaluate_output, every
 * ingested trace and every evaluate_runs re-score would make a judge call
 * here, so a key set for the judge tool must not start billing all of those
 * on upgrade. The deployment opts in by naming the model —
 * IRIS_RELEVANCE_JUDGE_MODEL — which is also the one input the judge cannot
 * default: cost varies a hundredfold across models.
 *
 * A judge that cannot be called (an unpriced model, no key for its
 * provider) is still installed, and says why on every evaluation it would
 * have judged, with nothing spent: a deployment that believes the judge is
 * on must never read a lexical verdict as the judge's.
 */
import { evaluateWithLLMJudge, CostCapError, type LLMJudgeEvaluateParams, type LLMJudgeEvaluationResult } from './evaluator.js';
import { findPricing } from './pricing.js';
import { sameFamily } from './family.js';
import { RELEVANCE_TEMPLATE } from './templates/index.js';
import type { LLMProvider } from './client.js';
import type { JudgeRecord } from '../../types/eval.js';
import { JUDGE_KEY_VARS, judgeCostCapUsd } from '../../judge-enablement.js';

export const RELEVANCE_JUDGE_MODEL_VAR = 'IRIS_RELEVANCE_JUDGE_MODEL';

export interface RelevanceQuestion {
  /** The ask. */
  input: string;
  output: string;
  /** The model that produced the output, when the call recorded it; for the same-family note. */
  agentModel?: string | null;
}

export interface RelevanceJudge {
  provider: LLMProvider | null;
  model: string;
  /** Why this judge cannot be called; null when it can. Every judgment it returns carries this as its error. */
  problem: string | null;
  /** Never throws: a failure is a judgment with `error` set. */
  judge(question: RelevanceQuestion): Promise<JudgeRecord>;
}

export interface RelevanceJudgeOptions {
  model: string;
  /** Inferred from the model's row in the pricing table when omitted. */
  provider?: LLMProvider;
  apiKey?: string;
  /** Per-judgment cap; the same pessimistic two-attempt pre-check the judge tool applies. */
  maxCostUsdPerEval?: number;
  timeoutMs?: number;
  /** The judge call itself; tests and the proof runner pass the real evaluator or a stand-in. */
  evaluate?: (params: LLMJudgeEvaluateParams) => Promise<LLMJudgeEvaluationResult>;
}

/** Build a relevance judge. It never throws at construction: an unusable configuration becomes `problem`. */
export function createRelevanceJudge(options: RelevanceJudgeOptions): RelevanceJudge {
  const model = options.model.trim();
  const priced = findPricing(model);
  const provider: LLMProvider | null = options.provider ?? priced?.provider ?? null;
  const problem =
    priced === null
      ? `${RELEVANCE_JUDGE_MODEL_VAR} names "${model}", which is not in the pricing table, so the cost cap cannot be enforced; the judge was not called`
      : provider !== null && !options.apiKey
        ? `${RELEVANCE_JUDGE_MODEL_VAR} names ${model}, but no ${JUDGE_KEY_VARS[provider]} reached this process; the judge was not called`
        : null;
  const evaluate = options.evaluate ?? evaluateWithLLMJudge;
  const maxCost = options.maxCostUsdPerEval ?? judgeCostCapUsd();

  const base = (): Pick<JudgeRecord, 'template' | 'provider' | 'model'> => ({ template: 'relevance', provider, model });
  const nothingSpent = { costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };

  return {
    provider,
    model,
    problem,
    async judge(q: RelevanceQuestion): Promise<JudgeRecord> {
      const agent = q.agentModel ? { agentModel: q.agentModel, ...(sameFamily(model, q.agentModel) ? { sameFamily: true } : {}) } : {};
      if (problem !== null || provider === null || !options.apiKey) {
        return { ...base(), ...nothingSpent, ...agent, error: problem ?? 'the judge has no provider or key' };
      }
      try {
        const r = await evaluate({
          output: q.output,
          input: q.input,
          template: 'relevance',
          provider,
          model,
          apiKey: options.apiKey,
          maxCostUsdPerEval: maxCost,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          temperature: 0,
        });
        return {
          ...base(),
          score: r.score,
          passThreshold: r.passThreshold,
          passed: r.passed,
          ...(r.selfReportedPass !== undefined ? { selfReportedPass: r.selfReportedPass } : {}),
          ...(r.disagreement ? { disagreement: true } : {}),
          rationale: r.rationale,
          dimensions: r.dimensions,
          costUsd: r.costUsd,
          inputTokens: r.inputTokens,
          outputTokens: r.outputTokens,
          latencyMs: r.latencyMs,
          ...agent,
        };
      } catch (err) {
        // A refusal before the call spent nothing; any other failure may have been billed by the provider and is not known here.
        const refused = err instanceof CostCapError;
        const reason = err instanceof Error ? err.message : String(err);
        return {
          ...base(),
          ...(refused ? nothingSpent : { costUsd: null, inputTokens: 0, outputTokens: 0, latencyMs: 0 }),
          ...agent,
          error: `the relevance judge did not answer: ${reason.slice(0, 300)}`,
        };
      }
    },
  };
}

/**
 * The judge this process's environment installs, or null when
 * IRIS_RELEVANCE_JUDGE_MODEL is unset. Literal reads on purpose: the docs
 * contract greps `process.env.IRIS_*` to learn what the server reads.
 */
export function relevanceJudgeFromEnv(): RelevanceJudge | null {
  const model = process.env.IRIS_RELEVANCE_JUDGE_MODEL?.trim();
  if (!model) return null;
  const provider = findPricing(model)?.provider;
  const apiKey = provider === 'anthropic' ? process.env.IRIS_ANTHROPIC_API_KEY : provider === 'openai' ? process.env.IRIS_OPENAI_API_KEY : undefined;
  return createRelevanceJudge({ model, ...(apiKey ? { apiKey } : {}) });
}

/** What the relevance judge's state is, for the capabilities resource and the self-test. */
export interface RelevanceJudgeState {
  /** A relevance judge is installed: answers_the_ask asks it whenever the call carries an input. */
  configured: boolean;
  /** It can be called: a priced model and a key for its provider. */
  ready: boolean;
  model: string | null;
  provider: LLMProvider | null;
  passThreshold: number;
  problem: string | null;
}

export function relevanceJudgeState(judge: RelevanceJudge | null): RelevanceJudgeState {
  return {
    configured: judge !== null,
    ready: judge !== null && judge.problem === null,
    model: judge?.model ?? null,
    provider: judge?.provider ?? null,
    passThreshold: RELEVANCE_TEMPLATE.passThreshold,
    problem: judge?.problem ?? null,
  };
}

/** One line for the self-test and the server instructions. */
export function relevanceJudgeStateLine(state: RelevanceJudgeState): string {
  if (!state.configured) {
    return `not configured (set ${RELEVANCE_JUDGE_MODEL_VAR} to a priced model to have answers_the_ask decide off-topic answers with the judge; until then it reads the ask lexically and advises)`;
  }
  if (!state.ready) return `configured but not callable: ${state.problem}`;
  return `on (${state.provider}/${state.model}): answers_the_ask gates on the judge's relevance verdict, one judge call per evaluation that carries an input`;
}
