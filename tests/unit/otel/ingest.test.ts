/*
 * OTLP in — the mapper.
 *
 * A GenAI-conventions fixture (a chat root span and a tool child) maps to
 * one trace with the input, the output, the tokens, the cost and — through
 * toSteps, unchanged — an EXACT Step[] read off the tool span. A
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
      // The model lands beside the OTel block: what the judge's same-family check reads.
      model: 'gpt-4o',
      otel: { trace_id: '5b8efff798038103d269b633813fc60c', scope: 'openllmetry', resource: { 'service.name': 'support-bot', 'iris.run': 'nightly-7', 'deployment.environment': 'staging' } },
    });
    expect(trace.spans).toHaveLength(2);
    // Span ids are Iris's (OTLP ids are unique within a trace, not across them); the OTLP id rides along as an attribute and the parent link is rewritten.
    expect(trace.spans?.[0]).toMatchObject({ span_id: 'span-1', trace_id: 'iris0000000000000000000000000001', kind: 'LLM', status_code: 'OK', start_time: '2026-09-21T12:00:00.000Z', end_time: '2026-09-21T12:00:01.500Z', attributes: { 'otel.span_id': 'eee19b7ec3c1b174' } });
    expect(trace.spans?.[0]).not.toHaveProperty('parent_span_id');
    expect(trace.spans?.[1]).toMatchObject({ span_id: 'span-2', parent_span_id: 'span-1', kind: 'TOOL', status_code: 'OK', attributes: { 'otel.span_id': 'a1b2c3d4e5f60718', 'gen_ai.tool.name': 'refund' } });

    // The exact Step[] the mapper reads off the tool span. `gen_ai.tool.call.arguments` is a JSON
    // document sent as a string, so the step carries the object it encodes, which is what a tool's
    // input schema is checked against.
    expect(toSteps({ spans: trace.spans })).toEqual([
      {
        index: 0,
        kind: 'tool',
        name: 'refund',
        source: 'span',
        status: 'ok',
        input: { order: 42 },
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
      'service.name (agent_name defaulted to "otel"; set service.name on the resource, iris.agent_name, or gen_ai.agent.name)',
      'input (no iris.input, gen_ai.input.messages, gen_ai.prompt, input.value, traceloop.entity.input or ai.prompt on any span or event)',
      'output (no iris.output, gen_ai.output.messages, gen_ai.completion, output.value, traceloop.entity.output or ai.response.text on any span or event — the rules that read the output will not run)',
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

/*
 * Every convention a user will test against the door. One
 * compact fixture per family; the keys are the ones the vendor's own docs
 * and instrumentors emit.
 */
