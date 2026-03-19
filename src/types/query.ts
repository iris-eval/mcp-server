import type { Trace, Span } from './trace.js';
import type { EvalResult } from './eval.js';

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

export type EvalStatsPeriod = '24h' | '7d' | '30d';

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

export interface IStorageAdapter {
  initialize(): Promise<void>;
  close(): Promise<void>;
  insertTrace(trace: Trace): Promise<void>;
  getTrace(traceId: string): Promise<Trace | null>;
  queryTraces(options: TraceQueryOptions): Promise<TraceQueryResult>;
  insertSpan(span: Span): Promise<void>;
  getSpansByTraceId(traceId: string): Promise<Span[]>;
  insertEvalResult(result: EvalResult): Promise<void>;
  getEvalsByTraceId(traceId: string): Promise<EvalResult[]>;
  queryEvalResults(options: {
    eval_type?: string;
    passed?: boolean;
    since?: string;
    until?: string;
    limit?: number;
    offset?: number;
  }): Promise<{ results: EvalResult[]; total: number }>;
  getDashboardSummary(sinceHours?: number): Promise<DashboardSummary>;
  deleteTracesOlderThan(days: number): Promise<number>;
  getDistinctValues(column: string): Promise<string[]>;
  getEvalStats(period: EvalStatsPeriod): Promise<EvalStats>;
  getEvalStatsTrend(period: EvalStatsPeriod): Promise<EvalStatsTrendBucket[]>;
  getEvalStatsRules(period: EvalStatsPeriod): Promise<EvalStatsRuleBreakdown[]>;
  getEvalStatsFailures(period: EvalStatsPeriod, limit: number): Promise<EvalStatsFailure[]>;
}
