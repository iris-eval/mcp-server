/*
 * A judge sharing a model family with the agent it judges says so
 * (0.14.0). Through the real tool over an
 * in-memory transport; the provider client is mocked so nothing is spent
 * and this runs on every machine. The agent's model is read from the
 * linked trace (metadata.model) or from agent_model; a judge from another
 * family carries no warning; the evaluation is stored either way.
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

type Result = { content?: unknown; isError?: boolean; structuredContent?: unknown };
const text = (r: Result) => (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')!.text!;

function reply(score: number): void {
  callLLMJudge.mockResolvedValueOnce({
    content: JSON.stringify({ score, rationale: 'because', dimensions: { a: score } }),
    inputTokens: 10,
    outputTokens: 10,
    latencyMs: 1,
    rawProviderResponseId: 'resp-1',
  });
}

describe('IRIS_JUDGE_SAME_FAMILY — warned, never refused', () => {
  let storage: InstanceType<typeof SqliteAdapter>;
  let client: Client;
  const savedKeys = { anthropic: process.env.IRIS_ANTHROPIC_API_KEY, openai: process.env.IRIS_OPENAI_API_KEY };

  beforeEach(async () => {
    callLLMJudge.mockReset();
    process.env.IRIS_ANTHROPIC_API_KEY = 'sk-ant-dummy-key-for-tests-0123456789';
    process.env.IRIS_OPENAI_API_KEY = 'sk-dummy-key-for-tests-0123456789';
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const server = createIrisServer(defaultConfig, storage);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(s);
    client = new Client({ name: 'judge-same-family', version: '0.1.0' });
    await client.connect(c);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    for (const [k, v] of [
      ['IRIS_ANTHROPIC_API_KEY', savedKeys.anthropic],
      ['IRIS_OPENAI_API_KEY', savedKeys.openai],
    ] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  async function trace(model: string | undefined): Promise<string> {
    const trace_id = `t-${Math.random().toString(16).slice(2, 10)}`;
    await storage.insertTrace(LOCAL_TENANT, {
      trace_id,
      agent_name: 'support-bot',
      output: 'an answer',
      timestamp: new Date().toISOString(),
      ...(model ? { metadata: { model } } : {}),
    });
    return trace_id;
  }

  async function judge(args: Record<string, unknown>): Promise<{ warnings?: Array<{ code: string; message: string }>; id: string; passed: boolean }> {
    reply(0.9);
    const r = (await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'an answer', template: 'accuracy', ...args } })) as Result;
    expect(r.isError, text(r)).toBeFalsy();
    return JSON.parse(text(r)) as { warnings?: Array<{ code: string; message: string }>; id: string; passed: boolean };
  }

  it('a Claude judge on a trace a Claude agent produced: the response carries the warning, the evaluation is stored', async () => {
    const trace_id = await trace('claude-opus-4-7');
    const out = await judge({ model: 'claude-haiku-4-5', trace_id });
    expect(out.passed).toBe(true);
    expect(out.warnings?.map((w) => w.code)).toEqual(['IRIS_JUDGE_SAME_FAMILY']);
    expect(out.warnings?.[0].message).toContain('claude-opus-4-7');
    expect(out.warnings?.[0].message).toContain('claude-haiku-4-5');
    expect(await storage.getEvalById(LOCAL_TENANT, out.id)).not.toBeNull();
  });

  it('a GPT judge on the same trace: no warning', async () => {
    const trace_id = await trace('claude-opus-4-7');
    const out = await judge({ model: 'gpt-4o-mini', trace_id });
    expect(out.warnings).toBeUndefined();
  });

  it('agent_model stands in when no trace records the model; a trace that records nothing warns about nothing', async () => {
    const withModel = await judge({ model: 'gpt-4o-mini', agent_model: 'gpt-4.1' });
    expect(withModel.warnings?.map((w) => w.code)).toEqual(['IRIS_JUDGE_SAME_FAMILY']);
    const trace_id = await trace(undefined);
    const silent = await judge({ model: 'claude-haiku-4-5', trace_id });
    expect(silent.warnings).toBeUndefined();
  });

  it('an explicit agent_model is honoured over what the trace recorded (the caller knows the agent)', async () => {
    const trace_id = await trace('gpt-4o');
    const out = await judge({ model: 'claude-haiku-4-5', trace_id, agent_model: 'claude-opus-4-7' });
    // The caller said claude, the trace says gpt: the explicit argument is honoured (it is the caller's own knowledge).
    expect(out.warnings?.map((w) => w.code)).toEqual(['IRIS_JUDGE_SAME_FAMILY']);
  });
});
