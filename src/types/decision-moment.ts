/*
 * Decision Moment — the new primary unit of the Iris dashboard.
 *
 * A Decision Moment is the point at which an agent's output was scored.
 * It is derived from existing data: one trace + its aggregated eval results.
 * No schema migration — the moment is computed on read.
 *
 * The system-design reframe: not every eval is a moment. The significance
 * classifier separates moments worth a human's attention (safety violations,
 * cost spikes, first-failures, novel patterns) from operational data
 * (passing evals on the happy path).
 *
 * This is the workflow primitive that supports Make-This-A-Rule: a user
 * looking at a moment can promote the observed behavior into a new rule
 * without leaving the moment context.
 */

export type MomentVerdict = 'pass' | 'fail' | 'partial' | 'unevaluated';

export type MomentSignificanceKind =
  | 'safety-violation'   // any safety rule failed — highest priority
  | 'cost-spike'         // trace cost exceeds threshold or deviates from agent baseline
  | 'first-failure'      // this rule failure first observed for this agent
  | 'novel-pattern'      // failure-rule combination not seen before for this agent
  | 'rule-collision'     // multiple eval_types failed simultaneously
  | 'normal-pass'        // happy path; not a moment worth dedicated attention
  | 'normal-fail';       // a fail that doesn't elevate to one of the above

export interface MomentSignificance {
  /** Classifier kind. */
  kind: MomentSignificanceKind;
  /** 0-1; how moment-worthy this trace is. Used for visual emphasis on the timeline. */
  score: number;
  /** Short human-readable label (≤30 chars) — shown on timeline dot tooltip. */
  label: string;
  /** Longer explanation — shown in the detail surface. */
  reason: string;
}

export interface MomentRuleSnapshot {
  /** Names of rules that failed. */
  failed: string[];
  /** Names of rules that were skipped (insufficient context). */
  skipped: string[];
  /** Count of rules that passed. */
  passedCount: number;
  /** Count of rules that fired total (across all eval_types). */
  totalCount: number;
}

export interface DecisionMoment {
  /** Stable id; equals the source trace_id. */
  id: string;
  /** Source trace_id (same as id; included for query convenience). */
  traceId: string;
  /** Agent that produced the output. */
  agentName: string;
  /** ISO timestamp of the trace. */
  timestamp: string;
  /** Input the agent received (may be omitted for storage-size reasons). */
  input?: string;
  /** Output the agent produced. */
  output?: string;
  /** Trace-level cost in USD. */
  costUsd?: number;
  /** Trace-level end-to-end latency. */
  latencyMs?: number;
  /** Aggregated eval verdict across all eval_types that ran on this trace. */
  verdict: MomentVerdict;
  /** Weighted average score across all eval rules that fired (excludes skipped). */
  overallScore: number;
  /** Count of distinct evaluations (one per eval_type) recorded for this trace. */
  evalCount: number;
  /** Per-rule pass/fail/skip breakdown. */
  ruleSnapshot: MomentRuleSnapshot;
  /** Why this trace is (or isn't) moment-worthy. */
  significance: MomentSignificance;
}

/**
 * Detailed view returned by the moment-detail endpoint. Includes the full
 * eval result list (with messages + scores per rule) and the source trace
 * for context.
 */
export interface DecisionMomentDetail extends DecisionMoment {
  /** Every eval recorded for this trace, with full rule result detail. */
  evals: Array<{
    id: string;
    evalType: string;
    score: number;
    passed: boolean;
    ruleResults: Array<{
      ruleName: string;
      passed: boolean;
      score: number;
      message: string;
      skipped?: boolean;
      skipReason?: string;
    }>;
    suggestions: string[];
    createdAt?: string;
  }>;
  /** Full input (uncompressed). */
  input?: string;
  /** Full output (uncompressed). */
  output?: string;
  /** Tool-call sequence from the trace, if any. */
  toolCalls?: Array<{
    tool_name: string;
    input?: unknown;
    output?: unknown;
    latency_ms?: number;
    error?: string;
  }>;
  /** Span tree from the trace, if any. */
  spans?: Array<{
    span_id: string;
    parent_span_id?: string;
    name: string;
    kind: string;
    start_time: string;
    end_time?: string;
  }>;
}

export interface MomentQueryFilter {
  /** Filter by agent name. */
  agentName?: string;
  /** Filter by verdict. */
  verdict?: MomentVerdict;
  /** Filter to only show moments above a significance threshold. */
  minSignificance?: number;
  /** Filter by significance kind (e.g., only show safety-violations). */
  significanceKind?: MomentSignificanceKind;
  /** ISO timestamp; only moments at or after. */
  since?: string;
  /** ISO timestamp; only moments at or before. */
  until?: string;
}

export interface MomentQueryOptions {
  filter?: MomentQueryFilter;
  limit?: number;
  offset?: number;
  /** Default 'desc' (most recent first). */
  sortOrder?: 'asc' | 'desc';
}

export interface MomentQueryResult {
  moments: DecisionMoment[];
  total: number;
  limit: number;
  offset: number;
}
