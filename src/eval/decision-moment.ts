/*
 * decision-moment — derive Decision Moments from trace + eval data.
 *
 * A Decision Moment aggregates one trace and all eval results recorded for
 * it. The significance classifier runs over the aggregated view to decide
 * whether this trace is moment-worthy (safety violation, cost spike, etc.)
 * or normal operational data.
 *
 * The classifier is rules-based and deterministic — no learned baselines.
 * "first-failure" and "novel-pattern" need context a single trace cannot
 * carry, because novelty is a property of a trace AGAINST A HISTORY. From
 * 0.12.0 that history is supplied by the caller (storage.getAgentFailureHistory)
 * and the two classes fire. Omit it and they fall through exactly as before,
 * which is what keeps every existing caller of deriveMoment correct.
 */

import type { Trace } from '../types/trace.js';
import type { AgentFailureHistory, AgentFailureLogEntry } from '../types/query.js';
import type { EvalResult } from '../types/eval.js';
import type {
  DecisionMoment,
  DecisionMomentDetail,
  MomentVerdict,
  MomentSignificance,
  MomentRuleSnapshot,
} from '../types/decision-moment.js';
import { safetyRules } from './rules/safety.js';

/* Cost-spike threshold in USD per single trace. Crossing this triggers
 * cost-spike classification regardless of agent baseline. The bound was
 * picked to flag any single trace that costs more than a typical
 * developer-tier monthly budget would absorb at scale (1000 traces/day). */
const COST_SPIKE_USD_THRESHOLD = 0.10;

/* Rule names that, if failed, escalate the moment to safety-violation
 * regardless of the rest of the verdict. Derived from the safety bundle
 * itself so the two cannot drift: this used to be a hand-copied list of
 * v0.3.1's four names, and when v0.5.0 moved no_hallucination_markers into
 * the safety bundle the classifier kept ranking a fabricated citation as a
 * plain fail (significance 0.5 instead of 1.0) on the failure-first
 * landing page. Any rule added to `safetyRules` now classifies correctly
 * without a second edit here. */
const SAFETY_RULE_NAMES = new Set(safetyRules.map((rule) => rule.name));

/**
 * The smallest history that makes "first" mean more than "early".
 *
 * On a brand-new agent every failure is the first of its kind, so without
 * this guard the novelty classes would outrank real safety findings for the
 * whole of a user's first afternoon — and the one time they most need the
 * ranking to be about severity is the first afternoon. Below the floor both
 * classes stay silent and the trace is ranked on what it actually did.
 */
const MIN_HISTORY_TRACES_FOR_NOVELTY = 5;

/**
 * What this agent had failed BEFORE a given trace, from its log.
 *
 * Pure, so the novelty classes are testable without a database, and so the
 * moments list can read one log per agent and ask it two hundred times.
 *
 * "Before" is by the trace's own timestamp, never by insertion order: a
 * backfilled or re-read old trace must not make every later failure look
 * novel. A tie in timestamp is excluded by trace id, so a trace is never
 * part of its own history.
 */
export function historyBefore(log: readonly AgentFailureLogEntry[], traceId: string, timestamp: string): AgentFailureHistory {
  const rulesEverFailed = new Set<string>();
  const combinationsSeen = new Set<string>();
  let priorTraces = 0;
  for (const entry of log) {
    if (entry.traceId === traceId) continue;
    if (entry.timestamp >= timestamp) continue;
    priorTraces += 1;
    for (const name of entry.failed) rulesEverFailed.add(name);
    if (entry.failed.length > 0) combinationsSeen.add(entry.failed.join('+'));
  }
  return {
    priorTraces,
    rulesEverFailed: [...rulesEverFailed].sort(),
    combinationsSeen: [...combinationsSeen].sort(),
  };
}

export function deriveMoment(trace: Trace, evals: EvalResult[], history?: AgentFailureHistory): DecisionMoment {
  const ruleSnapshot = computeRuleSnapshot(evals);
  const verdict = computeVerdict(evals, ruleSnapshot);
  const overallScore = computeOverallScore(evals);
  const significance = classifySignificance({
    trace,
    evals,
    ruleSnapshot,
    verdict,
    history,
  });

  return {
    id: trace.trace_id,
    traceId: trace.trace_id,
    agentName: trace.agent_name,
    timestamp: trace.timestamp,
    input: trace.input,
    output: trace.output,
    costUsd: trace.cost_usd,
    latencyMs: trace.latency_ms,
    verdict,
    overallScore,
    evalCount: evals.length,
    ruleSnapshot,
    significance,
  };
}

