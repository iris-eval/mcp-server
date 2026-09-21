/*
 * OTLP in — the mapper (arc 8, R-2).
 *
 * A GenAI-conventions fixture (a chat root span and a tool child) maps to
 * one trace with the input, the output, the tokens, the cost and — through
 * arc 4's toSteps, unchanged — an EXACT Step[] read off the tool span. A
 * fixture with no GenAI attributes at all is still a trace, with what it
 * carried and a list of what it lacked. Ids, kinds, statuses and times are
 * decoded the way the OTLP JSON encoding writes them.
 */
import { describe, expect, it } from 'vitest';
import { fromOtlp, fromAnyValue, attributesToRecord, otlpTraceRequestSchema } from '../../../src/otel/ingest.js';
import { toSteps } from '../../../src/eval/steps.js';

const kv = (key: string, value: unknown) => ({ key, value });
const str = (s: string) => ({ stringValue: s });
const int = (n: number) => ({ intValue: String(n) });
const dbl = (n: number) => ({ doubleValue: n });

const T0 = Date.UTC(2026, 8, 21, 12, 0, 0); // 2026-09-21T12:00:00.000Z
const nanos = (ms: number) => (BigInt(ms) * 1_000_000n).toString();

function genAiFixture() {
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv('service.name', str('support-bot')), kv('iris.run', str('nightly-7')), kv('deployment.environment', str('staging'))] },
        scopeSpans: [
          {
            scope: { name: 'openllmetry' },
            spans: [
              {
                traceId: '5b8efff798038103d269b633813fc60c',
                spanId: 'eee19b7ec3c1b174',
                name: 'chat gpt-4o',
                kind: 3,
                startTimeUnixNano: nanos(T0),
                endTimeUnixNano: nanos(T0 + 1500),
                attributes: [
                  kv('gen_ai.operation.name', str('chat')),
                  kv('gen_ai.request.model', str('gpt-4o')),
                  kv('gen_ai.input.messages', str('[{"role":"user","content":"Refund order 42"}]')),
                  kv('gen_ai.output.messages', str('[{"role":"assistant","content":"Refunded order 42 in full."}]')),
                  kv('gen_ai.usage.input_tokens', int(120)),
                  kv('gen_ai.usage.output_tokens', int(30)),
                  kv('iris.cost_usd', dbl(0.0042)),
                ],
                status: { code: 1 },
              },
              {
                traceId: '5b8efff798038103d269b633813fc60c',
                spanId: 'a1b2c3d4e5f60718',
                parentSpanId: 'eee19b7ec3c1b174',
                name: 'execute_tool refund',
                kind: 1,
                startTimeUnixNano: nanos(T0 + 200),
                endTimeUnixNano: nanos(T0 + 900),
                attributes: [
                  kv('gen_ai.operation.name', str('execute_tool')),
                  kv('gen_ai.tool.name', str('refund')),
                  kv('gen_ai.tool.call.id', str('call_9')),
                  kv('gen_ai.tool.call.arguments', str('{"order":42}')),
                  kv('gen_ai.tool.call.result', str('{"ok":true}')),
                ],
                status: { code: 'STATUS_CODE_OK' },
              },
            ],
          },
        ],
      },
    ],
  };
}

