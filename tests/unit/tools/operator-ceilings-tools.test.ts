/*
 * Operator settings are ceilings, through the real tools.
 *
 * An agent's arguments can be steered by text it read, so an argument may
 * narrow what the operator allowed and never widen it
 * (src/tools/operator-ceilings.ts). These call evaluate_with_llm_judge and
 * verify_citations over an in-memory MCP transport with the arguments that
 * used to widen the operator's settings, and check three things each time:
 * the operator's setting is what applied, the agent's reply says so, and the
 * stored evaluation tells the operator on a later read.
 *
 * The provider client is mocked, so nothing is spent; the cited hosts are
 * answered by a fetch routed on hostname, and DNS by a stub.
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
type Warning = { code: string; field: string; message: string };
const body = (r: Result) =>
  JSON.parse((r.content as Array<{ type: string; text: string }>).find((c) => c.type === 'text')!.text) as Record<string, unknown>;

const OPERATOR_NOTE = 'The calling agent asked for more than you allow.';

function judgeReplies(content: string): void {
  callLLMJudge.mockResolvedValue({ content, inputTokens: 10, outputTokens: 10, latencyMs: 1, rawProviderResponseId: 'resp-1' });
}

/** Every host the tool fetched, in order; a source is served only if listed. */
function sources(pages: Record<string, string>): { fetched: string[] } {
  const fetched: string[] = [];
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    const { hostname } = new URL(input instanceof Request ? input.url : String(input));
    fetched.push(hostname);
    const text = pages[hostname];
    if (text === undefined) throw new Error(`unexpected fetch to ${hostname}`);
    return new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as unknown as typeof fetch;
  return { fetched };
}

