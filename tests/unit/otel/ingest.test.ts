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
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fromOtlp, fromAnyValue, attributesToRecord, otlpTraceRequestSchema, wordsOf } from '../../../src/otel/ingest.js';
import { toSteps } from '../../../src/eval/steps.js';
import { jsonTextDepth, MAX_JSON_TEXT_DEPTH, nestingDepth } from '../../../src/utils/element-count.js';
import { validToolArguments } from '../../../src/eval/rules/completeness.js';
import { toolChoice } from '../../../src/eval/rules/tool-choice.js';
import type { EvalContext } from '../../../src/types/eval.js';

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
      // gen_ai.input.messages / output.messages read down to their words; the span keeps the JSON as sent.
      input: 'Refund order 42',
      output: 'Refunded order 42 in full.',
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
      'input (no iris.input, gen_ai.input.messages, gen_ai.prompt, input.value, llm.input_messages, traceloop.entity.input or ai.prompt on any span or event; a Python repr, or JSON holding nothing but reprs, is not read as one)',
      'output (no iris.output, gen_ai.output.messages, gen_ai.completion, output.value, llm.output_messages, traceloop.entity.output or ai.response.text on any span or event; a Python repr, or JSON holding nothing but reprs, is not read as one — the rules that read the output will not run)',
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

  it('a tool catalogue whose text nests deeper than a JSON text is read to is not read, and one at the limit is (#1040)', () => {
    // A string is no level to the door that measures a body, and parsed it is as deep as its text nests: [{ name, parameters }] is two levels around the schema.
    const nested = (levels: number): string => `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;
    const catalogue = (levels: number): string => `[{"name":"refund_order","parameters":${nested(levels)}}]`;
    const mapped = (tools: string) =>
      one(request(undefined, [span('0000000000000001', 'invoke_agent billing', [kv('gen_ai.operation.name', str('invoke_agent')), kv('gen_ai.tool.definitions', str(tools)), kv('gen_ai.output.messages', str('ok'))])])).trace;
    expect(jsonTextDepth(catalogue(MAX_JSON_TEXT_DEPTH - 2), Infinity)).toBe(MAX_JSON_TEXT_DEPTH);
    const at = mapped(catalogue(MAX_JSON_TEXT_DEPTH - 2));
    expect(at.tools).toHaveLength(1);
    expect(nestingDepth(at.tools?.[0]?.inputSchema, Infinity)).toBe(MAX_JSON_TEXT_DEPTH - 2);
    for (const levels of [MAX_JSON_TEXT_DEPTH - 1, 3_000, 50_000]) expect(mapped(catalogue(levels)).tools, `${levels} levels`).toBeUndefined();
  });

  it("a model call's OpenInference schemas are read whole when each is at the limit or under it, and not at all when one is nested past it, as a catalogue in one attribute is not (#1040, #1082)", () => {
    const nested = (levels: number): string => `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;
    // The two forms an instrumentor writes: the tool flat, one level around its schema, or OpenAI's, two levels around it.
    const flat = (name: string, levels: number): string => `{"name":"${name}","parameters":${nested(levels)}}`;
    const openai = (name: string, levels: number): string => `{"type":"function","function":{"name":"${name}","parameters":${nested(levels)}}}`;
    // Each tool's own text is what is held to the limit: exactly at it a tool is read, and one level past it is not.
    expect(jsonTextDepth(flat('x', MAX_JSON_TEXT_DEPTH - 1), Infinity)).toBe(MAX_JSON_TEXT_DEPTH);
    expect(jsonTextDepth(openai('x', MAX_JSON_TEXT_DEPTH - 2), Infinity)).toBe(MAX_JSON_TEXT_DEPTH);
    const toolsOf = (...schemas: string[]) =>
      one(request(undefined, [
        span('0000000000000001', 'chat', [kv('gen_ai.operation.name', str('chat')), ...schemas.map((s, i) => kv(`llm.tools.${i}.tool.json_schema`, str(s))), kv('gen_ai.output.messages', str('ok'))]),
      ])).trace.tools;
    const read = toolsOf(flat('search', 3), flat('flat_at', MAX_JSON_TEXT_DEPTH - 1), openai('openai_at', MAX_JSON_TEXT_DEPTH - 2));
    expect(read?.map((t) => t.name)).toEqual(['search', 'flat_at', 'openai_at']);
    // The schema of a tool read at the limit is the value its text encodes, whole.
    expect(nestingDepth(read?.[1]?.inputSchema, Infinity)).toBe(MAX_JSON_TEXT_DEPTH - 1);
    expect(nestingDepth(read?.[2]?.inputSchema, Infinity)).toBe(MAX_JSON_TEXT_DEPTH - 2);
    // One past it, in either form, or one whose text is not JSON (cut short), at any place in the list: the catalogue would not be whole, and
    // none of it is read.
    for (const unread of [flat('flat_past', MAX_JSON_TEXT_DEPTH), openai('openai_past', MAX_JSON_TEXT_DEPTH - 1), flat('deep', 20_000), flat('cut', 3).slice(0, 30)]) {
      expect(toolsOf(unread, flat('search', 3)), unread.slice(0, 40)).toBeUndefined();
      expect(toolsOf(flat('search', 3), unread), unread.slice(0, 40)).toBeUndefined();
    }
    // A tool read whole that names nothing is no tool, and the others are read, as in a list in one attribute.
    expect(toolsOf(flat('search', 3), '{"type":"web_search"}')?.map((t) => t.name)).toEqual(['search']);
  });

  it('a call to an OpenInference tool nested past the limit is not judged as a call to a tool the model was not offered, by either rule (#1082)', () => {
    const nested = (levels: number): string => `${'{"a":'.repeat(levels)}1${'}'.repeat(levels)}`;
    const ask = 'Search the order database for order 42 and say where it is.';
    const judged = (lookupLevels: number) => {
      const { trace } = one(request(undefined, [
        span('0000000000000001', 'chat', [
          kv('gen_ai.operation.name', str('chat')),
          kv('llm.tools.0.tool.json_schema', str(`{"name":"search","description":"Search the order database for an order","parameters":${nested(3)}}`)),
          kv('llm.tools.1.tool.json_schema', str(`{"name":"lookup","parameters":${nested(lookupLevels)}}`)),
          kv('gen_ai.input.messages', str(ask)),
          kv('gen_ai.output.messages', str('It is in the warehouse.')),
        ]),
      ]));
      const context = { input: ask, output: 'It is in the warehouse.', toolCalls: [{ tool_name: 'lookup', input: { a: 1 } }], tools: trace.tools } as EvalContext;
      return { valid: validToolArguments.evaluate(context), choice: toolChoice.evaluate(context) };
    };
    // At the limit both tools are in the catalogue: the call is not failed as one to a tool the model was not offered (its schema, past the
    // validator's own depth cap, leaves it unchecked), and tool_choice weighs it against search.
    const at = judged(MAX_JSON_TEXT_DEPTH - 1);
    expect(at.valid.passed || at.valid.skipped).toBe(true);
    expect(at.valid.message).not.toContain('not in the catalogue');
    expect(at.choice.skipped).toBeFalsy();
    expect(at.choice.message).toContain('search fits');
    // Past it there is no catalogue, and both rules say so.
    const past = judged(MAX_JSON_TEXT_DEPTH);
    expect(past.valid).toMatchObject({ skipped: true, message: 'No tools catalogue provided' });
    expect(past.choice).toMatchObject({ skipped: true, message: 'No tools catalogue provided' });
    // And the changelog says so.
    expect(readFileSync(resolve(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8')).toContain(
      "each tool's own text held to 256 by itself; a list in which one cannot be read, nested deeper or not JSON, is not read, as a `gen_ai.tool.definitions` list that cannot be read is not, so the rules that need a catalogue say the call was not judged against one, where a call to the tool passed over read as a call to a tool not offered (#1082))",
    );
  });

  // An OTLP AnyValue for a plain value, as a sender writes structured attributes: an object is a map, a list an array value.
  const anyOf = (v: unknown): unknown =>
    typeof v === 'string' ? str(v)
    : typeof v === 'number' ? (Number.isInteger(v) ? int(v) : dbl(v))
    : typeof v === 'boolean' ? { boolValue: v }
    : Array.isArray(v) ? { arrayValue: { values: v.map(anyOf) } }
    : { kvlistValue: { values: Object.entries(v as Record<string, unknown>).map(([k, x]) => kv(k, anyOf(x))) } };

  it('an OpenInference tool sent as a map is read as the object it is, in either form, and a value of another kind names no tool (#1082)', () => {
    const toolsOf = (...values: unknown[]) =>
      one(request(undefined, [span('0000000000000001', 'chat', [kv('gen_ai.operation.name', str('chat')), ...values.map((v, i) => kv(`llm.tools.${i}.tool.json_schema`, v)), kv('gen_ai.output.messages', str('ok'))])])).trace.tools;
    const LOOKUP = { name: 'lookup', description: 'Look up an order', parameters: { type: 'object', properties: { order_id: { type: 'integer' } }, required: ['order_id'] } };
    const lookup = { name: 'lookup', description: 'Look up an order', inputSchema: LOOKUP.parameters };
    for (const sent of [anyOf(LOOKUP), anyOf({ type: 'function', function: LOOKUP })]) {
      expect(toolsOf(str('{"name":"search"}'), sent)).toEqual([{ name: 'search' }, lookup]);
    }
    // A model call whose only tool is a map has a catalogue: the map is its tool.
    expect(toolsOf(anyOf(LOOKUP))).toEqual([lookup]);
    // A value of another kind names no tool, and the others are read: a number, a truth value, a list, an AnyValue with no value.
    for (const other of [int(5), { boolValue: true }, anyOf(['x']), {}]) {
      expect(toolsOf(str('{"name":"search"}'), other, str('{"name":"lookup"}'))?.map((t) => t.name), JSON.stringify(other)).toEqual(['search', 'lookup']);
    }
    // What is read of a map is its own fields: a name it only inherits names no tool, at its top or in its function.
    const inherited = { kvlistValue: { values: [kv('__proto__', anyOf({ name: 'ghost' }))] } };
    expect(toolsOf(str('{"name":"search"}'), inherited)?.map((t) => t.name)).toEqual(['search']);
    const inheritedFunction = { kvlistValue: { values: [kv('type', str('function')), kv('function', { kvlistValue: { values: [kv('__proto__', anyOf({ name: 'ghost' }))] } })] } };
    expect(toolsOf(str('{"name":"search"}'), inheritedFunction)?.map((t) => t.name)).toEqual(['search']);
    // Nor does a function the map only inherits.
    const functionInherited = { kvlistValue: { values: [kv('__proto__', anyOf({ function: { name: 'ghost' } }))] } };
    expect(toolsOf(str('{"name":"search"}'), functionInherited)?.map((t) => t.name)).toEqual(['search']);
    // A model call whose only tool value names nothing (a list) is passed over for the next call's tools, as before.
    const twoCalls = one(request(undefined, [
      span('0000000000000001', 'chat', [kv('gen_ai.operation.name', str('chat')), kv('llm.tools.0.tool.json_schema', anyOf(['x'])), kv('gen_ai.output.messages', str('ok'))]),
      span('0000000000000002', 'chat', [kv('gen_ai.operation.name', str('chat')), kv('llm.tools.0.tool.json_schema', str('{"name":"search"}'))], '0000000000000001', 10),
    ]));
    expect(twoCalls.trace.tools?.map((t) => t.name)).toEqual(['search']);
    // A tool whose fields happen to be named like anything Iris keeps is read as a tool all the same.
    expect(toolsOf(str('{"name":"search","unread":"","wanted":""}'))?.map((t) => t.name)).toEqual(['search']);
    // The changelog and the OpenTelemetry page say so.
    expect(readFileSync(resolve(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8')).toContain(
      "- **An OpenInference tool sent as a map is read as the tool it is (#1082).** A model call's `llm.tools.N.tool.json_schema` written as a map rather than as JSON text (as a sender, or a Collector that turns JSON strings into maps, can write it) was passed over, so a call to that tool read as a call to a tool the model was not offered, and `valid_tool_arguments` and `tool_choice` failed it. Such a map is now read as the object it is, its own fields only. A value of another kind (a number, a list, nothing) still names no tool.",
    );
    expect(readFileSync(resolve(__dirname, '..', '..', '..', 'docs', 'otel-integration.md'), 'utf8')).toContain(
      'else OpenInference\'s `llm.tools.N.tool.json_schema` (OpenAI\'s `{ type: "function", function: {...} }` or a flat tool, 0.20.0; as JSON text, or from 0.22.0 as a map)',
    );
  });

  it("a tool's text is written out and read back as it always was: a number past the double range reads as null (#1082)", () => {
    const { trace } = one(request(undefined, [
      span('0000000000000001', 'chat', [kv('gen_ai.operation.name', str('chat')), kv('llm.tools.0.tool.json_schema', str('{"name":"lookup","parameters":{"type":"object","properties":{"order":{"enum":[1e400]}},"required":["order"]}}')), kv('gen_ai.output.messages', str('ok'))]),
    ]));
    expect(trace.tools).toEqual([{ name: 'lookup', inputSchema: { type: 'object', properties: { order: { enum: [null] } }, required: ['order'] } }]);
  });

  it("a model call's OpenInference tools are read in the order of their index, whatever order their attributes came in", () => {
    const { trace } = one(request(undefined, [
      span('0000000000000001', 'chat', [kv('gen_ai.operation.name', str('chat')), kv('llm.tools.7.tool.json_schema', str('{"name":"lookup"}')), kv('llm.tools.2.tool.json_schema', anyOf({ name: 'search' })), kv('gen_ai.output.messages', str('ok'))]),
    ]));
    expect(trace.tools?.map((t) => t.name)).toEqual(['search', 'lookup']);
  });

  it('a message list whose text nests deeper than a JSON text is read to stays the text it is, and one at the limit is read down to its words (#1040)', () => {
    // LangChain's serialized message, its class name inside `arrays` more arrays: `{"messages":[{...,"id":[..., <arrays>]}]}` is four levels around them.
    const serialized = (arrays: number): string =>
      `{"messages":[{"lc":1,"type":"constructor","id":["langchain","schema","messages",${'['.repeat(arrays)}"HumanMessage"${']'.repeat(arrays)}],"kwargs":{"content":"What is the refund window?"}}]}`;
    expect(jsonTextDepth(serialized(MAX_JSON_TEXT_DEPTH - 4), Infinity)).toBe(MAX_JSON_TEXT_DEPTH);
    expect(wordsOf(serialized(0), 'input')).toBe('What is the refund window?');
    expect(wordsOf(serialized(MAX_JSON_TEXT_DEPTH - 4), 'input')).toBe('What is the refund window?');
    // Read as a value past the limit, the role was written out by a function that calls itself once for each level: at a few thousand levels it threw.
    for (const arrays of [MAX_JSON_TEXT_DEPTH - 3, 3_000, 5_000, 200_000]) {
      const text = serialized(arrays);
      expect(wordsOf(text, 'input'), `${arrays} arrays`).toBe(text);
      expect(wordsOf(text, 'output'), `${arrays} arrays`).toBe(text);
    }
    // A list in OpenAI's shape is held to the same limit: `[{"role":...,"content":...}]` is two levels around what its message holds.
    const openai = (arrays: number): string => `[{"role":"user","content":"What is the refund window?","extra":${'['.repeat(arrays)}0${']'.repeat(arrays)}}]`;
    expect(jsonTextDepth(openai(MAX_JSON_TEXT_DEPTH - 2), Infinity)).toBe(MAX_JSON_TEXT_DEPTH);
    expect(wordsOf(openai(MAX_JSON_TEXT_DEPTH - 2), 'input')).toBe('What is the refund window?');
    for (const arrays of [MAX_JSON_TEXT_DEPTH - 1, 3_000, 100_000]) expect(wordsOf(openai(arrays), 'input'), `${arrays} arrays`).toBe(openai(arrays));
  });

  it('one span whose input is such a text does not lose the request: every trace in it is mapped (#1040)', () => {
    const deep = `{"messages":[{"lc":1,"type":"constructor","id":["langchain","schema","messages",${'['.repeat(5_000)}"HumanMessage"${']'.repeat(5_000)}],"kwargs":{"content":"What is the refund window?"}}]}`;
    const other = '6c9f000798038103d269b633813fc60d';
    const mapped = fromOtlp(
      otlpTraceRequestSchema.parse({
        resourceSpans: [
          { resource: { attributes: [kv('service.name', str('ordinary'))] }, scopeSpans: [{ scope: { name: 'x' }, spans: [span('0000000000000001', 'run', [kv('input.value', str('Plan the launch')), kv('output.value', str('Launch plan: three steps.'))])] }] },
          { resource: { attributes: [kv('service.name', str('deep'))] }, scopeSpans: [{ scope: { name: 'x' }, spans: [{ ...span('0000000000000002', 'run', [kv('input.value', str(deep)), kv('gen_ai.output.messages', str(deep)), kv('output.value', str('Fourteen days.'))]), traceId: other }] }] },
        ],
      }),
    );
    expect(mapped.traces.map((t) => t.trace.agent_name).sort()).toEqual(['deep', 'ordinary']);
    expect(mapped.traces.find((t) => t.trace.agent_name === 'deep')?.trace.input).toBe(deep);
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
