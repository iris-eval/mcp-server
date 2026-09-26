/*
 * What LangSmith's OpenTelemetry export really posts for a LangGraph run,
 * and what Iris reads from it.
 *
 * `tests/fixtures/otlp/langsmith-langgraph.pb` is a REAL request body:
 * langsmith 0.14.1 (with opentelemetry-sdk and
 * opentelemetry-exporter-otlp-proto-http 1.45.0, protobuf 7.36.2) exporting
 * the scripted LangGraph tool loop in packages/python/tests/langgraph_app.py
 * (langgraph 1.2.12, langchain-core 1.6.5), recorded on 2026-09-26 by
 * tests/fixtures/otlp/capture_langsmith.py. The authored `langsmith.otlp.json`
 * in conventions/ follows LangSmith's documentation; this one is the wire, and
 * it differs in two ways Iris used to get wrong:
 *
 *   - `gen_ai.prompt` / `gen_ai.completion` arrive as bytesValue (UTF-8 JSON),
 *     which OTLP/JSON writes as base64: the trace's input and output were base64;
 *   - that JSON is the graph's whole state (`{"messages": [...]}`) or a model
 *     result (`{"generations": ...}`), not the words asked and answered.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeExportTraceServiceRequest } from '../../../src/otel/protobuf.js';
import { bytesText, fromOtlp, otlpTraceRequestSchema, wordsOf } from '../../../src/otel/ingest.js';
import { toSteps } from '../../../src/eval/steps.js';

const dir = resolve(import.meta.dirname, '../../fixtures/otlp');
const pb = new Uint8Array(readFileSync(join(dir, 'langsmith-langgraph.pb')));
const twin = JSON.parse(readFileSync(join(dir, 'langsmith-langgraph.otlp.json'), 'utf8')) as unknown;

describe('a LangGraph run as LangSmith exports it', () => {
  const decoded = decodeExportTraceServiceRequest(pb);
  const mapped = fromOtlp(otlpTraceRequestSchema.parse(decoded));

  it('decodes to exactly its OTLP/JSON twin', () => {
    expect(decoded).toEqual(twin);
  });

  it('is one trace, read down to what was asked and what was answered', () => {
    expect(mapped.traces).toHaveLength(1);
    const { trace, lacked } = mapped.traces[0];
    expect(lacked).toEqual([]);
    expect(trace.agent_name).toBe('weather-graph');
    expect(trace.input).toBe('What is the weather in Paris?');
    expect(trace.output).toBe('It is 18 degrees and sunny in Paris.');
    // Two model calls: 10 in and 12 out for the tool request, 30 in and 8 out for the answer.
    expect(trace.token_usage).toEqual({ prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 });
    expect((trace.metadata as { model?: string }).model).toBe('scripted-model');
    expect(trace.spans).toHaveLength(9);
  });

  it('the tool call is a step, named and linked to the model request by its call id', () => {
    const steps = toSteps({ spans: mapped.traces[0].trace.spans });
    expect(steps.map((s) => [s.name, s.callId, s.status])).toEqual([['get_weather', 'call_weather_1', 'ok']]);
  });
});

describe('the readers the capture needed', () => {
  it('bytes that are UTF-8 text are that text; binary and non-base64 stay as sent', () => {
    expect(bytesText(Buffer.from('{"a":"héllo"}').toString('base64'))).toBe('{"a":"héllo"}');
    const binary = Buffer.from([0, 1, 2, 255, 254]).toString('base64');
    expect(bytesText(binary)).toBe(binary);
    expect(bytesText('not base64 at all!')).toBe('not base64 at all!');
    expect(bytesText('')).toBe('');
  });

  it('a LangChain envelope is read down to its words; anything else is returned as it came', () => {
    const state = JSON.stringify({ messages: [{ type: 'human', content: 'Hi' }, { type: 'ai', content: '' , tool_calls: [{ name: 't' }] }, { type: 'tool', content: '18C' }, { type: 'ai', content: [{ type: 'text', text: 'It is 18C.' }] }] });
    expect(wordsOf(state, 'input')).toBe('Hi');
    expect(wordsOf(state, 'output')).toBe('It is 18C.');
    const constructor = JSON.stringify({ messages: [[{ lc: 1, type: 'constructor', id: ['langchain', 'schema', 'messages', 'HumanMessage'], kwargs: { content: 'Weather?' } }]] });
    expect(wordsOf(constructor, 'input')).toBe('Weather?');
    const generations = JSON.stringify({ generations: [[{ text: 'Sunny.', message: { lc: 1, type: 'constructor', id: ['langchain', 'schema', 'messages', 'AIMessage'], kwargs: { content: 'Sunny.' } } }]] });
    expect(wordsOf(generations, 'output')).toBe('Sunny.');
    // A bare message array (gen_ai.input.messages) and other JSON are left alone.
    const bare = JSON.stringify([{ role: 'user', content: 'Hi' }]);
    expect(wordsOf(bare, 'input')).toBe(bare);
    expect(wordsOf('{"topic":"Q4"}', 'input')).toBe('{"topic":"Q4"}');
    expect(wordsOf('{"messages": [', 'input')).toBe('{"messages": [');
    expect(wordsOf('plain words', 'output')).toBe('plain words');
  });
});
