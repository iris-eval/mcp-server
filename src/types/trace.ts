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
  /*
   * The four below are additive (0.11.0) and read by nothing yet. They are
   * here rather than later because each is knowable only to the producer
   * and unrecoverable afterwards, and because adding a capture field once
   * corpus cases already exist means relabelling them.
   */
  /** The provider's own id for this call: tool_use_id, tool_call_id. Pairs a request to its result. */
  call_id?: string;
  /**
   * Whether the harness cut this output before recording it.
   *
   * Iris truncates nothing on ingest, so this is the ONLY sound signal — an
   * agent framework caps a tool result long before Iris sees it, and a rule
   * that treats an unknown as complete will call an elided read a
   * fabrication. Undefined means unknown and is never inferred from length.
   */
  truncated?: boolean;
  /** Token usage attributable to this call, when the producer knows it. */
  token_usage?: TokenUsage;
  /** Cost attributable to this call. Trace-level cost_usd stays authoritative and is never a sum of these. */
  cost_usd?: number;
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

export type StepKind = 'tool' | 'llm' | 'other';
export type StepStatus = 'ok' | 'error' | 'unset';
export type StepSource = 'tool_calls' | 'span';

/**
 * One thing the agent did.
 *
 * Field admission is decided by one rule rather than argued per field: a
 * field is carried when it can only come from the producer AND cannot be
 * recovered later from what is already carried. That admits `startedAt` and
 * `endedAt` (the only way to tell a regular poll from a loop — `latencyMs`
 * cannot), `callId` (the only sound way to pair a request to its result
 * across the provider shapes), `truncated`, `tokens`, `costUsd` and
 * `parentId`. It rejects a `depth` number (derivable from `parentId`, and
 * wrong whenever an intermediate span was sampled away — a derived number
 * that lies is worse than none), a `targetKey` field (Iris computes that,
 * and a field invites two fillers of it), and any raw attribute
 * passthrough (which lets a rule reach around the abstraction and become
 * vendor-specific).
 *
 * `truncated`, `tokens` and `costUsd` are carried and read by nothing yet.
 * The risk that an unread field rots is answered by a round-trip test; the
 * alternative is changing the capture schema later, once corpus cases
 * already depend on it.
 */
export interface Step {
  /** Position in THIS list — the number `Evidence.toolCall.index` means. */
  index: number;
  kind: StepKind;
  /** The tool name as the producer wrote it. */
  name: string;
  source: StepSource;
  status: StepStatus;
  input?: unknown;
  output?: unknown;
  error?: string;
  latencyMs?: number;
  /** ISO-8601. Span path only today: a tool_calls entry carries no clock. */
  startedAt?: string;
  endedAt?: string;
  /** The provider's own id: tool_use_id, tool_call_id, gen_ai.tool.call.id. */
  callId?: string;
  /** Span parentage. Carried so a sub-agent tree does not force a redesign; nothing reads it. */
  parentId?: string;
  /** The PRODUCER's statement that the output was cut. Undefined means unknown, and is never inferred here. */
  truncated?: boolean;
  tokens?: TokenUsage;
  costUsd?: number;
}

/**
 * One entry of an MCP `tools/list` result, carried verbatim.
 *
 * Verbatim is the design. JSON Schema is already the wire format of an MCP
 * tool's arguments, so an agent that wants its calls checked pastes the
 * result it already holds and no translation step exists to disagree with
 * itself. The three fields Iris READS are `name`, `inputSchema` and
 * `annotations.readOnlyHint`; everything else is carried so a catalogue
 * survives a round trip unchanged.
 */
export interface ToolDescriptor {
  name: string;
  title?: string;
  description?: string;
  /** JSON Schema for the tool's arguments. Free-form here: it IS a document. */
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    /**
     * The MCP hint that a tool does not modify anything.
     *
     * A HINT. The specification says a client must not rely on it for
     * security, so it may inform a cost or behaviour signal and may never
     * inform a safety veto.
     */
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
    [key: string]: unknown;
  };
  /** Carried, never read. The SDK advertises it on every tool. */
  execution?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
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
  /** What the agent could have called — the MCP tools/list result, verbatim. */
  tools?: ToolDescriptor[];
}