export function deriveMomentDetail(
  trace: Trace,
  evals: EvalResult[],
  spans?: Array<{
    span_id: string;
    parent_span_id?: string;
    name: string;
    kind: string;
    start_time: string;
    end_time?: string;
  }>,
  history?: AgentFailureHistory,
): DecisionMomentDetail {
  const moment = deriveMoment(trace, evals, history);
  return {
    ...moment,
    evals: evals.map((e) => ({
      id: e.id,
      evalType: e.eval_type,
      score: e.score,
      passed: e.passed,
      // Whole, not remapped: the stamp on every rule result is what the
      // dashboard exists to show (D-0).
      ruleResults: e.rule_results,
      ...(e.verdict ? { verdict: e.verdict } : {}),
      ...(e.coverage ? { coverage: e.coverage } : {}),
      ...(e.interpretations?.length ? { interpretations: e.interpretations } : {}),
      ...(e.provenance ? { provenance: e.provenance } : {}),
      ...(e.critical_skipped?.length ? { criticalSkipped: e.critical_skipped } : {}),
      suggestions: e.suggestions ?? [],
      /*
       * Carried through so the moment detail can say WHY an eval failed.
       * Without it the UI renders "safety · fail  score 0.92" with no way to
       * tell a critical-rule veto from a merely-low weighted score — the
       * release's flagship behaviour, invisible on every dashboard surface.
       */
      criticalFailures: e.critical_failures,
      createdAt: e.created_at,
    })),
    toolCalls: trace.tool_calls,
    spans,
  };
}

function computeRuleSnapshot(evals: EvalResult[]): MomentRuleSnapshot {
  const failed: string[] = [];
  const skipped: string[] = [];
  let passedCount = 0;
  let totalCount = 0;

  for (const e of evals) {
    for (const r of e.rule_results) {
      totalCount++;
      if (r.skipped) {
        skipped.push(r.ruleName);
      } else if (r.passed) {
        passedCount++;
      } else {
        failed.push(r.ruleName);
      }
    }
  }

  return { failed, skipped, passedCount, totalCount };
}

/*
 * The moment SHOWS the verdict each evaluation reached; it does not compute
 * a second one.
 *
 * It used to count failed rules: no failures meant pass, no passes meant
 * fail, anything else meant partial. From 0.10.0 those two answers diverge,
 * and the divergence is the whole point of the composer. An evaluation can
 * pass with a rule visibly failed — a shipped default that only advises, or
 * evidence too weak to carry the risk past the deployment's loss threshold
 * — and the old arithmetic would have called that "partial", contradicting
 * the verdict the tool returned for the same evaluation.
 *
 * "partial" now means what it says: several evaluations of one trace and
 * they did not agree. An `unknown` verdict reads as unevaluated, because
 * that is what it is — asked, and unable to answer.
 */
function computeVerdict(evals: EvalResult[], snapshot: MomentRuleSnapshot): MomentVerdict {
  if (evals.length === 0) return 'unevaluated';
  if (snapshot.totalCount - snapshot.skipped.length === 0) return 'unevaluated';
  const decided = evals.filter((e) => e.verdict === undefined || e.verdict.state !== 'unknown');
  if (decided.length === 0) return 'unevaluated';
  const passed = decided.filter((e) => e.passed).length;
  if (passed === decided.length) return 'pass';
  if (passed === 0) return 'fail';
  return 'partial';
}

function computeOverallScore(evals: EvalResult[]): number {
  if (evals.length === 0) return 0;
  const sum = evals.reduce((a, e) => a + e.score, 0);
  return sum / evals.length;
}

interface SignificanceInput {
  trace: Trace;
  evals: EvalResult[];
  ruleSnapshot: MomentRuleSnapshot;
  verdict: MomentVerdict;
  /** Absent for a caller with no history to offer; the two novelty classes then stay silent. */
  history?: AgentFailureHistory;
}

