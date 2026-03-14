export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ToolCallRecord {
  tool_name: string;
  input?: unknown;
  output?: unknown;
  latency_ms?: number;
  error?: string;
}

export interface Span {
  span_id: string;
  trace_id: string;
  parent_span_id?: string;
  name: string;
  kind: string;
  status_code: string;
  status_message?: string;
  start_time: string;
  end_time?: string;
  attributes?: Record<string, unknown>;
  events?: Array<{ name: string; timestamp: string; attributes?: Record<string, unknown> }>;
}

export interface Trace {
  trace_id: string;
  agent_name: string;
  framework?: string;
  input?: string;
  output?: string;
  tool_calls?: ToolCallRecord[];
  latency_ms?: number;
  token_usage?: TokenUsage;
  cost_usd?: number;
  metadata?: Record<string, unknown>;
  timestamp: string;
  created_at?: string;
}

export interface EvalRuleResult {
  ruleName: string;
  passed: boolean;
  score: number;
  message: string;
}

export interface EvalResult {
  id: string;
  trace_id?: string;
  eval_type: string;
  output_text: string;
  expected_text?: string;
  score: number;
  passed: boolean;
  rule_results: EvalRuleResult[];
  suggestions: string[];
  created_at?: string;
}

export interface TraceQueryResult {
  traces: Trace[];
  total: number;
  limit: number;
  offset: number;
}

export interface TraceDetail {
  trace: Trace;
  spans: Span[];
  evals: EvalResult[];
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

export interface FilterOptions {
  agent_names: string[];
  frameworks: string[];
}

export interface EvalQueryResult {
  results: EvalResult[];
  total: number;
}
