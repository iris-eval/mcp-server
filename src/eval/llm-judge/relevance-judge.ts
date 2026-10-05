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
 *
 * The user owns the key and the bill, so three things hold on every call
 * (budget.ts and redact.ts carry the reasoning):
 *   - a daily budget per tenant, kept in the database and shared with the
 *     judge tools, that a call's worst case must fit before it is made;
 *   - a cap on judge calls per request, so one batch cannot spend the day;
 *   - what leaves the machine is the ask and the answer with every span
 *     no_pii flags replaced by a marker, unless the deployment opts out.
 * A call the first two stop is a judgment with `error` and `withheld` set
 * and nothing spent, and answers_the_ask reads the ask lexically instead.
 */
import { evaluateWithLLMJudge, worstCaseJudgeCostUsd, CostCapError, type LLMJudgeEvaluateParams, type LLMJudgeEvaluationResult } from './evaluator.js';
import { findPricing } from './pricing.js';
import { sameFamily } from './family.js';
import { RELEVANCE_TEMPLATE } from './templates/index.js';
import type { LLMProvider } from './client.js';
import type { JudgeRecord } from '../../types/eval.js';
import { JUDGE_KEY_VARS, judgeCostCapUsd } from '../../judge-enablement.js';
import { LOCAL_TENANT, type TenantId } from '../../types/tenant.js';
import {
  JudgeBudget,
  MAX_CALLS_PER_REQUEST_VAR,
  dailyBudgetUsd,
  judgeBudgetFromEnv,
  maxCallsPerRequest,
  memoryJudgeSpendLedger,
  newJudgeRequest,
  type BudgetToday,
  type JudgeBudgetEnvOptions,
  type JudgeRequest,
  type Setting,
} from './budget.js';
import { redactForJudge } from './redact.js';

export const RELEVANCE_JUDGE_MODEL_VAR = 'IRIS_RELEVANCE_JUDGE_MODEL';
export const RELEVANCE_JUDGE_REDACT_VAR = 'IRIS_RELEVANCE_JUDGE_REDACT';

/**
 * Whether the judge redacts before sending: `on` unless the variable says
 * `off`. Anything else keeps it on and says so: a typo must never be the
 * thing that sends a secret.
 */
export function redactionSetting(): Setting<'on' | 'off'> {
  const raw = process.env.IRIS_RELEVANCE_JUDGE_REDACT?.trim().toLowerCase();
  if (!raw || raw === 'on') return { value: 'on', source: raw ? 'env' : 'default' };
  if (raw === 'off') return { value: 'off', source: 'env' };
  return { value: 'on', source: 'default', note: `${RELEVANCE_JUDGE_REDACT_VAR}="${raw.slice(0, 40)}" is neither on nor off, so redaction stays on` };
}

export interface RelevanceQuestion {
  /** The ask. */
  input: string;
  output: string;
  /** The model that produced the output, when the call recorded it; for the same-family note. */
  agentModel?: string | null;
}

/** Who pays for a judgment, and which request it belongs to. */
export interface JudgeScope {
  /** The tenant whose daily budget the call draws on; LOCAL_TENANT when omitted. */
  tenantId?: TenantId;
  /** The request this evaluation is part of, when a door scores many traces in one; omitted, the evaluation is its own request. */
  request?: JudgeRequest;
}

export interface RelevanceJudge {
  provider: LLMProvider | null;
  model: string;
  /** Why this judge cannot be called; null when it can. Every judgment it returns carries this as its error. */
  problem: string | null;
  /** The daily budget every call draws on. */
  budget: JudgeBudget;
  /** Judge calls one request may make. */
  maxCallsPerRequest: number;
  /** Whether PII and credentials are replaced before the ask and the answer are sent. */
  redact: boolean;
  /** Configuration values that were unusable and fell back to their defaults, one sentence each. */
  notes: string[];
  /** Never throws: a failure is a judgment with `error` set. */
  judge(question: RelevanceQuestion, scope?: JudgeScope): Promise<JudgeRecord>;
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
  /**
   * The daily budget. Omitted: IRIS_LLM_JUDGE_DAILY_BUDGET_USD (or its
   * default) over a ledger in this process's memory; an embedder with a
   * database passes one built on it, as the server and the CLI do.
   */
  budget?: JudgeBudget;
  /** Judge calls one request may make; IRIS_RELEVANCE_JUDGE_MAX_CALLS_PER_REQUEST or its default when omitted. */
  maxCallsPerRequest?: number;
  /** Replace what no_pii flags before sending (default true). */
  redact?: boolean;
  /** Settings that fell back to a default, for the state surfaces to repeat. */
  notes?: string[];
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
  const notes = [...(options.notes ?? [])];
  const budget = options.budget ?? new JudgeBudget({ dailyUsd: dailyBudgetUsd().value, ledger: memoryJudgeSpendLedger() });
  const maxCalls = options.maxCallsPerRequest ?? maxCallsPerRequest().value;
  const redact = options.redact ?? true;

