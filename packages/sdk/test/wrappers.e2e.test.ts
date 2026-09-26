/*
 * The wrappers, end to end: the official `openai` and `@anthropic-ai/sdk`
 * clients, wrapped, calling the scripted provider; the recorder sending to
 * a real Iris server; and each call read back from Iris as a trace with its
 * input, output, token usage, spans and verdict.
 *
 * Every provider surface a caller reaches for is driven — a plain call, a
 * stream, the SDK's stream helper, a tool call and its follow-up, and a
 * refused call — because each takes a different path through the SDK and
 * the wrapper has to see all of them.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import OpenAI from 'openai';
import Anthropic from '@anthropic-ai/sdk';
import { IrisRecorder, wrapAnthropic, wrapOpenAI, type StoredTrace } from '../src/index.js';
import { REPLIES, startIris, startProvider, type Iris, type Provider } from './helpers.js';

let iris: Iris;
let provider: Provider;
let recorder: IrisRecorder;

before(async () => {
  [iris, provider] = await Promise.all([startIris(), startProvider()]);
  recorder = new IrisRecorder({ url: iris.url, apiKey: iris.apiKey, flushIntervalMs: 10 });
});
after(async () => {
  await recorder?.shutdown();
  await Promise.all([iris?.stop(), provider?.close()]);
});

const openai = () => wrapOpenAI(new OpenAI({ apiKey: 'scripted', baseURL: `${provider.url}/v1`, maxRetries: 0 }), { recorder, agentName: 'openai-e2e' });
const anthropic = () => wrapAnthropic(new Anthropic({ apiKey: 'scripted', baseURL: provider.url, maxRetries: 0 }), { recorder, agentName: 'anthropic-e2e' });

/** Send what the call recorded and return what Iris stored for it — exactly one trace. */
async function stored(before: number): Promise<StoredTrace> {
  await recorder.flush();
  assert.equal(recorder.results.length, before + 1, `one trace for one call (had ${before}, now ${recorder.results.length}); dropped ${recorder.stats.dropped}`);
  return recorder.results[recorder.results.length - 1];
}

interface Expect {
  agent: string;
  input: string;
  output: string;
  inputTokens: number;
  outputTokens: number;
  provider: 'openai' | 'anthropic';
  verdict: 'pass' | 'fail';
}

/** Read the trace back from Iris and hold it to what the call was. */
async function check(entry: StoredTrace, e: Expect) {
  assert.deepEqual(entry.lacked, []);
  assert.ok(entry.evaluation, 'the OTLP answer carries the evaluation');
  assert.equal(entry.evaluation.verdict?.state, e.verdict);
  const { trace, spans, evals } = await iris.trace(entry.trace_id);
  assert.equal(trace.agent_name, e.agent);
  assert.equal(trace.source, 'otel');
  assert.equal(trace.input, e.input);
  assert.equal(trace.output, e.output);
  assert.deepEqual(trace.token_usage, { prompt_tokens: e.inputTokens, completion_tokens: e.outputTokens, total_tokens: e.inputTokens + e.outputTokens });
  assert.ok(typeof trace.latency_ms === 'number' && trace.latency_ms >= 0);
  assert.equal(spans.length, 1);
  assert.equal(spans[0].kind, 'LLM');
  assert.equal(spans[0].status_code, 'OK');
  assert.equal(spans[0].attributes['gen_ai.provider.name'], e.provider);
  assert.equal(spans[0].attributes['gen_ai.operation.name'], 'chat');
  assert.ok(String(spans[0].attributes['gen_ai.input.messages']).includes(e.input.split(' ')[0]));
  // The evaluation is stored and linked to the trace, as every evaluate-on-write door stores it.
  assert.equal(evals.length, 1);
  assert.equal(evals[0].id, entry.evaluation.id);
  return { trace, spans };
}

