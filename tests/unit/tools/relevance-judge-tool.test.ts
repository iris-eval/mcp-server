/*
 * The relevance judge over MCP (#649): the server a user runs, over an
 * in-memory transport, with only the provider call replaced.
 *
 *   - IRIS_RELEVANCE_JUDGE_MODEL and a key: evaluate_output fails an
 *     off-topic answer on policy_gate by answers_the_ask, the response and
 *     the stored row read back through iris://evaluations/{id} say the same,
 *     and a linked trace that records a same-family agent model is named.
 *   - A key alone: evaluate_output makes no provider call, whatever it is
 *     asked — the judge key enables evaluate_with_llm_judge, not spending on
 *     every evaluation.
 *   - iris://capabilities says which of the two a server is.
 *   - evaluate_with_llm_judge runs the relevance template, and refuses it
 *     without an input before anything is spent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

const callLLMJudge = vi.fn();
vi.mock('../../../src/eval/llm-judge/client.js', () => ({
  callLLMJudge: (...args: unknown[]) => callLLMJudge(...args) as unknown,
  estimateInputTokens: () => 100,
  LLMJudgeError: class extends Error {
    kind = 'server_error';
    retryable = false;
  },
}));

const { SqliteAdapter } = await import('../../../src/storage/sqlite-adapter.js');
const { createIrisServer } = await import('../../../src/server.js');
const { defaultConfig } = await import('../../../src/config/defaults.js');
const { LOCAL_TENANT } = await import('../../../src/types/tenant.js');

type Result = { content?: unknown; isError?: boolean };
const text = (r: Result) => (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')!.text!;

function reply(score: number, rationale = 'because'): void {
  callLLMJudge.mockResolvedValueOnce({
    content: JSON.stringify({ score, rationale, dimensions: { addresses_request: score } }),
    inputTokens: 900,
    outputTokens: 60,
    latencyMs: 1,
    rawProviderResponseId: 'resp-1',
  });
}

const OFF_TOPIC = {
  input: 'Summarize the latest quarterly report for the board meeting',
  output: 'The weather in San Francisco is 62 degrees with partly cloudy skies. Traffic on the Bay Bridge is moderate, with a 25-minute crossing time.',
};

type Evaluation = {
  id: string;
  passed: boolean;
  verdict: { state: string; basis: string; by: string[] };
  rule_results: Array<{ ruleName: string; kind?: string; role?: string; passed: boolean; judge?: Record<string, unknown> }>;
  interpretations?: Array<{ rule?: string; text: string; configKey?: string }>;
};

const ENV = ['IRIS_RELEVANCE_JUDGE_MODEL', 'IRIS_ANTHROPIC_API_KEY', 'IRIS_OPENAI_API_KEY'] as const;

describe('the relevance judge over MCP', () => {
  let storage: InstanceType<typeof SqliteAdapter>;
  let client: Client;
  const saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));

  async function boot(env: Partial<Record<(typeof ENV)[number], string>>): Promise<void> {
    for (const k of ENV) delete process.env[k];
    Object.assign(process.env, env);
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const server = createIrisServer(defaultConfig, storage);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(s);
    client = new Client({ name: 'relevance-judge', version: '0.1.0' });
    await client.connect(c);
  }

  async function evaluate(args: Record<string, unknown>): Promise<Evaluation> {
    const r = (await client.callTool({ name: 'evaluate_output', arguments: args })) as Result;
    expect(r.isError, text(r)).toBeFalsy();
    return JSON.parse(text(r)) as Evaluation;
  }

  const answers = (e: Evaluation) => e.rule_results.find((r) => r.ruleName === 'answers_the_ask')!;

  beforeEach(() => {
    callLLMJudge.mockReset();
  });

  afterEach(async () => {
    await client?.close();
    await storage?.close();
    for (const k of ENV) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('with the model and a key: an off-topic answer fails, and the stored row reads back the same', async () => {
    await boot({ IRIS_RELEVANCE_JUDGE_MODEL: 'claude-haiku-4-5', IRIS_ANTHROPIC_API_KEY: 'sk-ant-dummy-key-for-tests-0123456789' });
    reply(0.03, 'A weather bulletin, not a summary of the report.');
    const e = await evaluate({ ...OFF_TOPIC, eval_type: 'relevance' });
    expect(e.passed).toBe(false);
    expect(e.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate', by: ['answers_the_ask'] });
    expect(answers(e)).toMatchObject({ passed: false, kind: 'judgment', role: 'gate' });
    expect(answers(e).judge).toMatchObject({ model: 'claude-haiku-4-5', provider: 'anthropic', score: 0.03, passThreshold: 0.6 });
    expect(callLLMJudge).toHaveBeenCalledTimes(1);
    expect(callLLMJudge.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-4-5', provider: 'anthropic', temperature: 0 });

    const stored = JSON.parse((await client.readResource({ uri: `iris://evaluations/${e.id}` })).contents[0].text as string) as Evaluation;
    expect(stored.passed).toBe(false);
    expect(stored.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate', by: ['answers_the_ask'] });
    expect(answers(stored).judge).toMatchObject({ score: 0.03, rationale: 'A weather bulletin, not a summary of the report.' });
  });

  it('a linked trace that records a same-family agent names the judge as a same-family opinion', async () => {
    await boot({ IRIS_RELEVANCE_JUDGE_MODEL: 'claude-haiku-4-5', IRIS_ANTHROPIC_API_KEY: 'sk-ant-dummy-key-for-tests-0123456789' });
    const trace_id = 'a'.repeat(32);
    await storage.insertTrace(LOCAL_TENANT, { trace_id, agent_name: 'bot', input: OFF_TOPIC.input, output: OFF_TOPIC.output, timestamp: new Date().toISOString(), metadata: { model: 'claude-opus-4-7' } });
    reply(0.03);
    const e = await evaluate({ ...OFF_TOPIC, eval_type: 'relevance', trace_id });
    expect(answers(e).judge).toMatchObject({ agentModel: 'claude-opus-4-7', sameFamily: true });
    expect(e.interpretations?.some((i) => i.rule === 'answers_the_ask' && /shares a model family/.test(i.text))).toBe(true);
    expect(e.verdict.basis).toBe('policy_gate');
  });

  it('with a key alone: no provider call from evaluate_output, and the lexical rule advises and says why', async () => {
    await boot({ IRIS_ANTHROPIC_API_KEY: 'sk-ant-dummy-key-for-tests-0123456789', IRIS_OPENAI_API_KEY: 'sk-dummy-key-for-tests-0123456789' });
    const e = await evaluate({ ...OFF_TOPIC });
    expect(callLLMJudge).not.toHaveBeenCalled();
    expect(answers(e), JSON.stringify(answers(e))).toMatchObject({ passed: false, kind: 'policy', role: 'advisory' });
    expect(answers(e).judge).toBeUndefined();
    expect(e.passed).toBe(true);
    expect(e.interpretations?.find((i) => i.rule === 'answers_the_ask')?.configKey).toBe('IRIS_RELEVANCE_JUDGE_MODEL');
  });

  it('iris://capabilities says whether a relevance judge is installed, and whether it can be called', async () => {
    await boot({ IRIS_ANTHROPIC_API_KEY: 'sk-ant-dummy-key-for-tests-0123456789' });
    const read = async () => (JSON.parse((await client.readResource({ uri: 'iris://capabilities' })).contents[0].text as string) as { judge: { relevance: Record<string, unknown> } }).judge.relevance;
    expect(await read()).toMatchObject({ configured: false, ready: false, model: null, passThreshold: 0.6 });
    await client.close();
    await storage.close();
    await boot({ IRIS_RELEVANCE_JUDGE_MODEL: 'gpt-4o-mini', IRIS_ANTHROPIC_API_KEY: 'sk-ant-dummy-key-for-tests-0123456789' });
    const misconfigured = await read();
    expect(misconfigured).toMatchObject({ configured: true, ready: false, model: 'gpt-4o-mini', provider: 'openai' });
    expect(misconfigured.problem).toMatch(/IRIS_OPENAI_API_KEY/);
  });

  it('evaluate_with_llm_judge runs the relevance template, and refuses it without an input before any spend', async () => {
    await boot({ IRIS_ANTHROPIC_API_KEY: 'sk-ant-dummy-key-for-tests-0123456789' });
    const refused = (await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: OFF_TOPIC.output, template: 'relevance', model: 'claude-haiku-4-5' } })) as Result;
    expect(refused.isError).toBe(true);
    expect(text(refused)).toMatch(/IRIS_INVALID_ARGUMENT/);
    expect(callLLMJudge).not.toHaveBeenCalled();

    reply(0.04);
    const r = (await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { ...OFF_TOPIC, template: 'relevance', model: 'claude-haiku-4-5' } })) as Result;
    expect(r.isError, text(r)).toBeFalsy();
    const out = JSON.parse(text(r)) as { passed: boolean; pass_threshold: number; template: string };
    expect(out).toMatchObject({ passed: false, pass_threshold: 0.6, template: 'relevance' });
    expect(callLLMJudge.mock.calls[0][0].systemPrompt).toMatch(/relevant to the request that produced it/);
  });
});
