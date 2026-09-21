/*
 * Trace context (SEP-414) — read on both doors, stored, joined on export (arc 9, N-12).
 */
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { createServer, type Server } from 'node:http';
import { parseTraceparent, traceContextFrom, traceContextOfCall, storedTraceContext, withTraceContext } from '../../../src/otel/trace-context.js';
import { buildExportPayload } from '../../../src/otel/mapper.js';
import { OtelExporter } from '../../../src/otel/exporter.js';
import type { Trace } from '../../../src/types/trace.js';

const TP = '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01';

describe('parseTraceparent', () => {
  it('reads the four fields of a valid header, case-insensitively', () => {
    expect(parseTraceparent(TP)).toEqual({ version: '00', traceId: '4bf92f3577b34da6a3ce929d0e0e4736', parentId: '00f067aa0ba902b7', flags: 1 });
    expect(parseTraceparent(TP.toUpperCase())?.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
  });
  it('refuses what the spec refuses: the wrong shape, all-zero ids, version ff, and non-strings', () => {
    expect(parseTraceparent('not-a-header')).toBeNull();
    expect(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-0000000000000000-01')).toBeNull();
    expect(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01')).toBeNull();
    expect(parseTraceparent(42)).toBeNull();
    expect(parseTraceparent(undefined)).toBeNull();
  });
});

describe('traceContextFrom', () => {
  it('reads _meta and headers alike, keeps tracestate and baggage, and says whether the caller sampled', () => {
    const ctx = traceContextFrom({ traceparent: TP, tracestate: 'vendor=abc', baggage: 'session_id=s-1' });
    expect(ctx).toEqual({ traceparent: TP, tracestate: 'vendor=abc', baggage: 'session_id=s-1', trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', parent_span_id: '00f067aa0ba902b7', sampled: true });
    expect(traceContextFrom({ TRACEPARENT: TP.replace('-01', '-00') })?.sampled).toBe(false);
  });
  it('is undefined without a traceparent, and a bag with only tracestate is no context', () => {
    expect(traceContextFrom(undefined)).toBeUndefined();
    expect(traceContextFrom({})).toBeUndefined();
    expect(traceContextFrom({ tracestate: 'vendor=abc' })).toBeUndefined();
  });
  it('traceContextOfCall reads the SDK\'s extra: the _meta bag, and the MCP session id when the transport has one', () => {
    expect(traceContextOfCall({ _meta: { traceparent: TP }, sessionId: 'sess-1' })).toMatchObject({ trace_id: '4bf92f3577b34da6a3ce929d0e0e4736', mcp_session_id: 'sess-1' });
    expect(traceContextOfCall({ _meta: { traceparent: TP } })).not.toHaveProperty('mcp_session_id');
    expect(traceContextOfCall({ sessionId: 'sess-1' })).toBeUndefined();
    expect(traceContextOfCall(undefined)).toBeUndefined();
  });
  it('withTraceContext writes one key and leaves the rest; storedTraceContext reads it back', () => {
    const meta = withTraceContext({ requestId: 'r-9' }, traceContextFrom({ traceparent: TP }));
    expect(meta?.requestId).toBe('r-9');
    expect(storedTraceContext(meta)?.trace_id).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(withTraceContext({ a: 1 }, undefined)).toEqual({ a: 1 });
    expect(storedTraceContext({ trace_context: { traceparent: 'garbage' } })).toBeUndefined();
  });
});

describe('the export joins the caller\'s trace', () => {
  const base: Trace = { trace_id: 'a'.repeat(32), agent_name: 'bot', input: 'q', output: 'a', timestamp: '2026-09-21T12:00:00.000Z', latency_ms: 10 };
  const spansOf = (payload: unknown) =>
    (payload as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string; spanId: string; parentSpanId?: string }> }> }> }).resourceSpans[0].scopeSpans[0].spans;

  it('a trace without a context exports under its own id with no parent — exactly as before', () => {
    const [root] = spansOf(buildExportPayload([base], 'iris-eval'));
    expect(root.traceId).toBe('a'.repeat(32));
    expect(root.parentSpanId).toBeUndefined();
  });
  it('a trace with a context exports under the caller\'s trace id, its synthesized root parented to the caller\'s span', () => {
    const trace = { ...base, metadata: withTraceContext(undefined, traceContextFrom({ traceparent: TP })) };
    const [root] = spansOf(buildExportPayload([trace], 'iris-eval'));
    expect(root.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(root.parentSpanId).toBe('00f067aa0ba902b7');
  });
  it('with a span tree, every span carries the caller\'s trace id and only the roots are re-parented', () => {
    const trace: Trace = {
      ...base,
      metadata: withTraceContext(undefined, traceContextFrom({ traceparent: TP })),
      spans: [
        { span_id: 'b'.repeat(16), trace_id: base.trace_id, name: 'agent.run', kind: 'INTERNAL', status_code: 'OK', start_time: base.timestamp, end_time: base.timestamp },
        { span_id: 'c'.repeat(16), trace_id: base.trace_id, parent_span_id: 'b'.repeat(16), name: 'llm.call', kind: 'LLM', status_code: 'OK', start_time: base.timestamp, end_time: base.timestamp },
      ],
    };
    const spans = spansOf(buildExportPayload([trace], 'iris-eval'));
    expect(spans.map((s) => s.traceId)).toEqual(['4bf92f3577b34da6a3ce929d0e0e4736', '4bf92f3577b34da6a3ce929d0e0e4736']);
    expect(spans[0].parentSpanId).toBe('00f067aa0ba902b7');
    expect(spans[1].parentSpanId).toBe('c'.repeat(16) === spans[1].spanId ? spans[0].spanId : spans[1].parentSpanId);
    expect(spans[1].parentSpanId).toBe(spans[0].spanId);
  });
});

describe('the MCP attributes on the joined root (OTel MCP conventions)', () => {
  const base: Trace = { trace_id: 'a'.repeat(32), agent_name: 'bot', input: 'q', output: 'a', timestamp: '2026-09-21T12:00:00.000Z', latency_ms: 10 };
  type Attr = { key: string; value: { stringValue?: string } };
  const spansOf = (payload: unknown) =>
    (payload as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ spanId: string; parentSpanId?: string; attributes: Attr[] }> }> }> }).resourceSpans[0].scopeSpans[0].spans;
  const attr = (span: { attributes: Attr[] }, key: string) => span.attributes.find((a) => a.key === key)?.value.stringValue;
  const withCtx = (source: Trace['source'], sessionId?: string): Trace => ({ ...base, source, metadata: withTraceContext(undefined, traceContextOfCall({ _meta: { traceparent: TP }, sessionId })) });

  it('a trace logged over MCP with a context exports mcp.method.name and, when known, mcp.session.id', () => {
    const [root] = spansOf(buildExportPayload([withCtx('tool', 'sess-9')], 'iris-eval'));
    expect(attr(root, 'mcp.method.name')).toBe('tools/call');
    expect(attr(root, 'mcp.session.id')).toBe('sess-9');
    const [stdio] = spansOf(buildExportPayload([withCtx('tool')], 'iris-eval'));
    expect(attr(stdio, 'mcp.method.name')).toBe('tools/call');
    expect(attr(stdio, 'mcp.session.id')).toBeUndefined();
  });

  it('a trace that arrived by HTTP, or one logged over MCP without a context, carries neither', () => {
    const [http] = spansOf(buildExportPayload([withCtx('http', 'sess-9')], 'iris-eval'));
    expect(attr(http, 'mcp.method.name')).toBeUndefined();
    const [plain] = spansOf(buildExportPayload([{ ...base, source: 'tool' }], 'iris-eval'));
    expect(attr(plain, 'mcp.method.name')).toBeUndefined();
    expect(plain.parentSpanId).toBeUndefined();
  });

  it('with a span tree, the re-parented root carries them and the child does not', () => {
    const trace: Trace = {
      ...withCtx('tool', 'sess-9'),
      spans: [
        { span_id: 'b'.repeat(16), trace_id: base.trace_id, name: 'agent.run', kind: 'INTERNAL', status_code: 'OK', start_time: base.timestamp, end_time: base.timestamp },
        { span_id: 'c'.repeat(16), trace_id: base.trace_id, parent_span_id: 'b'.repeat(16), name: 'llm.call', kind: 'LLM', status_code: 'OK', start_time: base.timestamp, end_time: base.timestamp },
      ],
    };
    const [root, child] = spansOf(buildExportPayload([trace], 'iris-eval'));
    expect(attr(root, 'mcp.method.name')).toBe('tools/call');
    expect(attr(root, 'mcp.session.id')).toBe('sess-9');
    expect(attr(child, 'mcp.method.name')).toBeUndefined();
  });
});

