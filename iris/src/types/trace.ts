export type SpanKind = 'INTERNAL' | 'SERVER' | 'CLIENT' | 'PRODUCER' | 'CONSUMER' | 'LLM' | 'TOOL';

export type SpanStatus = 'UNSET' | 'OK' | 'ERROR';

export interface SpanEvent {
  name: string;
  timestamp: string;
  attributes?: Record<string, unknown>;
}

export interface ToolCallRecord {
  tool_name: string;
  input?: unknown;
  output?: unknown;
  latency_ms?: number;
  error?: string;
}

export interface TokenUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface Span {
  span_id: string;
  trace_id: string;
  parent_span_id?: string;
  name: string;
  kind: SpanKind;
  status_code: SpanStatus;
  status_message?: string;
  start_time: string;
  end_time?: string;
  attributes?: Record<string, unknown>;
  events?: SpanEvent[];
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
  spans?: Span[];
}
