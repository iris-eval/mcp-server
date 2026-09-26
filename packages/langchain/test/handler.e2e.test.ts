/*
 * The handler, end to end: a real LangGraph.js app (the tool loop in
 * langgraph-app.ts, a scripted model), IrisCallbackHandler in its callbacks,
 * the recorder sending to a real Iris server, and each run read back from
 * Iris as one trace — its input, output, tool calls, token usage, latency
 * and verdict. The same cases as the Python client's test_langchain_e2e.py.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { HumanMessage } from '@langchain/core/messages';
import { StringOutputParser } from '@langchain/core/output_parsers';
import { ChatPromptTemplate } from '@langchain/core/prompts';
import { MemorySaver } from '@langchain/langgraph';
import { IrisRecorder, type StoredTrace } from '@iris-eval/sdk';
import { IrisCallbackHandler } from '../src/index.js';
import { AFTER_TOOL, ANSWER, SSN, ScriptedChatModel, brokenWeather, buildGraph } from './langgraph-app.js';
import { startIris, type Iris } from './helpers.js';

const WEATHER = 'What is the weather in Paris?';
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

/** Send what the run recorded and return what Iris stored for it — exactly one trace. */
async function stored(before: number): Promise<StoredTrace> {
  await recorder.flush();
  assert.equal(recorder.results.length, before + 1, `one trace for one run; dropped ${recorder.stats.dropped}`);
  return recorder.results[recorder.results.length - 1];
}

type AnySpan = { span_id: string; parent_span_id?: string | null; name: string; kind: string; status_code: string; start_time: string; attributes: Record<string, any> };
const byKind = (spans: AnySpan[], kind: string) => spans.filter((s) => s.kind === kind);
/** The `chat` spans; Iris also files the `invoke_agent` root under LLM, as it does for every framework that emits one. */
const modelCalls = (spans: AnySpan[]) => byKind(spans, 'LLM').filter((s) => s.attributes['gen_ai.operation.name'] === 'chat');
const handler = (agentName = 'weather-graph', extra: { run?: string } = {}) => new IrisCallbackHandler({ recorder, agentName, ...extra });

describe('LangGraph.js', () => {
  it('a tool loop arrives as one trace with its tool call, usage and a pass', async () => {
    const n = recorder.results.length;
    const out = await buildGraph().invoke({ messages: [new HumanMessage(WEATHER)] }, { callbacks: [handler()] });
    assert.equal(out.messages[out.messages.length - 1].content, AFTER_TOOL);
    const entry = await stored(n);
    assert.deepEqual(entry.lacked, []);
    assert.equal(entry.steps, 1);
    assert.equal(entry.evaluation?.verdict?.state, 'pass');

    const { trace, spans, evals } = (await iris.trace(entry.trace_id)) as { trace: Record<string, any>; spans: AnySpan[]; evals: Array<{ id: string }> };
    assert.equal(trace.agent_name, 'weather-graph');
    assert.equal(trace.framework, 'langgraph');
    assert.equal(trace.input, WEATHER);
    assert.equal(trace.output, AFTER_TOOL);
    assert.deepEqual(trace.token_usage, { prompt_tokens: 40, completion_tokens: 20, total_tokens: 60 });
    assert.ok(trace.latency_ms >= 0);
    assert.deepEqual(trace.tools.map((t: { name: string }) => t.name), ['get_weather']);
    assert.deepEqual(evals.map((e) => e.id), [entry.evaluation?.id]);

    const root = spans.find((s) => !s.parent_span_id) as AnySpan;
    assert.equal(root.name, 'invoke_agent weather-graph');
    assert.equal(modelCalls(spans).length, 2);
    const [toolSpan, ...more] = byKind(spans, 'TOOL');
    assert.equal(more.length, 0);
    assert.equal(toolSpan.name, 'execute_tool get_weather');
    assert.equal(toolSpan.attributes['gen_ai.tool.call.id'], 'call_weather_1');
    assert.deepEqual(JSON.parse(toolSpan.attributes['gen_ai.tool.call.arguments']), { city: 'Paris' });
    assert.equal(toolSpan.attributes['gen_ai.tool.call.result'], '18C, sunny in Paris');
    const nodes = spans.filter((s) => s.name === 'agent' || s.name === 'tools').map((s) => s.attributes['langgraph.node']).sort();
    assert.deepEqual(nodes, ['agent', 'agent', 'tools']);
    const first = [...modelCalls(spans)].sort((a, b) => a.start_time.localeCompare(b.start_time))[0];
    assert.equal(first.attributes['gen_ai.request.model'], 'scripted-model');
    assert.equal(first.attributes['gen_ai.provider.name'], 'scripted');
    assert.deepEqual(JSON.parse(first.attributes['gen_ai.output.messages'])[0].parts[0], { type: 'tool_call', id: 'call_weather_1', name: 'get_weather', arguments: { city: 'Paris' } });
    const ids = new Set(spans.map((s) => s.span_id));
    assert.ok(spans.filter((s) => s !== root).every((s) => ids.has(String(s.parent_span_id))));
  });

  it('an answer that leaks an SSN is failed', async () => {
    const n = recorder.results.length;
    await buildGraph().invoke({ messages: [new HumanMessage('What is her SSN?')] }, { callbacks: [handler()] });
    const entry = await stored(n);
    assert.equal(entry.evaluation?.verdict?.state, 'fail');
    assert.ok(entry.evaluation?.rule_results.some((r) => r.ruleName === 'no_pii' && r.passed === false));
  });

  it('a run that fails rejects as it would and still arrives, with its error, unscored', async () => {
    const n = recorder.results.length;
    await assert.rejects(buildGraph([brokenWeather]).invoke({ messages: [new HumanMessage(WEATHER)] }, { callbacks: [handler()] }), /the weather service is down/);
    const entry = await stored(n);
    assert.equal('evaluation' in entry, false);
    const { spans } = (await iris.trace(entry.trace_id)) as { spans: AnySpan[] };
    const [toolSpan] = byKind(spans, 'TOOL');
    assert.equal(toolSpan.status_code, 'ERROR');
    assert.match(toolSpan.attributes['gen_ai.tool.call.result'], /the weather service is down/);
    assert.equal((spans.find((s) => !s.parent_span_id) as AnySpan).status_code, 'ERROR');
  });

  it('a thread_id is the session', async () => {
    const app = buildGraph(undefined, { checkpointer: new MemorySaver() });
    const n = recorder.results.length;
    const config = { callbacks: [handler()], configurable: { thread_id: 'thread-7' } };
    await app.invoke({ messages: [new HumanMessage('What is the capital of France?')] }, config);
    await app.invoke({ messages: [new HumanMessage('What is her SSN?')] }, config);
    await recorder.flush();
    const [first, second] = recorder.results.slice(n);
    assert.equal((await iris.trace(first.trace_id)).trace.session_id, 'thread-7');
    const later = (await iris.trace(second.trace_id)).trace;
    assert.equal(later.session_id, 'thread-7');
    assert.equal(later.input, 'What is her SSN?');
  });
});

