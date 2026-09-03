export type {
  SpanKind,
  SpanStatus,
  SpanEvent,
  ToolCallRecord,
  TokenUsage,
  Span,
  Trace,
} from './trace.js';

export type {
  EvalType,
  EvalResultType,
  EvalRule,
  EvalContext,
  EvalRuleResult,
  EvalResult,
  EvalCategoryResult,
  CustomRuleType,
  CustomRuleDefinition,
} from './eval.js';

export type {
  TraceFilter,
  TraceQueryOptions,
  TraceQueryResult,
  DashboardSummary,
  EvalStatsPeriod,
  EvalStats,
  EvalStatsTrendBucket,
  EvalStatsRuleBreakdown,
  EvalStatsFailure,
  IStorageAdapter,
} from './query.js';

export type { IrisConfig } from './config.js';

export type { TenantId } from './tenant.js';
export { LOCAL_TENANT, asTenantId, TenantContextRequiredError } from './tenant.js';
