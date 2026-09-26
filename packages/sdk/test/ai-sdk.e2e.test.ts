/*
 * irisMiddleware, end to end: the `ai` package's own generateText and
 * streamText over a model wrapped with the middleware, the model being the
 * AI SDK's scripted MockLanguageModelV4, and each model call read back from
 * a real Iris server with its input, output, usage, tool calls and verdict.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { generateText, jsonSchema, stepCountIs, streamText, tool, wrapLanguageModel } from 'ai';
import { MockLanguageModelV4, convertArrayToReadableStream } from 'ai/test';
import { IrisRecorder, irisMiddleware } from '../src/index.js';
import { REPLIES, startIris, type Iris } from './helpers.js';

let iris: Iris;
let recorder: IrisRecorder;
before(async () => {
  iris = await startIris();
  recorder = new IrisRecorder({ url: iris.url, apiKey: iris.apiKey, flushIntervalMs: 10 });
});
after(async () => {
  await recorder?.shutdown();
  await iris?.stop();
});

const usage = (input: number, output: number) => ({
  inputTokens: { total: input, noCache: input, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: output, text: output, reasoning: undefined },
});
const finish = (unified: 'stop' | 'tool-calls', raw: string) => ({ unified, raw });

describe('irisMiddleware', () => {
  it('generateText: each model call of a tool loop is a trace — the tool request, then the answer that used it', async () => {
    let call = 0;
    const model = new MockLanguageModelV4({
      provider: 'scripted.chat',
      modelId: 'scripted-model',
      doGenerate: async () => {
        call += 1;
        return call === 1
          ? { content: [{ type: 'tool-call', toolCallId: 'call_1', toolName: 'get_weather', input: '{"city":"Paris"}' }], finishReason: finish('tool-calls', 'tool_calls'), usage: usage(10, 12), warnings: [], response: { id: 'resp_1', modelId: 'scripted-model-2026' } }
          : { content: [{ type: 'text', text: REPLIES.afterTool }], finishReason: finish('stop', 'stop'), usage: usage(30, 8), warnings: [], response: { id: 'resp_2', modelId: 'scripted-model-2026' } };
      },
    });
    const wrapped = wrapLanguageModel({ model, middleware: irisMiddleware({ recorder, agentName: 'ai-sdk-e2e', sessionId: 'conv-1' }) });
    const n = recorder.results.length;
    const result = await generateText({
      model: wrapped,
      system: 'You are a weather bot.',
      prompt: 'What is the weather in Paris?',
      tools: { get_weather: tool({ description: 'The weather in a city', inputSchema: jsonSchema<{ city: string }>({ type: 'object', properties: { city: { type: 'string' } }, required: ['city'] }), execute: async () => '18C, sunny' }) },
      stopWhen: stepCountIs(3),
    });
    assert.equal(result.text, REPLIES.afterTool);
    await recorder.flush();
    const entries = recorder.results.slice(n);
    assert.equal(entries.length, 2);

    const first = await iris.trace(entries[0].trace_id);
    assert.equal(first.trace.agent_name, 'ai-sdk-e2e');
    assert.equal(first.trace.session_id, 'conv-1');
    assert.equal(first.trace.input, 'What is the weather in Paris?');
    assert.equal(first.trace.output, JSON.stringify([{ tool: 'get_weather', arguments: { city: 'Paris' } }]));
    assert.deepEqual(first.trace.token_usage, { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 });
    assert.deepEqual(first.trace.tools.map((t: { name: string }) => t.name), ['get_weather']);
    assert.equal(first.spans[0].attributes['gen_ai.provider.name'], 'scripted');
    assert.equal(first.spans[0].attributes['gen_ai.response.model'], 'scripted-model-2026');
    assert.deepEqual(JSON.parse(String(first.spans[0].attributes['gen_ai.system_instructions'])), [{ type: 'text', content: 'You are a weather bot.' }]);

    const second = await iris.trace(entries[1].trace_id);
    assert.equal(second.trace.output, REPLIES.afterTool);
    assert.deepEqual(second.trace.token_usage, { prompt_tokens: 30, completion_tokens: 8, total_tokens: 38 });
    const input = JSON.parse(String(second.spans[0].attributes['gen_ai.input.messages']));
    assert.deepEqual(input.map((m: { role: string }) => m.role), ['user', 'assistant', 'tool']);
    assert.deepEqual(input[2].parts[0], { type: 'tool_call_response', id: 'call_1', response: '18C, sunny' });
    for (const e of entries) {
      assert.ok(e.evaluation, 'every call has a verdict');
      assert.equal(e.evaluation.verdict?.state, 'pass');
      assert.equal((await iris.trace(e.trace_id)).evals.length, 1);
    }
  });

  it('streamText: the stream reaches the caller part for part and is recorded when it ends', async () => {
    const model = new MockLanguageModelV4({
      provider: 'scripted.chat',
      modelId: 'scripted-model',
      doStream: async () => ({
        stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] },
          { type: 'response-metadata', id: 'resp_s', modelId: 'scripted-model' },
          { type: 'text-start', id: 't' },
          ...REPLIES.ssn.split(' ').map((w, i, all) => ({ type: 'text-delta' as const, id: 't', delta: i < all.length - 1 ? `${w} ` : w })),
          { type: 'text-end', id: 't' },
          { type: 'finish', finishReason: finish('stop', 'stop'), usage: usage(10, 4) },
        ]),
      }),
    });
    const n = recorder.results.length;
    const result = streamText({ model: wrapLanguageModel({ model, middleware: irisMiddleware({ recorder, agentName: 'ai-sdk-e2e' }) }), prompt: 'What is her SSN?' });
    let text = '';
    for await (const delta of result.textStream) text += delta;
    assert.equal(text, REPLIES.ssn);
    await recorder.flush();
    assert.equal(recorder.results.length, n + 1);
    const entry = recorder.results[n];
    assert.equal(entry.evaluation?.verdict?.state, 'fail');
    const { trace } = await iris.trace(entry.trace_id);
    assert.equal(trace.output, REPLIES.ssn);
    assert.deepEqual(trace.token_usage, { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 });
  });

  it('a model error reaches the caller unchanged and is recorded as an error', async () => {
    const model = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('scripted model failure');
      },
    });
    const n = recorder.results.length;
    await assert.rejects(generateText({ model: wrapLanguageModel({ model, middleware: irisMiddleware({ recorder, agentName: 'ai-sdk-e2e' }) }), prompt: 'hi', maxRetries: 0 }), /scripted model failure/);
    await recorder.flush();
    const entry = recorder.results[n];
    assert.equal(entry.evaluation, null);
    const { spans } = await iris.trace(entry.trace_id);
    assert.equal(spans[0].status_code, 'ERROR');
    assert.equal(spans[0].status_message, 'scripted model failure');
  });
});
