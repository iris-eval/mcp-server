// Map Iris trace/span types to OTLP JSON shape for export.
//
// Reference: https://opentelemetry.io/docs/specs/otlp/#otlphttp-json-encoding
// and the ExportTraceServiceRequest proto. OTLP JSON encodes uint64 IDs
// as lowercase hex strings; trace_id is 16 bytes (32 hex chars), span_id
// is 8 bytes (16 hex chars). Timestamps are nanoseconds since epoch as
// strings (uint64 range exceeds JS Number.MAX_SAFE_INTEGER so we emit as
// decimal string).
//
// We intentionally do not depend on @opentelemetry/* — the exporter
// serializes these plain objects, and the payload shape is the OTLP spec.

import type { Span, Trace, SpanKind } from '../types/trace.js';

// OTel SpanKind enum values (from opentelemetry-proto/trace/v1/trace.proto).
const KIND_MAP: Record<SpanKind, number> = {
  INTERNAL: 1,
  SERVER: 2,
  CLIENT: 3,
  PRODUCER: 4,
  CONSUMER: 5,
  // Iris-specific kinds — map to INTERNAL for OTel. The actual LLM /
  // tool semantics are preserved in attributes (llm.provider, tool.name).
  LLM: 1,
  TOOL: 1,
};

const STATUS_MAP = {
  UNSET: 0,
  OK: 1,
  ERROR: 2,
} as const;

// Convert "abcdef0123..." (any length hex) to exactly 32 hex chars, or
// if non-hex, hash it. Iris sometimes generates IDs like "mcp-<uuid>"
// that aren't pure hex.
function toTraceIdHex(raw: string): string {
  const hex = raw.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{32}$/.test(hex)) return hex;
  if (/^[0-9a-f]{16,}$/.test(hex)) return hex.slice(0, 32).padEnd(32, '0');
  // Fallback: hash to 32 hex chars deterministically.
  return djb2Hex(raw, 32);
}

function toSpanIdHex(raw: string): string {
  const hex = raw.replace(/-/g, '').toLowerCase();
  if (/^[0-9a-f]{16}$/.test(hex)) return hex;
  if (/^[0-9a-f]{8,}$/.test(hex)) return hex.slice(0, 16).padEnd(16, '0');
  return djb2Hex(raw, 16);
}

// Tiny deterministic string → hex hash. Not cryptographic — just to give
// OTel consumers a stable id when Iris produced a non-hex identifier.
function djb2Hex(s: string, hexLen: number): string {
  let h = 5381n;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5n) + h + BigInt(s.charCodeAt(i))) & ((1n << 64n) - 1n);
  }
  // Use BigInt to avoid JS Number collisions on long strings.
  let hex = h.toString(16);
  while (hex.length < hexLen) hex = hex + djb2Step(s + hex).toString(16);
  return hex.slice(0, hexLen).padEnd(hexLen, '0');
}

function djb2Step(s: string): bigint {
  let h = 5381n;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5n) + h + BigInt(s.charCodeAt(i))) & ((1n << 64n) - 1n);
  }
  return h;
}

function toNanoString(iso: string | undefined): string {
  if (!iso) return '0';
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return '0';
  // ms → ns as string (BigInt-safe).
  return (BigInt(ms) * 1_000_000n).toString();
}

// OTel attribute value must be one of string/bool/int/double/array/kvlist.
// We coerce arbitrary Iris metadata into the best-fit primitive; objects
// get stringified so nothing gets lost silently.
export interface OtlpKeyValue {
  key: string;
  value: OtlpAnyValue;
}

export type OtlpAnyValue =
  | { stringValue: string }
  | { boolValue: boolean }
  | { intValue: string }
  | { doubleValue: number }
  | { arrayValue: { values: OtlpAnyValue[] } }
  | { kvlistValue: { values: OtlpKeyValue[] } };

function toAnyValue(v: unknown): OtlpAnyValue {
  if (typeof v === 'string') return { stringValue: v };
  if (typeof v === 'boolean') return { boolValue: v };
  if (typeof v === 'number') {
    if (Number.isInteger(v)) return { intValue: String(v) };
    return { doubleValue: v };
  }
  if (Array.isArray(v)) {
    return { arrayValue: { values: v.map(toAnyValue) } };
  }
  if (v && typeof v === 'object') {
    return {
      kvlistValue: {
        values: Object.entries(v as Record<string, unknown>).map(([k, val]) => ({
          key: k,
          value: toAnyValue(val),
        })),
      },
    };
  }
  // null / undefined / bigint / fn / symbol — fall back to string
  return { stringValue: String(v) };
}

