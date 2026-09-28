/*
 * What the OpenAI Agents SDK (Python and JavaScript) and LlamaIndex really
 * post through their OpenInference instrumentation, and what Iris reads from
 * it.
 *
 * Each `.pb` beside this test's fixtures is a REAL request body, recorded on
 * 2026-09-28 by tests/fixtures/otlp/capture_recipe.py running the recipe
 * scripts in examples/otel-recipes/ (the lines docs/otel-recipes.md gives)
 * against the scripted model provider, with the versions pinned in
 * examples/otel-recipes/requirements-*.txt and examples/otel-recipes/js/package.json:
 *
 *   openai-agents.pb     openai-agents 0.22.3, openinference-instrumentation-openai-agents 2.5.0
 *   openai-agents-js.pb  @openai/agents 0.18.0, @arizeai/openinference-instrumentation-openai-agents 0.2.15
 *   llamaindex.pb        llama-index-core 0.14.25, llama-index-llms-openai 0.8.2,
 *                        openinference-instrumentation-llama-index 4.5.2
 *
 * One run each: "What is the weather in Paris?", one get_weather call, the
 * answer "It is 18 degrees and sunny in Paris.", two model calls (15 in and
 * 12 out, then 35 in and 8 out). The captures showed four things Iris got
 * wrong, each asserted below:
 *
 *   - the Python Agents SDK puts nothing on its root span, and in start order
 *     the first output was the first model call's — a tool call, as JSON;
 *   - LlamaIndex's workflow steps record Python reprs (`StopEvent(result=…)`)
 *     as input.value / output.value, the root's output among them;
 *   - an app that names no service is `unknown_service:<process>` to every
 *     OTel SDK, and that was taken as the agent's name;
 *   - OpenInference names the agent `agent.name` and the offered tools
 *     `llm.tools.N.tool.json_schema`, neither of which was read;
 *   - its tool arguments are `input.value` JSON (and, for LlamaIndex, the
 *     Python call's `{"kwargs": {...}}`), which valid_tool_arguments checked
 *     as a string and failed.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeExportTraceServiceRequest } from '../../../src/otel/protobuf.js';
import { fromOtlp, isObjectRepr, openInferenceWords, otlpTraceRequestSchema, type OtlpTraceRequest } from '../../../src/otel/ingest.js';
import { toSteps } from '../../../src/eval/steps.js';
import { validToolArguments } from '../../../src/eval/rules/completeness.js';
import type { EvalContext } from '../../../src/types/eval.js';

const dir = resolve(import.meta.dirname, '../../fixtures/otlp');
const CAPTURES = ['openai-agents', 'openai-agents-js', 'llamaindex'] as const;

function load(name: (typeof CAPTURES)[number]) {
  const decoded = decodeExportTraceServiceRequest(new Uint8Array(readFileSync(join(dir, `${name}.pb`))));
  const twin = JSON.parse(readFileSync(join(dir, `${name}.otlp.json`), 'utf8')) as unknown;
  return { decoded, twin, request: otlpTraceRequestSchema.parse(decoded) };
}

function withServiceName(request: OtlpTraceRequest, name: string): OtlpTraceRequest {
  const copy = structuredClone(request);
  const attrs = copy.resourceSpans[0].resource!.attributes!;
  const at = attrs.findIndex((a) => a.key === 'service.name');
  attrs[at] = { key: 'service.name', value: { stringValue: name } };
  return copy;
}

const WEATHER_TOOL = {
  name: 'get_weather',
  inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
};

describe.each(CAPTURES)('%s, as its OpenInference instrumentation exports it', (name) => {
  const { decoded, twin, request } = load(name);
  const mapped = fromOtlp(request);

  it('decodes to exactly its OTLP/JSON twin', () => {
    expect(decoded).toEqual(twin);
  });

  it('is one trace with its agent, words, usage, estimated cost, model and session, and nothing lacked', () => {
    expect(mapped.traces).toHaveLength(1);
    const { trace, lacked } = mapped.traces[0];
    expect(lacked).toEqual([]);
    expect(trace.agent_name).toBe('weather-agent');
    expect(trace.input).toBe('What is the weather in Paris?');
    expect(trace.output).toBe('It is 18 degrees and sunny in Paris.');
    // Two model calls: 15 in and 12 out for the tool request, 35 in and 8 out for the answer.
    expect(trace.token_usage).toEqual({ prompt_tokens: 50, completion_tokens: 20, total_tokens: 70 });
    // OpenInference records no cost; the door estimates one from the tokens and the model, marked estimated:
    // 50 x $0.15 + 20 x $0.60 per million gpt-4o-mini tokens.
    expect(trace.cost_usd).toBeCloseTo(0.0000195, 12);
    expect(trace.cost_source).toBe('estimated');
    expect(trace.cost_estimate).toMatchObject({ status: 'estimated', calls: [{ priced_as: 'gpt-4o-mini', prompt_tokens: 50, completion_tokens: 20 }] });
    expect(trace.metadata?.model).toBe('gpt-4o-mini');
    expect(trace.session_id).toBe('session-paris-1');
    expect(trace.source).toBe('otel');
  });

  it('the tool call is a step, and the tool offered to the model is the catalogue valid_tool_arguments checks against', () => {
    const { trace } = mapped.traces[0];
    expect(toSteps({ spans: trace.spans }).map((s) => [s.name, s.status])).toEqual([['get_weather', 'ok']]);
    expect(trace.tools).toHaveLength(1);
    expect(trace.tools![0]).toMatchObject(WEATHER_TOOL);
    expect(trace.tools![0].description).toMatch(/The current weather for a city\./);
  });

  it('the call is checked against that catalogue and passes: its arguments are read as the object they are', () => {
    const { trace } = mapped.traces[0];
    const steps = toSteps({ spans: trace.spans });
    expect(steps.map((s) => s.input)).toEqual([{ city: 'Paris' }]);
    const result = validToolArguments.evaluate({ output: trace.output!, spans: trace.spans, tools: trace.tools } as EvalContext);
    expect(result.skipped ?? false).toBe(false);
    expect(result.passed, result.message).toBe(true);
  });

  it('two model calls are LLM spans and the tool is a TOOL span', () => {
    const spans = mapped.traces[0].trace.spans!;
    expect(spans.filter((s) => s.kind === 'TOOL').map((s) => s.attributes?.['tool.name'])).toEqual(['get_weather']);
    const answering = spans.filter((s) => s.kind === 'LLM' && s.attributes?.['llm.token_count.prompt'] !== undefined);
    expect(answering).toHaveLength(2);
  });
});

describe('what each capture needed', () => {
  it('openai-agents (Python): the root carries no words, and the output is the call that ended last — not the first, which was a tool call', () => {
    const { request } = load('openai-agents');
    const spans = request.resourceSpans[0].scopeSpans![0].spans as Array<{ parentSpanId?: string; name: string; attributes?: Array<{ key: string }> }>;
    const root = spans.find((s) => !s.parentSpanId)!;
    expect(root.attributes?.some((a) => a.key === 'input.value' || a.key === 'output.value')).toBe(false);
    const { trace } = fromOtlp(request).traces[0];
    expect(trace.output).not.toMatch(/function_call/);
  });

  it('openai-agents (Python): with no service named, the agent is the one the spans name', () => {
    const { request } = load('openai-agents');
    const { trace, lacked } = fromOtlp(withServiceName(request, 'unknown_service:python.exe')).traces[0];
    expect(trace.agent_name).toBe('Weather agent');
    expect(lacked).toEqual([]);
  });

  it("openai-agents (JavaScript): the root carries the run's input and final output, and with no service named the answer says so — this instrumentor writes no agent.name", () => {
    const { request } = load('openai-agents-js');
    const spans = request.resourceSpans[0].scopeSpans![0].spans as Array<{ parentSpanId?: string; attributes?: Array<{ key: string; value?: { stringValue?: string } }> }>;
    const root = spans.find((s) => !s.parentSpanId)!;
    expect(root.attributes?.find((a) => a.key === 'output.value')?.value?.stringValue).toBe('It is 18 degrees and sunny in Paris.');
    const { trace, lacked } = fromOtlp(withServiceName(request, 'unknown_service:node')).traces[0];
    expect(trace.agent_name).toBe('otel');
    expect(lacked).toHaveLength(1);
    expect(lacked[0]).toMatch(/^service\.name/);
  });

  it('llamaindex: the root output is a Python repr, passed over for the model\'s own answer', () => {
    const { request } = load('llamaindex');
    const spans = request.resourceSpans[0].scopeSpans![0].spans as Array<{ parentSpanId?: string; attributes?: Array<{ key: string; value?: { stringValue?: string } }> }>;
    const root = spans.find((s) => !s.parentSpanId)!;
    const rootOutput = root.attributes?.find((a) => a.key === 'output.value')?.value?.stringValue;
    expect(rootOutput).toMatch(/^StopEvent\(result=AgentOutput\(/);
    expect(isObjectRepr(rootOutput!)).toBe(true);
    expect(fromOtlp(request).traces[0].trace.output).toBe('It is 18 degrees and sunny in Paris.');
  });

  it('llamaindex: an app that names no service is not named "unknown_service" — it is unnamed, and the answer says so', () => {
    const { request } = load('llamaindex');
    const { trace, lacked } = fromOtlp(withServiceName(request, 'unknown_service:python.exe')).traces[0];
    expect(trace.agent_name).toBe('otel');
    expect(lacked).toHaveLength(1);
    expect(lacked[0]).toMatch(/^service\.name/);
    // A service somebody did name is the agent, whatever it is called.
    expect(fromOtlp(withServiceName(request, 'unknown-service-desk')).traces[0].trace.agent_name).toBe('unknown-service-desk');
  });
});

describe('the readers the captures needed', () => {
  const toolSpan = (attributes: Record<string, unknown>) => ({
    span_id: 's1',
    trace_id: 't1',
    name: 'get_weather',
    kind: 'TOOL' as const,
    status_code: 'OK' as const,
    start_time: '2026-09-28T00:00:00.000Z',
    attributes: { 'tool.name': 'get_weather', ...attributes },
  });
  const argsOf = (attributes: Record<string, unknown>) => toSteps({ spans: [toolSpan(attributes)] })[0].input;

  it("a tool span's input.value is JSON only when its mime type says so, and a Python call's keyword arguments are the arguments", () => {
    expect(argsOf({ 'input.value': '{"city":"Paris"}', 'input.mime_type': 'application/json' })).toEqual({ city: 'Paris' });
    expect(argsOf({ 'input.value': '{"kwargs": {"city": "Paris"}}', 'input.mime_type': 'application/json' })).toEqual({ city: 'Paris' });
    expect(argsOf({ 'input.value': '{"args": [], "kwargs": {"city": "Paris"}}', 'input.mime_type': 'application/json' })).toEqual({ city: 'Paris' });
    // Positional arguments cannot be named, so the capture stays as sent; so does an object that merely has a kwargs field.
    expect(argsOf({ 'input.value': '{"args": ["Paris"], "kwargs": {}}', 'input.mime_type': 'application/json' })).toEqual({ args: ['Paris'], kwargs: {} });
    expect(argsOf({ 'input.value': '{"kwargs": {"a": 1}, "city": "Paris"}', 'input.mime_type': 'application/json' })).toEqual({ kwargs: { a: 1 }, city: 'Paris' });
    // Text, or JSON-looking text the span does not call JSON, is the text.
    expect(argsOf({ 'input.value': '{"city":"Paris"}', 'input.mime_type': 'text/plain' })).toBe('{"city":"Paris"}');
    expect(argsOf({ 'input.value': '{"city":"Paris"}' })).toBe('{"city":"Paris"}');
    expect(argsOf({ 'input.value': '{not json', 'input.mime_type': 'application/json' })).toBe('{not json');
  });

  it('an object repr is recognised; words, JSON and parenthesised prose are not', () => {
    expect(isObjectRepr("StopEvent(result=AgentOutput(response='x'))")).toBe(true);
    expect(isObjectRepr('AgentWorkflowStartEvent()')).toBe(true);
    // OpenInference cuts a long repr off at 200 characters with an ellipsis.
    expect(isObjectRepr("AgentOutput(response=ChatMessage(role=<MessageRole.ASSISTANT: 'assistant'>, blocks=[TextBl...")).toBe(true);
    expect(isObjectRepr("  ToolCallResult(tool_name='get_weather', tool_id='call_1')\n")).toBe(true);
    expect(isObjectRepr('It is 18 degrees and sunny in Paris.')).toBe(false);
    expect(isObjectRepr('Paris (France) is sunny.')).toBe(false);
    expect(isObjectRepr('Summary (three points)')).toBe(false);
    expect(isObjectRepr('{"topic":"Q4 launch"}')).toBe(false);
    expect(isObjectRepr('f(x=1) is the call')).toBe(false);
    expect(isObjectRepr('Wait for it...')).toBe(false);
  });

  it('past the root, the output is read from the span that ended last, whatever order they started in', () => {
    const span = (spanId: string, parentSpanId: string | undefined, start: number, end: number, output?: string) => ({
      traceId: 'ab'.repeat(16),
      spanId,
      ...(parentSpanId ? { parentSpanId } : {}),
      name: spanId,
      startTimeUnixNano: String(BigInt(start) * 1_000_000_000n),
      endTimeUnixNano: String(BigInt(end) * 1_000_000_000n),
      attributes: output === undefined ? [] : [{ key: 'output.value', value: { stringValue: output } }],
    });
    const request = otlpTraceRequestSchema.parse({
      resourceSpans: [{ resource: { attributes: [{ key: 'service.name', value: { stringValue: 'svc' } }] }, scopeSpans: [{ spans: [
        span('0000000000000001', undefined, 1_790_000_000, 1_790_000_010),
        span('0000000000000002', '0000000000000001', 1_790_000_001, 1_790_000_009, 'the final answer'),
        span('0000000000000003', '0000000000000001', 1_790_000_002, 1_790_000_003, 'an early step'),
      ] }] }],
    });
    expect(fromOtlp(request).traces[0].trace.output).toBe('the final answer');
  });

  it('OpenInference messages: the last user message in, the last assistant message with words out, from any starting index', () => {
    const attrs = {
      'llm.input_messages.1.message.role': 'user',
      'llm.input_messages.1.message.content': 'What is the weather in Paris?',
      'llm.input_messages.2.message.role': 'assistant',
      'llm.input_messages.2.message.tool_calls.0.tool_call.function.name': 'get_weather',
      'llm.input_messages.3.message.role': 'tool',
      'llm.input_messages.3.message.content': '18 degrees',
      'llm.output_messages.0.message.role': 'assistant',
      'llm.output_messages.0.message.contents.0.message_content.type': 'text',
      'llm.output_messages.0.message.contents.0.message_content.text': 'It is 18 degrees',
      'llm.output_messages.0.message.contents.1.message_content.text': 'and sunny.',
    };
    expect(openInferenceWords(attrs, 'input')).toBe('What is the weather in Paris?');
    expect(openInferenceWords(attrs, 'output')).toBe('It is 18 degrees\nand sunny.');
    // An answer that is only a tool call has no words; the index ordering is numeric, not lexical.
    expect(openInferenceWords({ 'llm.output_messages.0.message.role': 'assistant', 'llm.output_messages.0.message.content': '' }, 'output')).toBeUndefined();
    const many = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [[`llm.input_messages.${i}.message.role`, 'user'], [`llm.input_messages.${i}.message.content`, `ask ${i}`]]).flat());
    expect(openInferenceWords(many, 'input')).toBe('ask 11');
    expect(openInferenceWords({}, 'input')).toBeUndefined();
  });
});