describe('through the exporter to a receiver', () => {
  let server: Server;
  let received: unknown[] = [];
  let endpoint: string;

  beforeEach(async () => {
    received = [];
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (c: Buffer) => { body += c.toString(); });
      req.on('end', () => { received.push(JSON.parse(body)); res.statusCode = 200; res.end('{}'); });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('the received root span carries the caller\'s trace id and is parented to the caller\'s span', async () => {
    const trace: Trace = { trace_id: 'd'.repeat(32), agent_name: 'bot', input: 'q', output: 'a', timestamp: '2026-09-21T12:00:00.000Z', latency_ms: 10, source: 'tool', metadata: withTraceContext({ requestId: 'r-1' }, traceContextOfCall({ _meta: { traceparent: TP }, sessionId: 'sess-2' })) };
    const result = await new OtelExporter({ endpoint, serviceName: 'iris-eval' }).exportTraces([trace]);
    expect(result.ok).toBe(true);
    expect(received).toHaveLength(1);
    const spans = (received[0] as { resourceSpans: Array<{ scopeSpans: Array<{ spans: Array<{ traceId: string; parentSpanId?: string; attributes: Array<{ key: string; value: { stringValue?: string } }> }> }> }> }).resourceSpans[0].scopeSpans[0].spans;
    expect(spans).toHaveLength(1);
    expect(spans[0].traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(spans[0].parentSpanId).toBe('00f067aa0ba902b7');
    expect(spans[0].attributes.find((a) => a.key === 'mcp.session.id')?.value.stringValue).toBe('sess-2');
  });
});