describe('fromOtlp — the conventions beside GenAI', () => {
  const TID = '5b8efff798038103d269b633813fc60c';
  type Attr = { key: string; value: unknown };
  const span = (id: string, name: string, attributes: Attr[], parent?: string, at = 0) => ({
    traceId: TID,
    spanId: id,
    ...(parent ? { parentSpanId: parent } : {}),
    name,
    kind: 1,
    startTimeUnixNano: nanos(T0 + at),
    endTimeUnixNano: nanos(T0 + at + 100),
    attributes,
  });
  const request = (service: string | undefined, spans: unknown[], resourceExtra: Attr[] = []) => ({
    resourceSpans: [{ resource: { attributes: [...(service ? [kv('service.name', str(service))] : []), ...resourceExtra] }, scopeSpans: [{ scope: { name: 'x' }, spans }] }],
  });
  const one = (req: unknown) => {
    const mapped = fromOtlp(otlpTraceRequestSchema.parse(req));
    expect(mapped.traces).toHaveLength(1);
    return mapped.traces[0];
  };

  it('OpenInference (Phoenix, CrewAI, OpenAI-Agents, ADK instrumentors): input.value, output.value, llm.token_count.*, a TOOL span by openinference.span.kind', () => {
    const { trace, lacked } = one(request('crew', [
      span('0000000000000001', 'CrewAgent.run', [kv('openinference.span.kind', str('AGENT')), kv('input.value', str('Plan the launch')), kv('output.value', str('Launch plan: three steps.'))]),
      span('0000000000000002', 'ChatOpenAI', [kv('openinference.span.kind', str('LLM')), kv('llm.model_name', str('gpt-4o')), kv('llm.token_count.prompt', int(300)), kv('llm.token_count.completion', int(50))], '0000000000000001', 10),
      span('0000000000000003', 'search', [kv('openinference.span.kind', str('TOOL')), kv('tool.name', str('search')), kv('input.value', str('{"q":"launch"}')), kv('output.value', str('{"hits":3}'))], '0000000000000001', 20),
    ]));
    expect(trace.input).toBe('Plan the launch');
    expect(trace.output).toBe('Launch plan: three steps.');
    expect(trace.token_usage).toEqual({ prompt_tokens: 300, completion_tokens: 50, total_tokens: 350 });
    expect(trace.metadata?.model).toBe('gpt-4o');
    expect(trace.spans?.filter((x) => x.kind === 'TOOL')).toHaveLength(1);
    expect(toSteps({ spans: trace.spans })[0]).toMatchObject({ name: 'search' });
    expect(lacked).toEqual([]);
  });

  it('Traceloop (OpenLLMetry): traceloop.entity.* and the indexed gen_ai.prompt.N.content, joined in order', () => {
    const { trace } = one(request('rag', [
      span('0000000000000001', 'openai.chat', [kv('gen_ai.prompt.0.role', str('system')), kv('gen_ai.prompt.0.content', str('Be brief.')), kv('gen_ai.prompt.1.role', str('user')), kv('gen_ai.prompt.1.content', str('Sum it up.')), kv('gen_ai.completion.0.content', str('Done.')), kv('gen_ai.usage.prompt_tokens', int(40)), kv('gen_ai.usage.completion_tokens', int(5)), kv('gen_ai.request.model', str('gpt-4o-mini'))]),
    ]));
    expect(trace.input).toBe('Be brief.\nSum it up.');
    expect(trace.output).toBe('Done.');
    expect(trace.token_usage?.prompt_tokens).toBe(40);
    const entity = one(request('rag', [span('0000000000000001', 'workflow', [kv('traceloop.entity.input', str('{"q":"x"}')), kv('traceloop.entity.output', str('{"a":"y"}'))])]));
    expect(entity.trace.input).toBe('{"q":"x"}');
    expect(entity.trace.output).toBe('{"a":"y"}');
  });

  it('Semantic Kernel: gen_ai.response.prompt_tokens / completion_tokens are usage', () => {
    const { trace } = one(request('sk', [span('0000000000000001', 'chat', [kv('gen_ai.system', str('openai')), kv('gen_ai.prompt', str('q')), kv('gen_ai.completion', str('a')), kv('gen_ai.response.prompt_tokens', int(11)), kv('gen_ai.response.completion_tokens', int(7))])]));
    expect(trace.token_usage).toEqual({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 });
  });

  it('the Vercel AI SDK legacy keys: ai.prompt, ai.response.text, ai.usage.*, ai.model.id', () => {
    const { trace } = one(request('web', [span('0000000000000001', 'ai.generateText', [kv('ai.prompt', str('hello')), kv('ai.response.text', str('hi')), kv('ai.usage.promptTokens', int(3)), kv('ai.usage.completionTokens', int(1)), kv('ai.model.id', str('claude-sonnet-5'))])]));
    expect(trace.input).toBe('hello');
    expect(trace.output).toBe('hi');
    expect(trace.token_usage?.total_tokens).toBe(4);
    expect(trace.metadata?.model).toBe('claude-sonnet-5');
  });

  it('gen_ai.agent.name names the agent when the resource has no service.name; the conversation id and the tool catalogue ride along', () => {
    const tools = JSON.stringify([{ name: 'refund_order', description: 'Refund an order', parameters: { type: 'object', properties: { order_id: { type: 'integer' } } } }]);
    const { trace, lacked } = one(request(undefined, [
      span('0000000000000001', 'invoke_agent billing', [kv('gen_ai.operation.name', str('invoke_agent')), kv('gen_ai.agent.name', str('billing-agent')), kv('gen_ai.conversation.id', str('conv-77')), kv('gen_ai.tool.definitions', str(tools)), kv('gen_ai.output.messages', str('ok'))]),
    ]));
    expect(trace.agent_name).toBe('billing-agent');
    expect(lacked.some((l) => l.startsWith('service.name'))).toBe(false);
    expect(trace.session_id).toBe('conv-77');
    expect(trace.tools).toEqual([{ name: 'refund_order', description: 'Refund an order', inputSchema: { type: 'object', properties: { order_id: { type: 'integer' } } } }]);
  });

  it('usage is summed over leaf carriers only: an invoke_agent that carries the totals beside its chat children is counted once', () => {
    const { trace } = one(request('af', [
      span('0000000000000001', 'invoke_agent', [kv('gen_ai.operation.name', str('invoke_agent')), kv('gen_ai.usage.input_tokens', int(1742)), kv('gen_ai.usage.output_tokens', int(136)), kv('gen_ai.output.messages', str('done'))]),
      span('0000000000000002', 'chat', [kv('gen_ai.operation.name', str('chat')), kv('gen_ai.request.model', str('m')), kv('gen_ai.usage.input_tokens', int(812)), kv('gen_ai.usage.output_tokens', int(96))], '0000000000000001', 10),
      span('0000000000000003', 'chat', [kv('gen_ai.operation.name', str('chat')), kv('gen_ai.request.model', str('m')), kv('gen_ai.usage.input_tokens', int(930)), kv('gen_ai.usage.output_tokens', int(40))], '0000000000000001', 20),
    ]));
    expect(trace.token_usage).toEqual({ prompt_tokens: 1742, completion_tokens: 136, total_tokens: 1878 });
  });

  it('an explicit whole-run aggregate (Pydantic AI gen_ai.aggregated_usage.*) is the answer, not one more addend', () => {
    const { trace } = one(request('pai', [
      span('0000000000000001', 'agent run', [kv('gen_ai.aggregated_usage.input_tokens', int(500)), kv('gen_ai.aggregated_usage.output_tokens', int(60)), kv('gen_ai.output.messages', str('done'))]),
      span('0000000000000002', 'chat', [kv('gen_ai.request.model', str('m')), kv('gen_ai.usage.input_tokens', int(200)), kv('gen_ai.usage.output_tokens', int(30))], '0000000000000001', 10),
      span('0000000000000003', 'chat', [kv('gen_ai.request.model', str('m')), kv('gen_ai.usage.input_tokens', int(300)), kv('gen_ai.usage.output_tokens', int(30))], '0000000000000001', 20),
    ]));
    expect(trace.token_usage).toEqual({ prompt_tokens: 500, completion_tokens: 60, total_tokens: 560 });
  });
});