describe('LangChain.js', () => {
  it('a chain arrives with its question and its answer', async () => {
    const chain = ChatPromptTemplate.fromMessages([
      ['system', 'Answer briefly.'],
      ['human', '{question}'],
    ])
      .pipe(new ScriptedChatModel({}))
      .pipe(new StringOutputParser());
    const n = recorder.results.length;
    const answer = await chain.invoke({ question: 'What is the capital of France?' }, { callbacks: [handler('qa-chain', { run: 'nightly-1' })] });
    assert.equal(answer, ANSWER);
    const entry = await stored(n);
    const { trace, spans } = (await iris.trace(entry.trace_id)) as { trace: Record<string, any>; spans: AnySpan[] };
    assert.equal(trace.framework, 'langchain');
    assert.equal(trace.input, 'What is the capital of France?');
    assert.equal(trace.output, ANSWER);
    assert.equal(trace.run_id, 'nightly-1');
    assert.deepEqual(trace.token_usage, { prompt_tokens: 10, completion_tokens: 6, total_tokens: 16 });
    const [llm] = modelCalls(spans);
    assert.deepEqual(JSON.parse(llm.attributes['gen_ai.system_instructions']), [{ type: 'text', content: 'Answer briefly.' }]);
    assert.equal(entry.evaluation?.verdict?.state, 'pass');
  });

  it('a model called on its own is its own trace', async () => {
    const n = recorder.results.length;
    await new ScriptedChatModel({}).invoke('What is her SSN?', { callbacks: [handler('bare-model')] });
    const entry = await stored(n);
    const { trace, spans } = (await iris.trace(entry.trace_id)) as { trace: Record<string, any>; spans: AnySpan[] };
    assert.equal(spans.length, 1);
    assert.equal(spans[0].kind, 'LLM');
    assert.equal(trace.input, 'What is her SSN?');
    assert.equal(trace.output, SSN);
    assert.equal(entry.evaluation?.verdict?.state, 'fail');
  });
});

describe('without a server', () => {
  it('the run is untouched', async () => {
    const errors: string[] = [];
    const quiet = new IrisRecorder({ url: 'http://127.0.0.1:9', flushIntervalMs: 1, onError: (e) => errors.push(e.message) });
    const out = await buildGraph().invoke({ messages: [new HumanMessage(WEATHER)] }, { callbacks: [new IrisCallbackHandler({ recorder: quiet })] });
    assert.equal(out.messages[out.messages.length - 1].content, AFTER_TOOL);
    await quiet.flush();
    assert.deepEqual(quiet.stats, { recorded: 1, sent: 0, dropped: 1 });
    assert.ok(errors.length > 0);
  });
});