function flattenAttrs(attrs: Record<string, unknown> | undefined): OtlpKeyValue[] {
  if (!attrs) return [];
  return Object.entries(attrs).map(([k, v]) => ({ key: k, value: toAnyValue(v) }));
}

// Iris Span → OTLP Span JSON shape.
export function mapSpan(span: Span, traceIdOverride?: string): unknown {
  const attributes = flattenAttrs(span.attributes);
  // Surface Iris-specific kinds via attributes so OTel consumers can
  // filter on iris.span_kind even though we mapped everything non-OTel to INTERNAL.
  if (span.kind === 'LLM' || span.kind === 'TOOL') {
    attributes.push({ key: 'iris.span_kind', value: { stringValue: span.kind } });
  }

  const events = (span.events ?? []).map((e) => ({
    timeUnixNano: toNanoString(e.timestamp),
    name: e.name,
    attributes: flattenAttrs(e.attributes),
  }));

  return {
    traceId: toTraceIdHex(traceIdOverride ?? span.trace_id),
    spanId: toSpanIdHex(span.span_id),
    parentSpanId: span.parent_span_id ? toSpanIdHex(span.parent_span_id) : undefined,
    name: span.name,
    kind: KIND_MAP[span.kind] ?? 1,
    startTimeUnixNano: toNanoString(span.start_time),
    endTimeUnixNano: toNanoString(span.end_time ?? span.start_time),
    attributes,
    events,
    status: {
      code: STATUS_MAP[span.status_code] ?? 0,
      message: span.status_message,
    },
  };
}

// Build a full OTLP ExportTraceServiceRequest payload from an Iris trace.
// If the trace has no explicit spans, we synthesize one root span from
// the trace-level fields (agent_name + latency + cost + token_usage as
// attributes) so exports aren't empty for simple trace rows.
export function buildExportPayload(traces: readonly Trace[], serviceName: string): unknown {
  const resource = {
    attributes: [
      { key: 'service.name', value: { stringValue: serviceName } },
      { key: 'telemetry.sdk.name', value: { stringValue: 'iris-mcp' } },
      { key: 'telemetry.sdk.language', value: { stringValue: 'nodejs' } },
      { key: 'telemetry.sdk.version', value: { stringValue: '0.4.0' } },
    ],
  };

  const spans: unknown[] = [];
  for (const trace of traces) {
    if (trace.spans && trace.spans.length > 0) {
      for (const s of trace.spans) spans.push(mapSpan(s, trace.trace_id));
    } else {
      // Synthesize root span from trace-level info.
      const attrs: Record<string, unknown> = {
        'iris.agent_name': trace.agent_name,
        'iris.framework': trace.framework,
      };
      if (trace.input) attrs['iris.input'] = truncate(trace.input);
      if (trace.output) attrs['iris.output'] = truncate(trace.output);
      if (trace.cost_usd !== undefined) attrs['iris.cost_usd'] = trace.cost_usd;
      if (trace.token_usage?.total_tokens !== undefined)
        attrs['iris.total_tokens'] = trace.token_usage.total_tokens;
      if (trace.token_usage?.prompt_tokens !== undefined)
        attrs['iris.prompt_tokens'] = trace.token_usage.prompt_tokens;
      if (trace.token_usage?.completion_tokens !== undefined)
        attrs['iris.completion_tokens'] = trace.token_usage.completion_tokens;

      const end = trace.latency_ms
        ? new Date(new Date(trace.timestamp).getTime() + trace.latency_ms).toISOString()
        : trace.timestamp;

      spans.push({
        traceId: toTraceIdHex(trace.trace_id),
        spanId: toSpanIdHex(trace.trace_id + ':root'),
        parentSpanId: undefined,
        name: trace.agent_name || 'agent_execution',
        kind: 1,
        startTimeUnixNano: toNanoString(trace.timestamp),
        endTimeUnixNano: toNanoString(end),
        attributes: flattenAttrs(attrs),
        events: [],
        status: { code: 0 },
      });
    }
  }

  return {
    resourceSpans: [
      {
        resource,
        scopeSpans: [
          {
            scope: { name: 'iris.trace.v1' },
            spans,
          },
        ],
      },
    ],
  };
}

function truncate(s: string, max = 4096): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}
