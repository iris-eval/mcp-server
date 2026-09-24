import type { CaseResultRow, DatasetCase, DatasetDetail, DatasetSummary, RunResultRow, RunSummaryRow } from '../storage/sqlite-adapter.js';
import type { Trace, Span } from './trace.js';
import type { EvalResult, QuestionId } from './eval.js';
import type { TenantId } from './tenant.js';
import type { RegressionAlarm } from '../eval/cusum.js';
import type { MigrationState } from '../storage/migrations/index.js';

export interface TraceFilter {
  agent_name?: string;
  framework?: string;
  since?: string;
  until?: string;
  min_score?: number;
  max_score?: number;
  has_errors?: boolean;
  /** The turns of one conversation. */
  session_id?: string;
}

export interface TraceQueryOptions {
  filter?: TraceFilter;
  limit?: number;
  offset?: number;
  sort_by?: 'timestamp' | 'latency_ms' | 'cost_usd';
  sort_order?: 'asc' | 'desc';
}

export interface TraceQueryResult {
  traces: Trace[];
  total: number;
  limit: number;
  offset: number;
}

/*
 * Windows the eval-stats endpoints accept.
 *
 * The doubled values (2d / 14d / 60d / 180d) are not decorative: the Health
 * view derives a prior-period comparison by requesting a DOUBLE-width window
 * and subtracting the current one. That arithmetic was always correct, but
 * the server rejected the doubled window with a 400, so every "vs prior
 * period" delta on the default screen rendered "—" and had never once
 * worked. 90d was likewise offered by the period selector and rejected.
 */
export type EvalStatsPeriod =
  | '24h'
  | '2d'
  | '7d'
  | '14d'
  | '30d'
  | '60d'
  | '90d'
  | '180d'
  | 'all';

export interface EvalStats {
  passRate: number;
  avgScore: number;
  totalEvals: number;
  safetyViolations: { pii: number; injection: number; hallucination: number };
  totalCost: number;
  agentCount: number;
  period: EvalStatsPeriod;
}

export interface EvalStatsTrendBucket {
  timestamp: string;
  avgScore: number;
  passRate: number;
  evalCount: number;
  /**
   * Which cohort this bucket belongs to, when the caller asked for a split.
   * Null in the ungrouped view and for evaluations that belong to no run.
   *
   * A trend line drawn over everything at once hides the thing a reader is
   * usually looking for: two runs whose rates moved in opposite directions
   * average into a flat line. Splitting by run is what makes that visible,
   * and it is the same grouping compare_runs tests — so the picture and the
   * test agree rather than being two different notions of "before".
   */
  cohort?: string | null;
}

/**
 * Two windows of evaluations, counted so a comparison can be TESTED rather
 * than eyeballed.
 *
 * The Drift view has always shown a raw delta: "pass rate down 6 points".
 * With eleven evaluations on one side that sentence is noise wearing the
 * clothes of a finding, and nothing on screen said which it was. These are
 * the four numbers that settle it — both counts, both denominators — and
 * the interval is computed from them by the same `newcombeDifference` the
 * proof harness uses, so the picture and the measurement cannot disagree.
 */
/**
 * What this agent has failed before — the context that makes "first" and
 * "novel" mean anything.
 *
 * Two of the moment classes have been declared since v0.4 and could never
 * fire, because the classifier only ever saw one trace and its own
 * evaluations. Novelty is not a property of a trace; it is a property of a
 * trace against a history, and without the history the honest thing was to
 * let them fall through. This is that history.
 */
/** One evaluated trace of an agent, and the rules that failed in it. */
export interface AgentFailureLogEntry {
  traceId: string;
  timestamp: string;
  /** Sorted, skips excluded — skips are not failures anywhere in this codebase. */
  failed: string[];
  /** The trace's cost, for the agent's own cost baseline; null when the trace recorded none. */
  costUsd: number | null;
  /** Rules that RAN on this evaluation (skips excluded), sorted — the stream watcher's observations. Absent on a hand-built log, which is then not a stream. */
  judged?: string[];
  /** The run the evaluation belongs to, for the run-stratified stream; null when none. */
  runId?: string | null;
}