describe('fromOtlp — a GenAI-conventions trace', () => {
  it('maps the resource and the root span to a trace, and the tool span to an exact Step[] through toSteps', () => {
    const request = otlpTraceRequestSchema.parse(genAiFixture());
    let n = 0;
    const { traces, rejectedSpans } = fromOtlp(request, { mintTraceId: () => 'iris0000000000000000000000000001', mintSpanId: () => `span-${++n}` });
    expect(rejectedSpans).toBe(0);
    expect(traces).toHaveLength(1);
    const { trace, otelTraceId, lacked } = traces[0];
    expect(otelTraceId).toBe('5b8efff798038103d269b633813fc60c');
    expect(lacked).toEqual([]);
    expect(trace).toMatchObject({
      trace_id: 'iris0000000000000000000000000001',
      agent_name: 'support-bot',
      input: '[{"role":"user","content":"Refund order 42"}]',
      output: '[{"role":"assistant","content":"Refunded order 42 in full."}]',
      latency_ms: 1500,
      token_usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 },
      cost_usd: 0.0042,
      timestamp: '2026-09-21T12:00:00.000Z',
      run_id: 'nightly-7',
      source: 'otel',
    });
    expect(trace.metadata).toEqual({
      otel: { trace_id: '5b8efff798038103d269b633813fc60c', scope: 'openllmetry', resource: { 'service.name': 'support-bot', 'iris.run': 'nightly-7', 'deployment.environment': 'staging' } },
    });
    expect(trace.spans).toHaveLength(2);
    // Span ids are Iris's (OTLP ids are unique within a trace, not across them); the OTLP id rides along as an attribute and the parent link is rewritten.
    expect(trace.spans?.[0]).toMatchObject({ span_id: 'span-1', trace_id: 'iris0000000000000000000000000001', kind: 'LLM', status_code: 'OK', start_time: '2026-09-21T12:00:00.000Z', end_time: '2026-09-21T12:00:01.500Z', attributes: { 'otel.span_id': 'eee19b7ec3c1b174' } });
    expect(trace.spans?.[0]).not.toHaveProperty('parent_span_id');
    expect(trace.spans?.[1]).toMatchObject({ span_id: 'span-2', parent_span_id: 'span-1', kind: 'TOOL', status_code: 'OK', attributes: { 'otel.span_id': 'a1b2c3d4e5f60718', 'gen_ai.tool.name': 'refund' } });

    // The exact Step[] arc 4's mapper reads off the tool span — unchanged code, GenAI keys it already knew.
    expect(toSteps({ spans: trace.spans })).toEqual([
      {
        index: 0,
        kind: 'tool',
        name: 'refund',
        source: 'span',
        status: 'ok',
        input: '{"order":42}',
        output: '{"ok":true}',
        startedAt: '2026-09-21T12:00:00.200Z',
        endedAt: '2026-09-21T12:00:00.900Z',
        latencyMs: 700,
        callId: 'call_9',
        parentId: 'span-1',
      },
    ]);
  });

  it('a payload with no GenAI attributes is stored with what it carries, and says what it lacked', () => {
    const request = otlpTraceRequestSchema.parse({
      resourceSpans: [
        {
          scopeSpans: [
            {
              spans: [
                { traceId: 'abc123', spanId: 'def456', name: 'GET /health', kind: 2, startTimeUnixNano: nanos(T0), endTimeUnixNano: nanos(T0 + 12), attributes: [kv('http.route', str('/health'))], status: { code: 2, message: 'boom' } },
              ],
            },
          ],
        },
      ],
    });
    const { traces } = fromOtlp(request, { mintTraceId: () => 'iris0000000000000000000000000002', now: () => '2026-09-21T12:34:56.000Z' });
    expect(traces).toHaveLength(1);
    const { trace, lacked } = traces[0];
    expect(trace.agent_name).toBe('otel');
    expect(trace.input).toBeUndefined();
    expect(trace.output).toBeUndefined();
    expect(trace.latency_ms).toBe(12);
    expect(trace.spans?.[0]).toMatchObject({ name: 'GET /health', kind: 'SERVER', status_code: 'ERROR', status_message: 'boom', attributes: { 'http.route': '/health' } });
    expect(lacked).toEqual([
      'service.name (agent_name defaulted to "otel"; set service.name on the resource, or iris.agent_name)',
      'input (no iris.input, gen_ai.input.messages or gen_ai.prompt on any span or event)',
      'output (no iris.output, gen_ai.output.messages or gen_ai.completion on any span or event — the rules that read the output will not run)',
    ]);
    expect(toSteps({ spans: trace.spans })).toEqual([]);
  });

  it('groups spans by OTLP trace id across resourceSpans, drops spans without ids into partialSuccess, and reads content events', () => {
    const request = otlpTraceRequestSchema.parse({
      resourceSpans: [
        {
          resource: { attributes: [kv('service.name', str('a'))] },
          scopeSpans: [{ spans: [{ traceId: 't1', spanId: 's1', startTimeUnixNano: nanos(T0), events: [{ name: 'gen_ai.content.completion', timeUnixNano: nanos(T0 + 5), attributes: [kv('gen_ai.completion', str('done'))] }] }, { spanId: 'no-trace-id' }] }],
        },
        {
          resource: { attributes: [kv('service.name', str('b'))] },
          scopeSpans: [{ spans: [{ traceId: 't2', spanId: 's2', startTimeUnixNano: nanos(T0 + 1000), attributes: [kv('gen_ai.prompt', str('hi')), kv('gen_ai.system', str('anthropic'))] }] }],
        },
      ],
    });
    let n = 0;
    const { traces, rejectedSpans, rejections } = fromOtlp(request, { mintTraceId: () => `iris${String(++n).padStart(28, '0')}` });
    expect(rejectedSpans).toBe(1);
    expect(rejections[0]).toMatch(/traceId/);
    expect(traces.map((t) => [t.otelTraceId, t.trace.agent_name, t.trace.input, t.trace.output])).toEqual([
      ['t1', 'a', undefined, 'done'],
      ['t2', 'b', 'hi', undefined],
    ]);
    expect(traces[1].trace.spans?.[0].kind).toBe('LLM');
    expect(traces[0].lacked.some((l) => l.startsWith('input'))).toBe(true);
    expect(traces[0].lacked.some((l) => l.startsWith('output'))).toBe(false);
  });

  it('decodes AnyValue the way the encoding writes it, including nested lists and maps', () => {
    expect(fromAnyValue({ stringValue: 's' })).toBe('s');
    expect(fromAnyValue({ boolValue: false })).toBe(false);
    expect(fromAnyValue({ intValue: '42' })).toBe(42);
    expect(fromAnyValue({ intValue: '9007199254740993' })).toBe('9007199254740993');
    expect(fromAnyValue({ doubleValue: 0.5 })).toBe(0.5);
    expect(fromAnyValue({ arrayValue: { values: [{ intValue: 1 }, { stringValue: 'x' }] } })).toEqual([1, 'x']);
    expect(fromAnyValue({ kvlistValue: { values: [{ key: 'a', value: { boolValue: true } }] } })).toEqual({ a: true });
    expect(attributesToRecord([kv('k', str('v')), kv('k', str('later'))])).toEqual({ k: 'later' });
    expect(attributesToRecord(undefined)).toEqual({});
  });

  it('refuses a body that is not an ExportTraceServiceRequest', () => {
    expect(otlpTraceRequestSchema.safeParse({ traces: [] }).success).toBe(false);
    expect(otlpTraceRequestSchema.safeParse({ resourceSpans: [] }).success).toBe(false);
    expect(otlpTraceRequestSchema.safeParse({ resourceSpans: [{}] }).success).toBe(true);
  });
});