function classifySignificance({
  trace,
  evals,
  ruleSnapshot,
  verdict,
  history,
}: SignificanceInput): MomentSignificance {
  /*
   * 1. Safety violation — a rule that VETOES failed, or a safety-bundle rule
   * did. Bundle membership alone was the old test, and it is the weaker
   * one: from 0.10.0 which rules veto is the deployment's call
   * (eval.criticalRules), so a rule promoted to critical outside the safety
   * bundle is exactly as serious and used to rank as a plain failure. The
   * bundle list stays as well, because a safety rule that a deployment
   * DEMOTED still describes what it found.
   */
  const vetoed = new Set(
    evals.flatMap((e) => e.rule_results.filter((r) => !r.skipped && r.passed === false && r.role === 'veto').map((r) => r.ruleName)),
  );
  const safetyFailed = ruleSnapshot.failed.filter((name) => SAFETY_RULE_NAMES.has(name) || vetoed.has(name));
  if (safetyFailed.length > 0) {
    return {
      kind: 'safety-violation',
      score: 1.0,
      label: `Safety: ${safetyFailed.join(', ')}`,
      reason: `${safetyFailed.length} safety rule(s) failed: ${safetyFailed.join(', ')}. Output may contain PII, prompt injection compliance, blocklisted content, stub markers, or fabricated/contradicted claims — review before this pattern becomes load-bearing.`,
    };
  }

  // 2. Cost spike — trace cost over absolute threshold.
  if (trace.cost_usd !== undefined && trace.cost_usd >= COST_SPIKE_USD_THRESHOLD) {
    return {
      kind: 'cost-spike',
      score: 0.9,
      label: `Cost: $${trace.cost_usd.toFixed(4)}`,
      reason: `Trace cost ($${trace.cost_usd.toFixed(4)}) crossed the $${COST_SPIKE_USD_THRESHOLD} per-trace threshold. Investigate prompt size, token efficiency, or model-tier choice.`,
    };
  }

  /*
   * 3. First failure — a rule that has never failed for this agent before.
   *
   * Ranked above rule-collision, and the reason is what a reader does with
   * each: a multi-category failure seen every day is routine, while a rule
   * failing for the first time in five hundred traces is the thing to look
   * at today. Severity still wins — safety and cost are above this — but
   * among ordinary failures, novelty is the more useful sort order.
   *
   * Requires a history and a floor: see MIN_HISTORY_TRACES_FOR_NOVELTY.
   */
  if (history !== undefined && history.priorTraces >= MIN_HISTORY_TRACES_FOR_NOVELTY && ruleSnapshot.failed.length > 0) {
    const known = new Set(history.rulesEverFailed);
    const firstTime = ruleSnapshot.failed.filter((name) => !known.has(name));
    if (firstTime.length > 0) {
      return {
        kind: 'first-failure',
        score: 0.8,
        label: `First failure: ${firstTime.join(', ')}`,
        reason: `${firstTime.join(', ')} failed for the first time on this agent across its last ${history.priorTraces} evaluated traces. A rule that has never fired before is a change in behaviour, not a known weakness.`,
      };
    }

    /*
     * 4. Novel pattern — every rule has failed before, but never TOGETHER.
     *
     * Deliberately checked second and defined as the leftover: a first
     * failure is necessarily also a new combination, so testing this first
     * would swallow the stronger signal and report the weaker one.
     */
    const combination = [...ruleSnapshot.failed].sort().join('+');
    if (combination.length > 0 && !new Set(history.combinationsSeen).has(combination)) {
      return {
        kind: 'novel-pattern',
        score: 0.75,
        label: `New combination: ${ruleSnapshot.failed.join(' + ')}`,
        reason: `Each of ${ruleSnapshot.failed.join(', ')} has failed before on this agent, but never in the same trace. A combination that has not occurred before is worth reading even when each half is familiar.`,
      };
    }
  }

  // 3. Rule collision — failures spanning multiple eval_types simultaneously.
  if (ruleSnapshot.failed.length > 0) {
    const failedEvalTypes = new Set(
      evals.filter((e) => !e.passed).map((e) => e.eval_type),
    );
    if (failedEvalTypes.size >= 2) {
      return {
        kind: 'rule-collision',
        score: 0.7,
        label: `Multi-category fail (${failedEvalTypes.size})`,
        reason: `Failures across ${failedEvalTypes.size} eval categories: ${[...failedEvalTypes].join(', ')}. Failed rules: ${ruleSnapshot.failed.join(', ')}.`,
      };
    }
  }

  // 4. Generic fail.
  if (verdict === 'fail') {
    return {
      kind: 'normal-fail',
      score: 0.5,
      label: `Fail: ${ruleSnapshot.failed.join(', ')}`,
      reason: `Eval verdict fail. Failed rules: ${ruleSnapshot.failed.join(', ')}.`,
    };
  }
  if (verdict === 'partial') {
    return {
      kind: 'normal-fail',
      score: 0.4,
      label: `Partial: ${ruleSnapshot.failed.length} failed`,
      reason: `Partial fail — ${ruleSnapshot.failed.length} of ${ruleSnapshot.totalCount - ruleSnapshot.skipped.length} fired rules failed: ${ruleSnapshot.failed.join(', ')}.`,
    };
  }

  // 5. Nothing was judged: its own kind, never a pass (D-0).
  if (verdict === 'unevaluated') {
    return {
      kind: 'unevaluated',
      score: 0.1,
      label: 'No verdict',
      reason:
        evals.length === 0
          ? 'No evaluation was recorded for this trace: nothing here was judged.'
          : 'An evaluation was recorded but reached no verdict: every rule skipped, or a critical rule could not judge. Unknown, not clean.',
    };
  }

  // 6. Happy path — clean pass.
  return {
    kind: 'normal-pass',
    score: 0.05,
    label: 'Pass',
    reason: `All ${ruleSnapshot.passedCount} fired rules passed.`,
  };
}