export interface AgentFailureHistory {
  /** Traces this agent has evaluated before the one under test. The baseline that makes "first" a claim rather than "early". */
  priorTraces: number;
  /** Every rule that has failed for this agent before. */
  rulesEverFailed: string[];
  /** Every combination of simultaneously-failing rules seen before, each a sorted, joined key. */
  combinationsSeen: string[];
  /** The agent's most recent prior costs, newest first, at most COST_ANOMALY_WINDOW; traces without a cost are skipped. The baseline a cost spike is judged against. */
  recentCosts: number[];
  /** The regression alarms the agent's stream raised AT the trace under test: one per (rule) or (run, rule) whose CUSUM crossed its line on this evaluation. */
  regressionAlarms: RegressionAlarm[];
}

/*
 * Labels on the user's own traffic.
 *
 * A label is one reader's judgement that a rule's FIRE on one evaluation
 * was right or wrong. Labels on fires measure precision only — nothing here
 * says what a quiet rule missed — so every surface says "local precision"
 * and never "local accuracy". At LOCAL_LABEL_MIN labels (src/eval/labels.ts)
 * a rule's number on this deployment becomes the deployment's own.
 */
export type VerdictLabelValue = 'right' | 'wrong';

export interface VerdictLabel {
  id: string;
  evalId: string;
  /** The rule whose fire was labelled. Nullable in the schema for a later whole-verdict label; every label written today names a rule. */
  ruleName: string | null;
  label: VerdictLabelValue;
  note: string | null;
  labelledAt: string;
}

/** Right and wrong counts per rule over every label the tenant has written. */
export interface LabelTallyRow {
  ruleName: string;
  right: number;
  wrong: number;
}

/** How often a rule fired over the most recent evaluations — the fire rate the prior estimate reads. */
export interface RuleFireStat {
  ruleName: string;
  /** Evaluations in the window on which the rule RAN (skips excluded). */
  judged: number;
  /** Of those, the evaluations on which it fired. */
  fired: number;
}

/** Fires grouped by (rule, evidence signature): ten fires of one pattern are one issue with a count. */
export interface IssueGroup {
  key: string;
  ruleName: string;
  signature: string;
  count: number;
  /** Distinct agents whose traces carry the fire. */
  agents: string[];
  firstSeen: string;
  lastSeen: string;
  /** A handful of evaluation ids a reader can open, newest first. */
  exampleEvalIds: string[];
  /** The traces those evaluations scored, in the same order (null for an evaluation made from bare text) — the dashboard links to the trace page. */
  exampleTraceIds: Array<string | null>;
  /** Labels already written on fires in this group. */
  labelled: { right: number; wrong: number };
}

export interface DriftWindow {
  since: string;
  until: string | null;
  evaluated: number;
  passed: number;
  /** Null when the window is empty — a rate of "0 of 0" is not zero, it is unknown. */
  passRate: number | null;
}

/** How to split a trend. Only 'run' today; the shape leaves room without inviting a free-text group-by. */
export type TrendCohort = 'run';

export interface EvalStatsRuleBreakdown {
  rule: string;
  passRate: number;
  totalRun: number;
  failCount: number;
}

export interface EvalStatsFailure {
  traceId: string;
  agent: string;
  rule: string;
  score: number;
  output: string;
  timestamp: string;
}

/** One agent's spend over a window — traces, how many carried a cost, and the total, mean and largest. */
export interface AgentCostRow {
  agent: string;
  traces: number;
  costedTraces: number;
  totalCostUsd: number;
  /** Null when no trace carried a cost. */
  avgCostUsd: number | null;
  maxCostUsd: number | null;
}

export interface DashboardSummary {
  total_traces: number;
  avg_latency_ms: number;
  total_cost_usd: number;
  error_rate: number;
  eval_pass_rate: number;
  traces_per_hour: Array<{ hour: string; count: number }>;
  top_agents: Array<{ agent_name: string; count: number }>;
}

/*
 * IStorageAdapter — tenant-aware contract.
 *
 * Every read and write REQUIRES a TenantId. No method accepts `string`
 * for tenant — only the branded TenantId type, which is only mintable
 * via `asTenantId()` or the `LOCAL_TENANT` constant (see
 * src/types/tenant.ts). This makes unscoped storage access a compile
 * error, not a runtime leak.
 *
 * Implementations MUST:
 *   1. Validate non-empty tenantId at method entry (throw
 *      TenantContextRequiredError if empty).
 *   2. Filter every SELECT by tenant_id.
 *   3. Bind tenant_id in every INSERT.
 *   4. Never return cross-tenant data, even when the tenantId comes
 *      from an implementation bug upstream — default-deny at the SQL
 *      layer via composite indexes with tenant_id first.
 *
 * initialize() + close() are lifecycle methods on the adapter itself,
 * not per-tenant — they don't take a TenantId.
 */
