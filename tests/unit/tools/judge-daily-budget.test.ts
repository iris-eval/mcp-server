/*
 * One daily budget for every judge call on the user's key.
 *
 * The relevance judge had a daily budget; evaluate_with_llm_judge and
 * verify_citations had a per-call cap and nothing over the day, so an agent
 * calling either in a loop could spend the key without end. These run both
 * tools over an in-memory MCP transport against the budget the server sets
 * from IRIS_LLM_JUDGE_DAILY_BUDGET_USD, and check that a refused call spends
 * nothing, that both tools draw on one balance, and that the relevance judge
 * draws on the same one.
 *
 * The provider client is mocked, so nothing is spent; the cited host is
 * answered by a stubbed fetch, and DNS by a stub.
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
const { __clearCitationCacheForTests, __setDnsLookupForTests } = await import('../../../src/eval/citation-verify/resolve.js');

type Result = { content?: unknown; isError?: boolean };
type ErrorBody = { error: { code: string; message: string; retryable: boolean; field?: string } };
const body = (r: Result) =>
  JSON.parse((r.content as Array<{ type: string; text: string }>).find((c) => c.type === 'text')!.text) as Record<string, unknown>;

const SCORE = JSON.stringify({ score: 0.9, rationale: 'because', dimensions: { a: 0.9 } });
const SUPPORTED = '{"supported":true,"confidence":0.9,"rationale":"the page states it"}';
const reply = (content: string) => ({ content, inputTokens: 10, outputTokens: 10, latencyMs: 1, rawProviderResponseId: 'resp-1' });

describe('every judge call on the key draws on one daily budget', () => {
  let storage: InstanceType<typeof SqliteAdapter>;
  let server: ReturnType<typeof createIrisServer>;
  let client: Client;
  const savedFetch = global.fetch;

  /** The server reads the budget from the environment when it is created, so each case sets it first. */
  async function start(env: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    server = createIrisServer(defaultConfig, storage, undefined, { warn: () => {} });
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(s);
    client = new Client({ name: 'judge-daily-budget', version: '0.1.0' });
    await client.connect(c);
  }

  const judge = async () =>
    body((await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'an answer', template: 'accuracy', model: 'claude-haiku-4-5' } })) as Result);
  const verify = async () =>
    body((await client.callTool({ name: 'verify_citations', arguments: { output: 'Alpha is 42 (https://a.example/alpha).', model: 'claude-haiku-4-5' } })) as Result);

  beforeEach(() => {
    callLLMJudge.mockReset();
    vi.stubEnv('IRIS_ANTHROPIC_API_KEY', 'sk-ant-dummy-key-for-tests-0123456789');
    vi.stubEnv('IRIS_CITATION_ALLOW_FETCH', '1');
    vi.stubEnv('IRIS_RELEVANCE_JUDGE_MODEL', '');
    vi.stubEnv('IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD', '');
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    global.fetch = vi.fn(async () => new Response('Alpha is 42.', { status: 200, headers: { 'content-type': 'text/plain' } })) as unknown as typeof fetch;
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    global.fetch = savedFetch;
    __clearCitationCacheForTests();
    __setDnsLookupForTests(null);
    vi.unstubAllEnvs();
  });

  it('a spent budget refuses evaluate_with_llm_judge before any call: IRIS_BUDGET_EXCEEDED, retryable, nothing stored', async () => {
    await start({ IRIS_LLM_JUDGE_DAILY_BUDGET_USD: '0' });
    const out = (await judge()) as unknown as ErrorBody;
    expect(callLLMJudge).not.toHaveBeenCalled();
    expect(out.error).toMatchObject({ code: 'IRIS_BUDGET_EXCEEDED', retryable: true, field: 'IRIS_LLM_JUDGE_DAILY_BUDGET_USD' });
    expect(out.error.message).toMatch(/daily judge budget has 0\.0000 of 0 USD left today \(UTC\).*resets at /);
    expect((await storage.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
  });

  it('a spent budget refuses every citation judge call: daily_budget_reached, and the tool fails closed as retryable', async () => {
    await start({ IRIS_LLM_JUDGE_DAILY_BUDGET_USD: '0' });
    const out = (await verify()) as unknown as ErrorBody;
    expect(callLLMJudge).not.toHaveBeenCalled();
    expect(out.error).toMatchObject({ code: 'IRIS_JUDGE_FAILED', retryable: true });
    expect(out.error.message).toContain('daily_budget_reached');
  });

  it('both tools draw on one balance, and today\'s spend is on iris://capabilities', async () => {
    await start({ IRIS_LLM_JUDGE_DAILY_BUDGET_USD: '0.5' });
    callLLMJudge.mockResolvedValueOnce(reply(SCORE)).mockResolvedValueOnce(reply(SUPPORTED));
    expect((await judge()).passed).toBeDefined();
    expect((await verify()).total_judged).toBe(1);
    expect(callLLMJudge).toHaveBeenCalledTimes(2);

    const today = server.capabilities().judge.dailyBudget;
    expect(today).toMatchObject({ limitUsd: 0.5, calls: 2, refused: 0, exhausted: false });
    // Settled to what the calls cost, not held at their worst case.
    expect(today!.spentUsd).toBeGreaterThan(0);
    expect(today!.spentUsd).toBeLessThan(0.001);
  });

  it('the relevance judge draws on the same budget the tools do', async () => {
    await start({ IRIS_LLM_JUDGE_DAILY_BUDGET_USD: '0.5', IRIS_RELEVANCE_JUDGE_MODEL: 'claude-haiku-4-5' });
    const relevance = server.evalEngine.relevanceJudgeInForce();
    expect(relevance).not.toBeNull();
    expect(relevance!.budget).toBe(server.evalEngine.judgeBudgetInForce());
  });

  it('the old variable name still sets the budget when the new one is unset', async () => {
    await start({ IRIS_LLM_JUDGE_DAILY_BUDGET_USD: '', IRIS_RELEVANCE_JUDGE_DAILY_BUDGET_USD: '0' });
    const out = (await judge()) as unknown as ErrorBody;
    expect(callLLMJudge).not.toHaveBeenCalled();
    expect(out.error.code).toBe('IRIS_BUDGET_EXCEEDED');
  });
});
