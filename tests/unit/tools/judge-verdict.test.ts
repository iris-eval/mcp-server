/*
 * `passed` means one thing across the four eval tools (arc 9, N-3; #375 item 2).
 *
 * evaluate_with_llm_judge and verify_citations store one judgment row each
 * and used to report their own pass/fail beside it. Now both rows go
 * through the engine's composer before they are stored, and both responses
 * carry the composer's `verdict` — the same object evaluate_output prints.
 * A failed judgment gates (basis policy_gate); a passed one is clean;
 * nothing judged is unknown (no_rules). The stored row reads back with the
 * same verdict.
 *
 * No provider is called: the judge client and the citation verifier are
 * mocked, so this runs offline like the rest of the suite.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const callLLMJudge = vi.fn();
vi.mock('../../../src/eval/llm-judge/client.js', () => ({
  callLLMJudge: (...args: unknown[]) => callLLMJudge(...args) as unknown,
  estimateInputTokens: () => 100,
  LLMJudgeError: class extends Error {},
}));

const verifyCitations = vi.fn();
vi.mock('../../../src/eval/citation-verify/verifier.js', () => ({
  verifyCitations: (...args: unknown[]) => verifyCitations(...args) as unknown,
}));

const { SqliteAdapter } = await import('../../../src/storage/sqlite-adapter.js');
const { createIrisServer } = await import('../../../src/server.js');
const { createCustomRuleStore } = await import('../../../src/custom-rule-store.js');
const { defaultConfig } = await import('../../../src/config/defaults.js');
const { LOCAL_TENANT } = await import('../../../src/types/tenant.js');

type Content = Array<{ type: string; text: string }>;
const parse = (r: { content?: unknown }) => JSON.parse((r.content as Content)[0].text) as Record<string, unknown>;

/** One judge reply with the given score; the model claims nothing about passing. */
function judgeReplies(score: number): void {
  callLLMJudge.mockResolvedValueOnce({
    content: JSON.stringify({ score, rationale: 'because', dimensions: { a: score } }),
    inputTokens: 10,
    outputTokens: 10,
    latencyMs: 1,
    rawProviderResponseId: 'resp-1',
  });
}

function citation(supported: boolean) {
  return {
    citation: { raw: '[1]', kind: 'numbered', identifier: '1', offsetStart: 10, offsetEnd: 13, contextWindow: 'claim' },
    resolveStatus: 'ok',
    source: { url: 'https://example.org/paper', status: 200, contentType: 'text/html', bytesFetched: 4321, truncated: false },
    judge: { supported, confidence: 0.9, rationale: supported ? 'supports' : 'contradicts', costUsd: 0.0012, latencyMs: 120, inputTokens: 100, outputTokens: 20 },
  };
}

describe('the composer decides on the judge and the citations tools', () => {
  let client: Client;
  let storage: InstanceType<typeof SqliteAdapter>;
  let ruleDir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    callLLMJudge.mockReset();
    verifyCitations.mockReset();
    savedKey = process.env.IRIS_ANTHROPIC_API_KEY;
    process.env.IRIS_ANTHROPIC_API_KEY = 'test-key';
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-judge-verdict-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'judge-verdict', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
    if (savedKey === undefined) delete process.env.IRIS_ANTHROPIC_API_KEY;
    else process.env.IRIS_ANTHROPIC_API_KEY = savedKey;
  });

  it('a failed judgment gates: the response and the stored row both say policy_gate by the judge', async () => {
    judgeReplies(0.2);
    const r = await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'an answer', input: 'a question', template: 'accuracy', model: 'claude-haiku-4-5' } });
    expect(r.isError).toBeFalsy();
    const body = parse(r);
    expect(body.passed).toBe(false);
    const verdict = body.verdict as { state: string; passed: boolean; basis: string; by: string[] };
    expect(verdict.state).toBe('fail');
    expect(verdict.basis).toBe('policy_gate');
    expect(verdict.by).toEqual(['llm_judge:accuracy:anthropic/claude-haiku-4-5']);
    const stored = await storage.getEvalById(LOCAL_TENANT, body.id as string);
    expect(stored?.verdict?.basis).toBe('policy_gate');
    expect(stored?.passed).toBe(false);
  });

  it('a passed judgment is clean, on the response and on the stored row', async () => {
    judgeReplies(0.95);
    const body = parse(await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'an answer', input: 'a question', template: 'accuracy', model: 'claude-haiku-4-5' } }));
    expect(body.passed).toBe(true);
    expect((body.verdict as { basis: string }).basis).toBe('clean');
    const stored = await storage.getEvalById(LOCAL_TENANT, body.id as string);
    expect(stored?.verdict?.basis).toBe('clean');
  });

  it('an unsupported citation gates; nothing judged is unknown, not a pass', async () => {
    verifyCitations.mockResolvedValueOnce({
      overallScore: 0,
      passed: false,
      totalCitationsFound: 1,
      totalResolved: 1,
      totalJudged: 1,
      totalSupported: 0,
      totalUnsupported: 1,
      totalCostUsd: 0.0012,
      citations: [citation(false)],
    });
    const failed = parse(await client.callTool({ name: 'verify_citations', arguments: { output: 'A claim [1].', model: 'claude-haiku-4-5' } }));
    expect(failed.passed).toBe(false);
    expect((failed.verdict as { basis: string; by: string[] }).basis).toBe('policy_gate');
    expect((failed.verdict as { by: string[] }).by[0]).toMatch(/^semantic_citation_verify:/);
    expect((await storage.getEvalById(LOCAL_TENANT, failed.id as string))?.verdict?.basis).toBe('policy_gate');

    verifyCitations.mockResolvedValueOnce({
      overallScore: null,
      passed: null,
      totalCitationsFound: 1,
      totalResolved: 0,
      totalJudged: 0,
      totalSupported: 0,
      totalUnsupported: 0,
      totalCostUsd: 0,
      citations: [{ ...citation(true), resolveStatus: 'error', resolveError: 'fetch refused', source: undefined, judge: undefined }],
    });
    const nothing = parse(await client.callTool({ name: 'verify_citations', arguments: { output: 'A claim [1].', model: 'claude-haiku-4-5' } }));
    expect(nothing.passed).toBeNull();
    const verdict = nothing.verdict as { state: string; passed: boolean; basis: string };
    expect(verdict.state).toBe('unknown');
    expect(verdict.passed).toBe(false);
    expect(verdict.basis).toBe('no_rules');
  });
});