  const base = (): Pick<JudgeRecord, 'template' | 'provider' | 'model'> => ({ template: 'relevance', provider, model });
  const nothingSpent = { costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };

  return {
    provider,
    model,
    problem,
    budget,
    maxCallsPerRequest: maxCalls,
    redact,
    notes,
    async judge(q: RelevanceQuestion, scope: JudgeScope = {}): Promise<JudgeRecord> {
      const agent = q.agentModel ? { agentModel: q.agentModel, ...(sameFamily(model, q.agentModel) ? { sameFamily: true } : {}) } : {};
      if (problem !== null || provider === null || !options.apiKey) {
        return { ...base(), ...nothingSpent, ...agent, error: problem ?? 'the judge has no provider or key' };
      }
      const request = scope.request ?? newJudgeRequest();
      if (request.calls >= maxCalls) {
        request.withheld += 1;
        return {
          ...base(),
          ...nothingSpent,
          ...agent,
          withheld: 'request_cap',
          error: `this request already made ${request.calls} relevance judge call${request.calls === 1 ? '' : 's'}, the most one request may make (${MAX_CALLS_PER_REQUEST_VAR}=${maxCalls}), so this evaluation was not sent to the judge`,
        };
      }
      // What leaves the machine: the ask and the answer, with what no_pii flags replaced unless the deployment opted out.
      const sent = redact ? redactForJudge(q.input, q.output) : { input: q.input, output: q.output, replaced: {} };
      const egress = redact ? (Object.keys(sent.replaced).length > 0 ? { redacted: sent.replaced } : {}) : { sentUnredacted: true as const };
      /*
       * The daily budget admits the call's worst case, priced exactly as the
       * per-call cap prices it. A call over the per-call cap is not reserved:
       * the evaluator refuses it before any spend, below.
       */
      const worst = worstCaseJudgeCostUsd({ template: 'relevance', model, input: sent.input, output: sent.output }) ?? maxCost;
      const reservation = worst <= maxCost ? budget.reserve(scope.tenantId ?? LOCAL_TENANT, worst) : null;
      if (reservation !== null && !reservation.ok) {
        return { ...base(), ...nothingSpent, ...agent, withheld: 'daily_budget', error: reservation.reason };
      }
      const ticket = reservation?.ticket ?? null;
      request.calls += 1;
      try {
        const r = await evaluate({
          output: sent.output,
          input: sent.input,
          template: 'relevance',
          provider,
          model,
          apiKey: options.apiKey,
          maxCostUsdPerEval: maxCost,
          ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
          temperature: 0,
        });
        if (ticket) budget.settle(ticket, r.costUsd);
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
          ...egress,
        };
      } catch (err) {
        // A refusal before the call spent nothing; any other failure may have been billed by the provider and is not known here.
        const refused = err instanceof CostCapError;
        if (refused) request.calls -= 1; // refused before any call: it does not count against the request
        if (ticket) {
          if (refused) budget.release(ticket);
          else budget.settle(ticket, null);
        }
        const reason = err instanceof Error ? err.message : String(err);
        return {
          ...base(),
          ...(refused ? nothingSpent : { costUsd: null, inputTokens: 0, outputTokens: 0, latencyMs: 0 }),
          ...agent,
          ...(refused ? {} : egress),
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
export interface RelevanceJudgeEnvOptions extends JudgeBudgetEnvOptions {
  /**
   * The daily budget every judge call in this process draws on: the server
   * passes the one its judge tools use, so the three share one balance.
   * Omitted, one is built from the environment and the other options.
   */
  budget?: JudgeBudget;
}

export function relevanceJudgeFromEnv(options: RelevanceJudgeEnvOptions = {}): RelevanceJudge | null {
  const model = process.env.IRIS_RELEVANCE_JUDGE_MODEL?.trim();
  if (!model) return null;
  const provider = findPricing(model)?.provider;
  const apiKey = provider === 'anthropic' ? process.env.IRIS_ANTHROPIC_API_KEY : provider === 'openai' ? process.env.IRIS_OPENAI_API_KEY : undefined;
  const calls = maxCallsPerRequest();
  const redaction = redactionSetting();
  // A budget passed in is the process's own, and whoever built it says its notes.
  const built = options.budget ? null : judgeBudgetFromEnv(options);
  const budget = options.budget ?? built!.budget;
  return createRelevanceJudge({
    model,
    ...(apiKey ? { apiKey } : {}),
    budget,
    maxCallsPerRequest: calls.value,
    redact: redaction.value === 'on',
    notes: [...(built?.notes ?? []), calls.note, redaction.note].filter((n): n is string => n !== undefined),
  });
}

/**
 * What a process that installs this judge must say out loud when it starts.
 * A judge named by IRIS_RELEVANCE_JUDGE_MODEL that cannot be called (no key
 * for its provider, an unpriced model) fails open: every evaluation falls
 * back to the lexical reading, which advises, so an off-topic answer passes.
 * The deployment set the variable to get a gate, so the server and the CLI
 * print this at startup and the self-test fails on it; each result still
 * says it fell back. A setting that fell back to its default is said too.
 */
export function relevanceJudgeStartupWarnings(judge: RelevanceJudge | null): string[] {
  if (judge === null) return [];
  const lines: string[] = [];
  if (judge.problem !== null) {
    lines.push(
      `Relevance judge is configured but cannot run: ${judge.problem}. answers_the_ask falls back to its lexical reading and only advises, so an off-topic answer passes until this is fixed.`,
    );
  }
  for (const note of judge.notes) lines.push(`Relevance judge: ${note}.`);
  return lines;
}

/** Exactly what leaves the machine, in one sentence every surface repeats. */
export function relevanceJudgeEgress(provider: LLMProvider | null, redact: boolean): string {
  const to = provider === 'anthropic' ? 'Anthropic' : provider === 'openai' ? 'OpenAI' : 'the model provider';
  return (
    `each evaluation that carries an input sends that input and the output to ${to}, on your key, when it is judged` +
    (redact
      ? `, with every span Iris's no_pii rule flags (personal data and credentials) replaced by a [REDACTED:<kind>#<n>] marker first`
      : `, UNREDACTED (${RELEVANCE_JUDGE_REDACT_VAR}=off)`) +
    '; nothing else from the trace is sent'
  );
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
  /** What leaves the machine when the judge is asked; null when no judge is installed. */
  egress: string | null;
  /** PII and credentials are replaced before sending; null when no judge is installed. */
  redact: boolean | null;
  /** Judge calls one request may make; null when no judge is installed. */
  maxCallsPerRequest: number | null;
  /** The daily budget and today's spend for this tenant (UTC); null when no judge is installed. */
  budget: BudgetToday | null;
  /** Configuration values that were unusable and fell back to their defaults. */
  notes: string[];
}

export function relevanceJudgeState(judge: RelevanceJudge | null, tenantId: TenantId = LOCAL_TENANT): RelevanceJudgeState {
  return {
    configured: judge !== null,
    ready: judge !== null && judge.problem === null,
    model: judge?.model ?? null,
    provider: judge?.provider ?? null,
    passThreshold: RELEVANCE_TEMPLATE.passThreshold,
    problem: judge?.problem ?? null,
    egress: judge ? relevanceJudgeEgress(judge.provider, judge.redact) : null,
    redact: judge?.redact ?? null,
    maxCallsPerRequest: judge?.maxCallsPerRequest ?? null,
    budget: judge ? judge.budget.today(tenantId) : null,
    notes: judge?.notes ?? [],
  };
}

/** One line for the self-test and the server instructions. */
export function relevanceJudgeStateLine(state: RelevanceJudgeState): string {
  if (!state.configured) {
    return `not configured (set ${RELEVANCE_JUDGE_MODEL_VAR} to a priced model to have answers_the_ask decide off-topic answers with the judge; until then it reads the ask lexically and advises)`;
  }
  if (!state.ready) return `configured but not callable: ${state.problem}`;
  const b = state.budget;
  const spend = b
    ? `; budget ${b.limitUsd} USD a day per tenant (UTC), ${b.spentUsd.toFixed(4)} spent today${b.exhausted ? `, calls refused until ${b.resetsAt}` : ''}`
    : '';
  const notes = state.notes.length > 0 ? `; ${state.notes.join('; ')}` : '';
  return (
    `on (${state.provider}/${state.model}): answers_the_ask gates on the judge's relevance verdict, one judge call per evaluation that carries an input; ` +
    `${state.egress}${spend}; at most ${state.maxCallsPerRequest} judge calls per request${notes}`
  );
}
