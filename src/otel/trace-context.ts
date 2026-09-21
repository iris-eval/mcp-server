/*
 * W3C trace context, as MCP carries it (SEP-414, Final): `traceparent`,
 * `tracestate` and `baggage` ride in a request's `_meta`, and on HTTP in
 * the headers of the same names. Iris READS them (arc 9, N-12): a trace
 * logged with a context is stored with it, and when Iris exports to
 * `IRIS_OTEL_ENDPOINT` the exported spans join the caller's trace — the
 * evaluation shows up inside the agent's own trace in Langfuse, Phoenix,
 * Logfire or Jaeger instead of beside it.
 *
 * Read, never minted: a request without a context stores none, and the
 * export then carries Iris's own ids exactly as before.
 */

export interface TraceContext {
  /** The header as it arrived, `00-<trace id>-<parent span id>-<flags>`. */
  traceparent: string;
  tracestate?: string;
  baggage?: string;
  /** 32 lowercase hex characters, from the header. */
  trace_id: string;
  /** 16 lowercase hex characters — the caller's span that made the request; the exported root's parent. */
  parent_span_id: string;
  /** The trace flags byte; bit 0 is "sampled". */
  sampled: boolean;
  /** The MCP session the request arrived on (streamable HTTP; stdio has none) — exported as `mcp.session.id`. */
  mcp_session_id?: string;
}

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** Parse a `traceparent` header. Null when it is not one, including the all-zero ids the spec forbids. */
export function parseTraceparent(raw: unknown): { version: string; traceId: string; parentId: string; flags: number } | null {
  if (typeof raw !== 'string') return null;
  const m = TRACEPARENT.exec(raw.trim().toLowerCase());
  if (!m) return null;
  const [, version, traceId, parentId, flags] = m;
  if (version === 'ff') return null;
  if (/^0+$/.test(traceId) || /^0+$/.test(parentId)) return null;
  return { version, traceId, parentId, flags: Number.parseInt(flags, 16) };
}

const asString = (v: unknown): string | undefined => (typeof v === 'string' && v.trim().length > 0 ? v.trim() : undefined);

/** The context in a bag of `_meta` fields or HTTP headers (both spellings are the W3C names, case-insensitive). */
export function traceContextFrom(bag: Record<string, unknown> | undefined | null, mcp?: { sessionId?: string }): TraceContext | undefined {
  if (!bag || typeof bag !== 'object') return undefined;
  const get = (name: string): unknown => bag[name] ?? bag[name.toLowerCase()] ?? bag[name.toUpperCase()];
  const parsed = parseTraceparent(get('traceparent'));
  if (!parsed) return undefined;
  const tracestate = asString(get('tracestate'));
  const baggage = asString(get('baggage'));
  return {
    traceparent: `${parsed.version}-${parsed.traceId}-${parsed.parentId}-${parsed.flags.toString(16).padStart(2, '0')}`,
    ...(tracestate !== undefined ? { tracestate: tracestate.slice(0, 512) } : {}),
    ...(baggage !== undefined ? { baggage: baggage.slice(0, 8192) } : {}),
    trace_id: parsed.traceId,
    parent_span_id: parsed.parentId,
    sampled: (parsed.flags & 0x01) === 0x01,
    ...(typeof mcp?.sessionId === 'string' && mcp.sessionId.length > 0 ? { mcp_session_id: mcp.sessionId } : {}),
  };
}

/** The request's `extra` as the MCP SDK hands it to a tool handler: the `_meta` bag and, on streamable HTTP, the session id. */
export type RequestExtraLike = { _meta?: Record<string, unknown>; sessionId?: string } | undefined;

/** The context a tool call carried — `_meta` per SEP-414, the session per the transport. */
export function traceContextOfCall(extra: unknown): TraceContext | undefined {
  const e = extra as RequestExtraLike;
  return traceContextFrom(e?._meta, { sessionId: e?.sessionId });
}

/** The stored context on a trace's metadata, if it carries one that still parses. */
export function storedTraceContext(metadata: Record<string, unknown> | undefined): TraceContext | undefined {
  const raw = metadata?.trace_context;
  if (!raw || typeof raw !== 'object') return undefined;
  const bag = raw as Record<string, unknown>;
  return traceContextFrom(bag, { sessionId: typeof bag.mcp_session_id === 'string' ? bag.mcp_session_id : undefined });
}

/** Metadata with the context written under one key, leaving everything else the caller sent. */
export function withTraceContext(metadata: Record<string, unknown> | undefined, context: TraceContext | undefined): Record<string, unknown> | undefined {
  if (!context) return metadata;
  return { ...(metadata ?? {}), trace_context: context };
}