describe('wrapOpenAI — Chat Completions', () => {
  it('a plain call arrives with its input, output, usage and a pass', async () => {
    const n = recorder.results.length;
    const res = await openai().chat.completions.create({ model: 'gpt-scripted', messages: [{ role: 'user', content: 'What is the capital of France?' }] });
    assert.equal(res.choices[0].message.content, REPLIES.default);
    const { spans } = await check(await stored(n), { agent: 'openai-e2e', input: 'What is the capital of France?', output: REPLIES.default, inputTokens: 10, outputTokens: 6, provider: 'openai', verdict: 'pass' });
    assert.equal(spans[0].attributes['gen_ai.response.id'], res.id);
    assert.equal(spans[0].attributes['gen_ai.request.model'], 'gpt-scripted');
    assert.deepEqual(spans[0].attributes['gen_ai.response.finish_reasons'], ['stop']);
  });

  it('an answer that leaks an SSN is failed', async () => {
    const n = recorder.results.length;
    await openai().chat.completions.create({ model: 'gpt-scripted', messages: [{ role: 'system', content: 'You are a clerk.' }, { role: 'user', content: 'What is her SSN?' }] });
    const entry = await stored(n);
    await check(entry, { agent: 'openai-e2e', input: 'What is her SSN?', output: REPLIES.ssn, inputTokens: 15, outputTokens: 4, provider: 'openai', verdict: 'fail' });
    assert.ok(entry.evaluation?.rule_results.some((r) => r.ruleName === 'no_pii' && r.passed === false));
  });

  it('a stream reaches the caller chunk for chunk as it would unwrapped, and is recorded with its usage', async () => {
    const ask = { model: 'gpt-scripted', messages: [{ role: 'user' as const, content: 'What is the capital of France?' }], stream: true as const };
    const plain = new OpenAI({ apiKey: 'scripted', baseURL: `${provider.url}/v1`, maxRetries: 0 });
    const unwrapped = [];
    for await (const chunk of await plain.chat.completions.create(ask)) unwrapped.push(chunk);

    const n = recorder.results.length;
    const seen = [];
    for await (const chunk of await openai().chat.completions.create(ask)) seen.push(chunk);
    // The wrapper asked for usage the caller did not; the usage-only chunk it brought is not passed on.
    assert.equal(seen.length, unwrapped.length);
    assert.ok(seen.every((c) => c.choices.length === 1));
    assert.deepEqual(
      seen.map((c) => c.choices[0].delta.content ?? null),
      unwrapped.map((c) => c.choices[0].delta.content ?? null),
    );
    const sent = provider.requests[provider.requests.length - 1].body;
    assert.deepEqual(sent.stream_options, { include_usage: true });
    await check(await stored(n), { agent: 'openai-e2e', input: 'What is the capital of France?', output: REPLIES.default, inputTokens: 10, outputTokens: 6, provider: 'openai', verdict: 'pass' });
  });

  it('a stream that asked for usage itself gets the usage chunk, untouched', async () => {
    const n = recorder.results.length;
    const seen = [];
    for await (const chunk of await openai().chat.completions.create({ model: 'gpt-scripted', messages: [{ role: 'user', content: 'What is the capital of France?' }], stream: true, stream_options: { include_usage: true } })) seen.push(chunk);
    assert.equal(seen[seen.length - 1].choices.length, 0);
    assert.equal(seen[seen.length - 1].usage?.total_tokens, 16);
    await check(await stored(n), { agent: 'openai-e2e', input: 'What is the capital of France?', output: REPLIES.default, inputTokens: 10, outputTokens: 6, provider: 'openai', verdict: 'pass' });
  });

  it('the stream helper is recorded', async () => {
    const n = recorder.results.length;
    const stream = openai().chat.completions.stream({ model: 'gpt-scripted', messages: [{ role: 'user', content: 'What is the capital of France?' }] });
    const final = await stream.finalChatCompletion();
    assert.equal(final.choices[0].message.content, REPLIES.default);
    await check(await stored(n), { agent: 'openai-e2e', input: 'What is the capital of France?', output: REPLIES.default, inputTokens: 10, outputTokens: 6, provider: 'openai', verdict: 'pass' });
  });

  it('parse is recorded', async () => {
    const n = recorder.results.length;
    const parsed = await openai().chat.completions.parse({ model: 'gpt-scripted', messages: [{ role: 'user', content: 'What is the capital of France?' }] });
    assert.equal(parsed.choices[0].message.content, REPLIES.default);
    await check(await stored(n), { agent: 'openai-e2e', input: 'What is the capital of France?', output: REPLIES.default, inputTokens: 10, outputTokens: 6, provider: 'openai', verdict: 'pass' });
  });

  it('runTools: each model call of the loop is recorded — the tool request, then the answer that used its result', async () => {
    const n = recorder.results.length;
    const runner = openai().chat.completions.runTools({
      model: 'gpt-scripted',
      messages: [{ role: 'user', content: 'What is the weather in Paris?' }],
      tools: [
        {
          type: 'function',
          function: { name: 'get_weather', description: 'The weather in a city', parameters: { type: 'object', properties: { city: { type: 'string' } } }, function: (args: { city: string }) => `18C, sunny in ${args.city}`, parse: JSON.parse },
        },
      ],
    });
    assert.equal(await runner.finalContent(), REPLIES.afterTool);
    await recorder.flush();
    const entries = recorder.results.slice(n);
    assert.equal(entries.length, 2);
    const [asked, answered] = await Promise.all(entries.map((e) => iris.trace(e.trace_id)));
    assert.equal(asked.trace.output, JSON.stringify([{ tool: 'get_weather', arguments: { city: 'Paris' } }]));
    assert.equal(answered.trace.output, REPLIES.afterTool);
    const input = JSON.parse(String(answered.spans[0].attributes['gen_ai.input.messages']));
    assert.deepEqual(input[2].parts[0].response, '18C, sunny in Paris');
  });

  it('a tool call and its follow-up are two traces: the call names the tool, the follow-up answers with its result', async () => {
    const tools = [{ type: 'function' as const, function: { name: 'get_weather', description: 'The weather in a city', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }];
    const client = openai();
    const n = recorder.results.length;
    const first = await client.chat.completions.create({ model: 'gpt-scripted', tools, messages: [{ role: 'user', content: 'What is the weather in Paris?' }] });
    const call = first.choices[0].message.tool_calls?.[0];
    assert.ok(call && call.type === 'function');
    const asked = await stored(n);
    const { trace, spans } = await iris.trace(asked.trace_id);
    assert.equal(trace.output, JSON.stringify([{ tool: 'get_weather', arguments: { city: 'Paris' } }]));
    assert.deepEqual(trace.tools?.map((t: { name: string }) => t.name), ['get_weather']);
    assert.deepEqual(spans[0].attributes['gen_ai.response.finish_reasons'], ['tool_calls']);
    const output = JSON.parse(String(spans[0].attributes['gen_ai.output.messages']));
    assert.deepEqual(output[0].parts[0], { type: 'tool_call', id: call.id, name: 'get_weather', arguments: { city: 'Paris' } });
    assert.equal(output[0].finish_reason, 'tool_call');

    await client.chat.completions.create({
      model: 'gpt-scripted',
      tools,
      messages: [
        { role: 'user', content: 'What is the weather in Paris?' },
        first.choices[0].message,
        { role: 'tool', tool_call_id: call.id, content: '18C, sunny' },
      ],
    });
    await check(await stored(n + 1), { agent: 'openai-e2e', input: 'What is the weather in Paris?', output: REPLIES.afterTool, inputTokens: 30, outputTokens: 8, provider: 'openai', verdict: 'pass' });
  });

  it('a refused call throws the provider\'s own error and is recorded as an error with no verdict', async () => {
    const n = recorder.results.length;
    await assert.rejects(
      openai().chat.completions.create({ model: 'gpt-scripted', messages: [{ role: 'user', content: 'Trigger a provider error.' }] }),
      (err: unknown) => err instanceof OpenAI.BadRequestError && err.status === 400 && /scripted provider refused/.test(err.message),
    );
    const entry = await stored(n);
    assert.equal(entry.evaluation, null);
    const { trace, spans } = await iris.trace(entry.trace_id);
    assert.equal(trace.output ?? null, null);
    assert.equal(spans[0].status_code, 'ERROR');
    assert.equal(spans[0].attributes['error.type'], '400');
    assert.match(String(spans[0].status_message), /scripted provider refused/);
  });
});

describe('wrapOpenAI — Responses', () => {
  it('a plain call', async () => {
    const n = recorder.results.length;
    const res = await openai().responses.create({ model: 'gpt-scripted', instructions: 'Answer briefly.', input: 'What is the capital of France?' });
    assert.equal(res.output_text, REPLIES.default);
    const { spans } = await check(await stored(n), { agent: 'openai-e2e', input: 'What is the capital of France?', output: REPLIES.default, inputTokens: 15, outputTokens: 6, provider: 'openai', verdict: 'pass' });
    assert.deepEqual(JSON.parse(String(spans[0].attributes['gen_ai.system_instructions'])), [{ type: 'text', content: 'Answer briefly.' }]);
  });

  it('a stream, and the stream helper', async () => {
    let n = recorder.results.length;
    let text = '';
    for await (const event of await openai().responses.create({ model: 'gpt-scripted', input: 'What is her SSN?', stream: true })) {
      if (event.type === 'response.output_text.delta') text += event.delta;
    }
    assert.equal(text, REPLIES.ssn);
    await check(await stored(n), { agent: 'openai-e2e', input: 'What is her SSN?', output: REPLIES.ssn, inputTokens: 10, outputTokens: 4, provider: 'openai', verdict: 'fail' });

    n = recorder.results.length;
    const final = await openai().responses.stream({ model: 'gpt-scripted', input: 'What is the capital of France?' }).finalResponse();
    assert.equal(final.output_text, REPLIES.default);
    await check(await stored(n), { agent: 'openai-e2e', input: 'What is the capital of France?', output: REPLIES.default, inputTokens: 10, outputTokens: 6, provider: 'openai', verdict: 'pass' });
  });
});

describe('wrapAnthropic — Messages', () => {
  it('a plain call, with the system prompt kept apart', async () => {
    const n = recorder.results.length;
    const res = await anthropic().messages.create({ model: 'claude-scripted', max_tokens: 256, system: 'You are terse.', messages: [{ role: 'user', content: 'What is the capital of France?' }] });
    assert.equal(res.content[0].type === 'text' && res.content[0].text, REPLIES.default);
    const { spans } = await check(await stored(n), { agent: 'anthropic-e2e', input: 'What is the capital of France?', output: REPLIES.default, inputTokens: 15, outputTokens: 6, provider: 'anthropic', verdict: 'pass' });
    assert.equal(spans[0].attributes['gen_ai.request.max_tokens'], 256);
    assert.deepEqual(spans[0].attributes['gen_ai.response.finish_reasons'], ['end_turn']);
    assert.deepEqual(JSON.parse(String(spans[0].attributes['gen_ai.system_instructions'])), [{ type: 'text', content: 'You are terse.' }]);
  });

  it('stream: true, and the stream helper', async () => {
    let n = recorder.results.length;
    let text = '';
    for await (const event of await anthropic().messages.create({ model: 'claude-scripted', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'What is her SSN?' }] })) {
      if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') text += event.delta.text;
    }
    assert.equal(text, REPLIES.ssn);
    await check(await stored(n), { agent: 'anthropic-e2e', input: 'What is her SSN?', output: REPLIES.ssn, inputTokens: 10, outputTokens: 4, provider: 'anthropic', verdict: 'fail' });

    n = recorder.results.length;
    const message = await anthropic().messages.stream({ model: 'claude-scripted', max_tokens: 64, messages: [{ role: 'user', content: 'What is the capital of France?' }] }).finalMessage();
    assert.equal(message.content[0].type === 'text' && message.content[0].text, REPLIES.default);
    await check(await stored(n), { agent: 'anthropic-e2e', input: 'What is the capital of France?', output: REPLIES.default, inputTokens: 10, outputTokens: 6, provider: 'anthropic', verdict: 'pass' });
  });

  it('a streamed tool call: the arguments are reassembled from their fragments', async () => {
    const n = recorder.results.length;
    const tools = [{ name: 'get_weather', description: 'The weather in a city', input_schema: { type: 'object' as const, properties: { city: { type: 'string' } } } }];
    const message = await anthropic().messages.stream({ model: 'claude-scripted', max_tokens: 64, tools, messages: [{ role: 'user', content: 'What is the weather in Paris?' }] }).finalMessage();
    assert.equal(message.stop_reason, 'tool_use');
    const entry = await stored(n);
    const { trace, spans } = await iris.trace(entry.trace_id);
    assert.equal(trace.output, 'Let me check the weather.');
    const output = JSON.parse(String(spans[0].attributes['gen_ai.output.messages']));
    assert.deepEqual(output[0].parts[1], { type: 'tool_call', id: (message.content[1] as { id: string }).id, name: 'get_weather', arguments: { city: 'Paris' } });
    assert.equal(output[0].finish_reason, 'tool_call');
  });
});

describe('wrapping', () => {
  it('returns a client of the same class, leaves the original unwrapped, and does not wrap twice', async () => {
    const original = new OpenAI({ apiKey: 'scripted', baseURL: `${provider.url}/v1`, maxRetries: 0 });
    const wrapped = wrapOpenAI(original, { recorder });
    assert.ok(wrapped instanceof OpenAI);
    assert.notEqual(wrapped, original);
    assert.equal(wrapOpenAI(wrapped, { recorder }), wrapped);

    const n = recorder.results.length;
    await original.chat.completions.create({ model: 'gpt-scripted', messages: [{ role: 'user', content: 'What is the capital of France?' }] });
    await recorder.flush();
    assert.equal(recorder.results.length, n, 'the original client records nothing');
    await wrapped.withOptions({ timeout: 5000 }).chat.completions.create({ model: 'gpt-scripted', messages: [{ role: 'user', content: 'What is the capital of France?' }] });
    await stored(n);
  });

  it('requests to other endpoints pass through unrecorded', async () => {
    const n = recorder.results.length;
    await assert.rejects(openai().models.list()); // the scripted provider has no /models: a 404, straight through
    await recorder.flush();
    assert.equal(recorder.results.length, n);
  });
});
