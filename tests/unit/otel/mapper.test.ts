import { describe, it, expect } from 'vitest';
import { mapSpan, buildExportPayload } from '../../../src/otel/mapper.js';
import type { Span, Trace } from '../../../src/types/trace.js';

describe('OTel mapper — mapSpan', () => {
  const baseSpan: Span = {
    span_id: '0123456789abcdef',
    trace_id: '0123456789abcdef0123456789abcdef',
    name: 'test.span',
    kind: 'INTERNAL',
    status_code: 'OK',
    start_time: '2026-04-24T12:00:00.000Z',
    end_time: '2026-04-24T12:00:01.500Z',
    attributes: { foo: 'bar', count: 42 },
  };

  it('maps a basic span to OTLP shape', () => {
    const mapped = mapSpan(baseSpan) as {
      traceId: string;
      spanId: string;
      name: string;
      kind: number;
      startTimeUnixNano: string;
      endTimeUnixNano: string;
      status: { code: number };
      attributes: Array<{ key: string; value: unknown }>;
    };

    expect(mapped.traceId).toBe('0123456789abcdef0123456789abcdef');
    expect(mapped.spanId).toBe('0123456789abcdef');
    expect(mapped.name).toBe('test.span');
    expect(mapped.kind).toBe(1); // INTERNAL
    expect(mapped.status.code).toBe(1); // OK
    // 12:00:00.000 → BigInt(ms) * 1e6
    expect(mapped.startTimeUnixNano).toBe(String(new Date(baseSpan.start_time).getTime() * 1_000_000));
    expect(mapped.endTimeUnixNano).toBe(String(new Date(baseSpan.end_time!).getTime() * 1_000_000));
    // Attributes flattened with typed values
    expect(mapped.attributes).toEqual([
      { key: 'foo', value: { stringValue: 'bar' } },
      { key: 'count', value: { intValue: '42' } },
    ]);
  });

  it('preserves parent_span_id', () => {
    const child = { ...baseSpan, parent_span_id: 'fedcba9876543210' };
    const mapped = mapSpan(child) as { parentSpanId?: string };
    expect(mapped.parentSpanId).toBe('fedcba9876543210');
  });

  it('maps ERROR status code to 2', () => {
    const err = { ...baseSpan, status_code: 'ERROR' as const, status_message: 'boom' };
    const mapped = mapSpan(err) as { status: { code: number; message?: string } };
    expect(mapped.status.code).toBe(2);
    expect(mapped.status.message).toBe('boom');
  });

  it('maps Iris-specific kinds (LLM / TOOL) to INTERNAL + surfaces iris.span_kind', () => {
    const llm = { ...baseSpan, kind: 'LLM' as const };
    const mapped = mapSpan(llm) as {
      kind: number;
      attributes: Array<{ key: string; value: unknown }>;
    };
    expect(mapped.kind).toBe(1); // INTERNAL fallback
    const kindAttr = mapped.attributes.find((a) => a.key === 'iris.span_kind');
    expect(kindAttr).toEqual({ key: 'iris.span_kind', value: { stringValue: 'LLM' } });
  });

  it('handles nested object attributes as kvlist', () => {
    const nested = { ...baseSpan, attributes: { metadata: { tool: 'search', model: 'claude' } } };
    const mapped = mapSpan(nested) as {
      attributes: Array<{ key: string; value: { kvlistValue?: unknown } }>;
    };
    const meta = mapped.attributes.find((a) => a.key === 'metadata');
    expect(meta?.value).toHaveProperty('kvlistValue');
  });

  it('handles array attributes as arrayValue', () => {
    const arr = { ...baseSpan, attributes: { tags: ['foo', 'bar'] } };
    const mapped = mapSpan(arr) as {
      attributes: Array<{ key: string; value: { arrayValue?: unknown } }>;
    };
    const tags = mapped.attributes.find((a) => a.key === 'tags');
    expect(tags?.value).toHaveProperty('arrayValue');
  });

  it('handles float attributes as doubleValue', () => {
    const float = { ...baseSpan, attributes: { cost: 0.5, ratio: 3.14 } };
    const mapped = mapSpan(float) as {
      attributes: Array<{ key: string; value: { doubleValue?: number; intValue?: string } }>;
    };
    const cost = mapped.attributes.find((a) => a.key === 'cost');
    expect(cost?.value).toEqual({ doubleValue: 0.5 });
  });

  it('maps events with nanosecond timestamps', () => {
    const withEvent: Span = {
      ...baseSpan,
      events: [{ name: 'cache.miss', timestamp: '2026-04-24T12:00:00.500Z', attributes: { key: 'abc' } }],
    };
    const mapped = mapSpan(withEvent) as {
      events: Array<{ name: string; timeUnixNano: string; attributes: Array<{ key: string }> }>;
    };
    expect(mapped.events).toHaveLength(1);
    expect(mapped.events[0].name).toBe('cache.miss');
    expect(mapped.events[0].timeUnixNano).toBe(String(new Date('2026-04-24T12:00:00.500Z').getTime() * 1_000_000));
    expect(mapped.events[0].attributes[0].key).toBe('key');
  });

  it('falls back when trace_id is not pure hex', () => {
    const nonHex = { ...baseSpan, trace_id: 'mcp-xyz-12345' };
    const mapped = mapSpan(nonHex) as { traceId: string };
    expect(mapped.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('falls back when span_id is too short', () => {
    const short = { ...baseSpan, span_id: 'abc' };
    const mapped = mapSpan(short) as { spanId: string };
    expect(mapped.spanId).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('OTel mapper — buildExportPayload', () => {
  it('emits ExportTraceServiceRequest shape with service name in resource', () => {
    const trace: Trace = {
      trace_id: '00000000000000000000000000000001',
      agent_name: 'test-agent',
      timestamp: '2026-04-24T12:00:00Z',
    };
    const payload = buildExportPayload([trace], 'iris-test') as {
      resourceSpans: Array<{
        resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
        scopeSpans: Array<{ scope: { name: string }; spans: unknown[] }>;
      }>;
    };
    const svcAttr = payload.resourceSpans[0].resource.attributes.find(
      (a) => a.key === 'service.name',
    );
    expect(svcAttr?.value.stringValue).toBe('iris-test');
    expect(payload.resourceSpans[0].scopeSpans[0].scope.name).toBe('iris.trace.v1');
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(1);
  });

  it('synthesizes a root span from trace-level fields when no spans provided', () => {
    const trace: Trace = {
      trace_id: '00000000000000000000000000000002',
      agent_name: 'solo-agent',
      framework: 'langchain',
      cost_usd: 0.05,
      token_usage: { total_tokens: 1500, prompt_tokens: 1000, completion_tokens: 500 },
      latency_ms: 2500,
      input: 'a'.repeat(5000),
      timestamp: '2026-04-24T12:00:00Z',
    };
    const payload = buildExportPayload([trace], 'iris-mcp') as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{
        name: string;
        attributes: Array<{ key: string; value: unknown }>;
      }> }> }>;
    };
    const span = payload.resourceSpans[0].scopeSpans[0].spans[0];
    expect(span.name).toBe('solo-agent');
    const attrs = Object.fromEntries(span.attributes.map((a) => [a.key, a.value]));
    expect(attrs['iris.agent_name']).toEqual({ stringValue: 'solo-agent' });
    expect(attrs['iris.framework']).toEqual({ stringValue: 'langchain' });
    expect(attrs['iris.cost_usd']).toEqual({ doubleValue: 0.05 });
    expect(attrs['iris.total_tokens']).toEqual({ intValue: '1500' });
    // Input truncated to ~4096 + ellipsis
    const inputAttr = attrs['iris.input'] as { stringValue: string };
    expect(inputAttr.stringValue.length).toBeLessThanOrEqual(4097);
    expect(inputAttr.stringValue.endsWith('…')).toBe(true);
  });

  it('uses all provided spans when trace has a span tree', () => {
    const trace: Trace = {
      trace_id: '00000000000000000000000000000003',
      agent_name: 'multi-span',
      timestamp: '2026-04-24T12:00:00Z',
      spans: [
        {
          span_id: 'a'.repeat(16),
          trace_id: '00000000000000000000000000000003',
          name: 'root',
          kind: 'INTERNAL',
          status_code: 'OK',
          start_time: '2026-04-24T12:00:00Z',
        },
        {
          span_id: 'b'.repeat(16),
          trace_id: '00000000000000000000000000000003',
          parent_span_id: 'a'.repeat(16),
          name: 'child',
          kind: 'INTERNAL',
          status_code: 'OK',
          start_time: '2026-04-24T12:00:00.500Z',
        },
      ],
    };
    const payload = buildExportPayload([trace], 'x') as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ name: string }> }> }>;
    };
    const spans = payload.resourceSpans[0].scopeSpans[0].spans;
    expect(spans.map((s) => s.name)).toEqual(['root', 'child']);
  });

  it('combines spans from multiple traces', () => {
    const t1: Trace = {
      trace_id: '00000000000000000000000000000011',
      agent_name: 'a1',
      timestamp: '2026-04-24T12:00:00Z',
    };
    const t2: Trace = {
      trace_id: '00000000000000000000000000000012',
      agent_name: 'a2',
      timestamp: '2026-04-24T12:00:01Z',
    };
    const payload = buildExportPayload([t1, t2], 'svc') as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>;
    };
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(2);
  });

  it('emits empty spans array for empty trace list', () => {
    const payload = buildExportPayload([], 'svc') as {
      resourceSpans: Array<{ scopeSpans: Array<{ spans: unknown[] }> }>;
    };
    expect(payload.resourceSpans[0].scopeSpans[0].spans).toHaveLength(0);
  });
});
