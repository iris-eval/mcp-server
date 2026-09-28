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
  /** Every input token, the ones read from or written to the prompt cache included (OpenAI's and the GenAI conventions' count). */
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  /** Of prompt_tokens, how many were read from the prompt cache. Priced at the model's cache-read price. */
  cache_read_tokens?: number;
  /** Of prompt_tokens, how many were written to the prompt cache. Priced at the model's cache-write price. */
  cache_creation_tokens?: number;
  /** OpenAI's usage shape, accepted as sent: `cached_tokens` is read as cache_read_tokens when that is absent. */
  prompt_tokens_details?: { cached_tokens?: number };
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

/**
 * Where a trace's `cost_usd` came from. `reported`: the producer sent it
 * (`cost_usd`, or a cost attribute on its spans). `estimated`: Iris computed
 * it at ingest from the trace's token counts and its model's list price,
 * because the producer sent none (src/cost/trace-cost.ts).
 */
export type CostSource = 'reported' | 'estimated';

/** One model call an estimate priced. */
export interface CostEstimateCall {
  /** The model id as the trace recorded it. */
  model: string;
  /** The pricing-table id it matched (after case, a provider prefix or a dated snapshot). */
  priced_as: string;
  /** Every input token of the call, cached ones included. */
  prompt_tokens: number;
  completion_tokens: number;
  input_usd_per_1m: number;
  output_usd_per_1m: number;
  /** Present when the call read from or wrote to the prompt cache. */
  cache_read_tokens?: number;
  cache_creation_tokens?: number;
  /** The price the cached tokens were charged at; the input price when the table had no cache price (see `notes`). */
  cache_read_usd_per_1m?: number;
  cache_write_usd_per_1m?: number;
  cost_usd: number;
  /** `iris`: the built-in table. `config`: `pricing.models` in config.json. */
  price_source: 'iris' | 'config';
  /** The date the price was read: the built-in table's, or `pricing.asOf`; null when the config named none. */
  price_as_of: string | null;
}

/**
 * How an estimated cost was computed, or why a trace has no cost.
 *
 * `basis` says which token counts were priced: `token_usage` is the trace's
 * own counts at its one model; `calls` is each model call at its own model,
 * used when a trace's calls went to more than one model.
 */
export type CostEstimate =
  | {
      status: 'estimated';
      basis: 'token_usage' | 'calls';
      calls: CostEstimateCall[];
      /** What the estimate could not price as the provider bills it, in a sentence each: a cache price the table lacks, cache counts reported beside the input count. */
      notes?: string[];
    }
  | {
      status: 'unpriced';
      /** no_tokens: nothing to price. no_model: tokens, but no model named. unknown_model: a model no table prices. disabled: pricing.estimate is false. */
      reason: 'no_tokens' | 'no_model' | 'unknown_model' | 'disabled';
      message: string;
      /** With unknown_model: the ids no table priced. */
      models?: string[];
    };

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
  /** Where cost_usd came from. Absent when there is no cost. Set by the server, never accepted from a caller. */
  cost_source?: CostSource;
  /** How an estimated cost was computed, or why there is none. Absent on a reported cost and on traces stored before 0.20.0. */
  cost_estimate?: CostEstimate;
  metadata?: Record<string, unknown>;
  timestamp: string;
  created_at?: string;
  spans?: Span[];
  /** What the agent could have called — the MCP tools/list result, verbatim. */
  tools?: ToolDescriptor[];
  /**
   * The batch this execution belongs to, if the caller named one.
   *
   * Never inferred from timestamps: two deployments' notions of "a run"
   * differ, and a guessed grouping produces a comparison nobody can act on.
   */
  run_id?: string;
  /**
   * What makes this the same QUESTION as another trace. The caller's when it
   * sent one, else derived from the input — see src/eval/case-key.ts for why
   * the caller's always wins.
   */
  case_key?: string;
  /** The conversation this turn belongs to: explicit, or `gen_ai.conversation.id`, or the SEP-414 baggage `session_id`. */
  session_id?: string;
  /**
   * Which door the trace came through. Stored so a host hook and a
   * model-initiated log of the same turn can be told apart, and so a reader
   * can see which capture path fed a run. Absent on rows written before
   * 0.13.0.
   */
  source?: 'tool' | 'http' | 'cli' | 'hook' | 'otel';
}