describe('an argument cannot widen what the operator allows', () => {
  let storage: InstanceType<typeof SqliteAdapter>;
  let client: Client;
  const savedFetch = global.fetch;

  beforeEach(async () => {
    callLLMJudge.mockReset();
    vi.stubEnv('IRIS_ANTHROPIC_API_KEY', 'sk-ant-dummy-key-for-tests-0123456789');
    vi.stubEnv('IRIS_CITATION_ALLOW_FETCH', '');
    vi.stubEnv('IRIS_CITATION_DOMAINS', '');
    vi.stubEnv('IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL', '');
    vi.stubEnv('IRIS_CITATION_MAX_COST_USD_TOTAL', '');
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const server = createIrisServer(defaultConfig, storage);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await server.mcpServer.connect(s);
    client = new Client({ name: 'operator-ceilings', version: '0.1.0' });
    await client.connect(c);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    global.fetch = savedFetch;
    __clearCitationCacheForTests();
    __setDnsLookupForTests(null);
    vi.unstubAllEnvs();
  });

  /** The stored evaluation as a later reader gets it: the sentences are derived on read, from what the row stored. */
  async function operatorNotes(id: string): Promise<Array<{ text: string; configKey?: string }>> {
    const stored = await storage.getEvalById(LOCAL_TENANT, id);
    expect(stored).not.toBeNull();
    return (stored!.interpretations ?? []).filter((i) => i.addressee === 'operator' && i.text.startsWith(OPERATOR_NOTE));
  }

  it('allow_fetch: true with fetching off fetches nothing, and both the reply and the stored row say why', async () => {
    const { fetched } = sources({ 'a.example': 'Alpha is 42.' });
    const out = body(
      (await client.callTool({
        name: 'verify_citations',
        arguments: { output: 'Alpha is 42 (https://a.example/alpha).', model: 'claude-haiku-4-5', allow_fetch: true },
      })) as Result,
    );
    expect(fetched).toEqual([]);
    expect(callLLMJudge).not.toHaveBeenCalled();
    expect((out.citations as Array<{ resolve_status: string }>)[0].resolve_status).not.toBe('ok');
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'IRIS_ARGUMENT_NARROWED', field: 'allow_fetch' })]);

    const notes = await operatorNotes(out.id as string);
    expect(notes).toHaveLength(1);
    expect(notes[0].configKey).toBe('IRIS_CITATION_ALLOW_FETCH');
    expect(notes[0].text).toContain('No source was fetched');
  });

  it('domain_allowlist cannot add a domain to IRIS_CITATION_DOMAINS: the added one is never fetched', async () => {
    vi.stubEnv('IRIS_CITATION_ALLOW_FETCH', '1');
    vi.stubEnv('IRIS_CITATION_DOMAINS', 'a.example');
    judgeReplies('{"supported":true,"confidence":0.9,"rationale":"the page states it"}');
    const { fetched } = sources({ 'a.example': 'Alpha is 42.', 'b.example': 'Beta is 7.' });
    const out = body(
      (await client.callTool({
        name: 'verify_citations',
        arguments: {
          output: 'Alpha is 42 (https://a.example/alpha). Beta is 7 (https://b.example/beta).',
          model: 'claude-haiku-4-5',
          domain_allowlist: ['a.example', 'b.example'],
        },
      })) as Result,
    );
    expect(fetched).toEqual(['a.example']);
    const [a, b] = out.citations as Array<{ resolve_status: string; resolve_error?: { kind: string } }>;
    expect(a.resolve_status).toBe('ok');
    expect(b.resolve_status).not.toBe('ok');
    expect(b.resolve_error?.kind).toBe('not_allowed_domain');
    expect((out.warnings as Warning[]).map((w) => w.field)).toEqual(['domain_allowlist']);

    const notes = await operatorNotes(out.id as string);
    expect(notes.map((n) => n.configKey)).toEqual(['IRIS_CITATION_DOMAINS']);
  });

  it('max_cost_usd_total above IRIS_CITATION_MAX_COST_USD_TOTAL is held to it: the judge call is refused before any spend', async () => {
    vi.stubEnv('IRIS_CITATION_ALLOW_FETCH', '1');
    vi.stubEnv('IRIS_CITATION_MAX_COST_USD_TOTAL', '0.0000001');
    judgeReplies('{"supported":true,"confidence":0.9,"rationale":"the page states it"}');
    sources({ 'a.example': 'Alpha is 42.' });
    const out = body(
      (await client.callTool({
        name: 'verify_citations',
        arguments: { output: 'Alpha is 42 (https://a.example/alpha).', model: 'claude-haiku-4-5', max_cost_usd_total: 50 },
      })) as Result,
    );
    expect(callLLMJudge).not.toHaveBeenCalled();
    expect(out.error).toMatchObject({ code: 'IRIS_JUDGE_FAILED' });
    expect(String((out.error as { message: string }).message)).toContain('cost_cap_reached');
  });

  it('max_cost_usd above IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL is held to it: the judge call is refused before any spend', async () => {
    vi.stubEnv('IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL', '0.0000001');
    const r = (await client.callTool({
      name: 'evaluate_with_llm_judge',
      arguments: { output: 'an answer', template: 'accuracy', model: 'claude-haiku-4-5', max_cost_usd: 50 },
    })) as Result;
    expect(callLLMJudge).not.toHaveBeenCalled();
    expect(body(r).error).toMatchObject({ code: 'IRIS_BUDGET_EXCEEDED' });
  });

  it('max_cost_usd above the cap still runs under the cap when that is enough, and the stored judgment tells the operator', async () => {
    judgeReplies(JSON.stringify({ score: 0.9, rationale: 'because', dimensions: { a: 0.9 } }));
    const r = (await client.callTool({
      name: 'evaluate_with_llm_judge',
      arguments: { output: 'an answer', template: 'accuracy', model: 'claude-haiku-4-5', max_cost_usd: 50 },
    })) as Result;
    expect(r.isError).toBeFalsy();
    const out = body(r);
    expect(callLLMJudge).toHaveBeenCalledTimes(1);
    expect(out.warnings).toEqual([expect.objectContaining({ code: 'IRIS_ARGUMENT_NARROWED', field: 'max_cost_usd' })]);
    expect((out.warnings as Warning[])[0].message).toContain('0.25 USD applied');

    const notes = await operatorNotes(out.id as string);
    expect(notes.map((n) => n.configKey)).toEqual(['IRIS_LLM_JUDGE_MAX_COST_USD_PER_EVAL']);
  });

  it('an argument within the operator\'s settings warns nobody', async () => {
    judgeReplies(JSON.stringify({ score: 0.9, rationale: 'because', dimensions: { a: 0.9 } }));
    const out = body(
      (await client.callTool({
        name: 'evaluate_with_llm_judge',
        arguments: { output: 'an answer', template: 'accuracy', model: 'claude-haiku-4-5', max_cost_usd: 0.1 },
      })) as Result,
    );
    expect(out.warnings).toBeUndefined();
    expect(await operatorNotes(out.id as string)).toEqual([]);
    const stored = await storage.getEvalById(LOCAL_TENANT, out.id as string);
    expect(stored?.provenance?.narrowed).toBeUndefined();
  });
});
