import type { Trace, Span } from './trace.js';
import type { EvalResult } from './eval.js';
import type { TenantId } from './tenant.js';

export interface TraceFilter {
  agent_name?: string;
  framework?: string;
  since?: string;
  until?: string;
  min_score?: number;
  max_score?: number;
  has_errors?: boolean;
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
}

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
  initialize(): Promise<void>;
  close(): Promise<void>;
  insertTrace(tenantId: TenantId, trace: Trace): Promise<void>;
  getTrace(tenantId: TenantId, traceId: string): Promise<Trace | null>;
  queryTraces(tenantId: TenantId, options: TraceQueryOptions): Promise<TraceQueryResult>;
  insertSpan(tenantId: TenantId, span: Span): Promise<void>;
  getSpansByTraceId(tenantId: TenantId, traceId: string): Promise<Span[]>;
  insertEvalResult(tenantId: TenantId, result: EvalResult): Promise<void>;
  getEvalsByTraceId(tenantId: TenantId, traceId: string): Promise<EvalResult[]>;
  /** One stored evaluation by id, in the same derived-on-read shape as every other reader; null when absent. */
  getEvalById(tenantId: TenantId, id: string): Promise<EvalResult | null>;
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
  getEvalStatsTrend(tenantId: TenantId, period: EvalStatsPeriod): Promise<EvalStatsTrendBucket[]>;
  getEvalStatsRules(tenantId: TenantId, period: EvalStatsPeriod): Promise<EvalStatsRuleBreakdown[]>;
  getEvalStatsFailures(tenantId: TenantId, period: EvalStatsPeriod, limit: number): Promise<EvalStatsFailure[]>;
}