export interface IStorageAdapter {
  /** The driver word the health contract reports. */
  readonly driver: string;
  initialize(): Promise<void>;
  close(): Promise<void>;
  /** Applied migrations against the ones this build knows; the health contract's `checks.migrations`. */
  migrations(): Promise<MigrationState>;
  insertTrace(tenantId: TenantId, trace: Trace): Promise<void>;
  /**
   * Store several traces in ONE transaction: all of them or none. The OTLP
   * door ingests a batch this way, so a bad span mid-batch cannot leave
   * half a request stored, and ten thousand traces commit once instead of
   * ten thousand times (2026-09-23 security review).
   */
  insertTraces(tenantId: TenantId, traces: Trace[]): Promise<void>;
  getTrace(tenantId: TenantId, traceId: string): Promise<Trace | null>;
  /** Merge `patch` into a stored trace's metadata. False when no such trace. */
  updateTraceMetadata(tenantId: TenantId, traceId: string, patch: Record<string, unknown>): Promise<boolean>;
  queryTraces(tenantId: TenantId, options: TraceQueryOptions): Promise<TraceQueryResult>;
  insertSpan(tenantId: TenantId, span: Span): Promise<void>;
  getSpansByTraceId(tenantId: TenantId, traceId: string): Promise<Span[]>;
  insertEvalResult(tenantId: TenantId, result: EvalResult): Promise<void>;
  /**
   * Called after an evaluation row is durable, whichever door wrote it
   * — the webhook's seam. Returns the unsubscribe. A listener
   * that throws never fails the write.
   */
  onEvalResultInserted(listener: (tenantId: TenantId, result: EvalResult) => void): () => void;
  getEvalsByTraceId(tenantId: TenantId, traceId: string): Promise<EvalResult[]>;
  /**
   * The evaluations of many traces in one read, newest first per trace; a
   * trace with none is absent from the map. What a page of moments needs —
   * one query for the page, not one per trace.
   */
  getEvalsByTraceIds(tenantId: TenantId, traceIds: readonly string[]): Promise<Map<string, EvalResult[]>>;
  /** One stored evaluation by id, in the same derived-on-read shape as every other reader; null when absent. */
  getEvalById(tenantId: TenantId, id: string): Promise<EvalResult | null>;
  /** Every evaluation in a run, one per trace, newest first — what a comparison counts. */
  /** Register a run's label, or the fact that it re-evaluated another. Everything else about a run is derived. */
  upsertRun(tenantId: TenantId, run: { runId: string; label?: string | null; agentName?: string | null; reevaluationOf?: string | null }): Promise<void>;
  /** Every run, newest first — registered ones and ones that exist only because a trace carried the id. */
  listRuns(tenantId: TenantId, limit?: number): Promise<RunSummaryRow[]>;
  /** One run, or null when nothing mentions it. */
  getRun(tenantId: TenantId, runId: string): Promise<RunSummaryRow | null>;
  /** Pin a run as the tenant's baseline (unpinning any other), or unpin it. A run known only through its traces gets its row. */
  setRunBaseline(tenantId: TenantId, runId: string, baseline: boolean): Promise<void>;
  /** The pinned baseline's run id, or null. */
  getBaselineRun(tenantId: TenantId): Promise<string | null>;
  /** Each trace in a run and whether its latest evaluation already came from the given ruleset. */
  getRunTraceEvaluationState(tenantId: TenantId, runId: string, rulesetHash: string): Promise<Array<{ traceId: string; evaluatedUnderRuleset: boolean }>>;
  getRunResults(tenantId: TenantId, runId: string): Promise<RunResultRow[]>;
  /** Every attempt at every case, optionally narrowed — repeats kept, because they are the measurement. */
  /**
   * Every attempt at every case. With `question`, only the
   * evaluations that JUDGED that question, and `passed` becomes the
   * question's own answer — every rule answering it passed — rather than
   * the composed verdict, so a case's rate can be read for one question.
   */
  getCaseResults(tenantId: TenantId, filter?: { run?: string; caseKey?: string; question?: QuestionId; session?: string; groupBy?: 'case_key' | 'session' }): Promise<CaseResultRow[]>;
  /** Datasets: a named set of case keys a comparison and a gate can be restricted to. */
  createDataset(tenantId: TenantId, input: { label: string; cases: DatasetCase[] }): Promise<DatasetDetail>;
  /** By id, else by label; null when neither matches. */
  getDataset(tenantId: TenantId, idOrLabel: string): Promise<DatasetDetail | null>;
  listDatasets(tenantId: TenantId): Promise<DatasetSummary[]>;
  /** The distinct case keys the traces of one run carry — what `POST /api/v1/datasets` promotes. */
  caseKeysInRun(tenantId: TenantId, runId: string): Promise<string[]>;
  /** Cost per agent since `since` (null = all time), most expensive first. */
  costByAgent(tenantId: TenantId, since: string | null, limit: number): Promise<AgentCostRow[]>;
  queryEvalResults(
    tenantId: TenantId,
    options: {
      eval_type?: string;
      passed?: boolean;
      since?: string;
      until?: string;
      limit?: number;
      offset?: number;
    },
  ): Promise<{ results: EvalResult[]; total: number }>;
  getDashboardSummary(tenantId: TenantId, sinceHours?: number): Promise<DashboardSummary>;
  deleteTracesOlderThan(tenantId: TenantId, days: number): Promise<number>;
  /**
   * Retention twin of deleteTracesOlderThan for eval_results (#372).
   * Deleting a trace only NULLs the trace_id on its evaluations (FK ON
   * DELETE SET NULL), so every eval row — output_text verbatim, including
   * whatever no_pii flagged — outlived the retention window until this
   * existed. Cutoff is on created_at.
   */
  deleteEvalResultsOlderThan(tenantId: TenantId, days: number): Promise<number>;
  /**
   * Delete EVERY trace, span and eval result for the tenant, then compact
   * the database so the deleted text does not linger in free pages or in
   * the write-ahead log. Returns what was removed. Deployed rules, the
   * audit log and preferences are not storage rows and are untouched.
   */
  purge(tenantId: TenantId): Promise<{ traces: number; evalResults: number }>;
  /**
   * Fold the write-ahead log into the main file and truncate it
   * (wal_checkpoint TRUNCATE). Best-effort; called after a retention sweep
   * so rows deleted at startup do not survive as readable text in
   * iris.db-wal.
   */
  checkpoint(): Promise<void>;
  /**
   * Delete a single trace by id. Cascades to spans via FK ON DELETE
   * CASCADE; eval_results get their trace_id set to NULL (so score
   * history survives even after the trace is deleted).
   *
   * Returns true if a row was deleted, false if the id didn't exist
   * (or belonged to a different tenant).
   */
  deleteTrace(tenantId: TenantId, traceId: string): Promise<boolean>;
  getDistinctValues(tenantId: TenantId, column: string): Promise<string[]>;
  getEvalStats(tenantId: TenantId, period: EvalStatsPeriod): Promise<EvalStats>;
  getEvalStatsTrend(tenantId: TenantId, period: EvalStatsPeriod, cohortBy?: TrendCohort): Promise<EvalStatsTrendBucket[]>;
  /** Pass counts for one window of evaluations, optionally narrowed to a run. */
  getDriftWindow(tenantId: TenantId, since: string, until: string | null, run?: string): Promise<DriftWindow>;
  /** This agent's recent evaluated traces and what failed in each — read once per agent, then filtered per trace in memory. */
  getAgentFailureLog(tenantId: TenantId, agentName: string, limit?: number): Promise<AgentFailureLogEntry[]>;
  getEvalStatsRules(tenantId: TenantId, period: EvalStatsPeriod): Promise<EvalStatsRuleBreakdown[]>;
  getEvalStatsFailures(tenantId: TenantId, period: EvalStatsPeriod, limit: number): Promise<EvalStatsFailure[]>;
  /** Write one label on a rule's fire. Labelling the same fire again REPLACES the earlier label — a reader changed their mind, and two opinions on one fire would count twice. */
  insertVerdictLabel(tenantId: TenantId, label: Omit<VerdictLabel, 'labelledAt'> & { labelledAt?: string }): Promise<VerdictLabel>;
  /** Every label on one evaluation. */
  getLabelsForEval(tenantId: TenantId, evalId: string): Promise<VerdictLabel[]>;
  /** Right and wrong counts per rule over every label the tenant has written. */
  labelTallies(tenantId: TenantId): Promise<LabelTallyRow[]>;
  /** Per rule, how many of the newest `window` evaluations it ran on and fired on — the fire rate the prior estimate reads. */
  ruleFireStats(tenantId: TenantId, window: number): Promise<RuleFireStat[]>;
  /** Fires over the newest `window` evaluations grouped by (rule, evidence signature), largest group first. */
  listIssues(tenantId: TenantId, window: number, options?: { rule?: string; limit?: number }): Promise<IssueGroup[]>;
}
