/*
 * A judgment or a citation check named beside a trace is not that trace's
 * verdict.
 *
 * Both tools store one row and used to link it with `trace_id`. Every
 * reader of a trace's verdict takes the newest row carrying it, so a judge
 * call with a lenient template, made after the trace failed on a leaked
 * credential, made the trace read `pass` in its run. The row is now kept
 * beside the trace (`reference_trace_id`), listed with it, and the trace's
 * verdict stays what the server's own scoring of the stored record said
 * (src/eval/of-record.ts).
 *
 * No provider is called: the judge client and the citation verifier are
 * mocked.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { textOf, type ToolResult } from '../../helpers/mcp-results.js';

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
const { verdictOfRecord } = await import('../../../src/eval/of-record.js');

const parse = (r: ToolResult): Record<string, unknown> => JSON.parse(textOf(r));
const LEAK = 'The reporter is Marisol Quintero, SSN 123-45-6789, and her card ending 4242 was charged twice.';

describe('a judgment or citation check beside a trace', () => {
  let client: Client;
  let storage: InstanceType<typeof SqliteAdapter>;
  let dir: string;
  let savedKey: string | undefined;

  beforeEach(async () => {
    callLLMJudge.mockReset();
    verifyCitations.mockReset();
    savedKey = process.env.IRIS_ANTHROPIC_API_KEY;
    process.env.IRIS_ANTHROPIC_API_KEY = 'test-key';
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    dir = mkdtempSync(join(tmpdir(), 'iris-judge-beside-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(dir, 'custom-rules.json'), auditPath: join(dir, 'audit.log') });
    const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
    const [c, s] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(s);
    client = new Client({ name: 'judge-beside', version: '0.1.0' });
    await client.connect(c);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (savedKey === undefined) delete process.env.IRIS_ANTHROPIC_API_KEY;
    else process.env.IRIS_ANTHROPIC_API_KEY = savedKey;
  });

  async function failingTrace(): Promise<string> {
    const logged = parse(await client.callTool({ name: 'log_trace', arguments: { agent_name: 'support-bot', input: 'Summarise the ticket.', output: LEAK, run: 'nightly-1', evaluate: true } }));
    expect((logged.evaluation as { verdict: { basis: string } }).verdict.basis).toBe('detector_veto');
    return logged.trace_id as string;
  }

  it('a passing judgment does not turn the failed trace into a passed one', async () => {
    const traceId = await failingTrace();
    callLLMJudge.mockResolvedValueOnce({ content: JSON.stringify({ score: 0.97, rationale: 'helpful', dimensions: { a: 0.97 } }), inputTokens: 10, outputTokens: 10, latencyMs: 1, rawProviderResponseId: 'resp-1' });
    const body = parse(await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: LEAK, input: 'Summarise the ticket.', template: 'helpfulness', model: 'claude-haiku-4-5', trace_id: traceId } }));
    expect(body.passed).toBe(true);
    expect(body).not.toHaveProperty('trace_id');
    expect(body.reference_trace_id).toBe(traceId);
    expect((body.interpretations as Array<{ text: string }>).some((i) => i.text.includes("LLM judge's answer to its own question"))).toBe(true);

    const run = await storage.getRunResults(LOCAL_TENANT, 'nightly-1');
    expect(run).toHaveLength(1);
    expect(run[0].passed, 'the run still counts the trace as failed').toBe(false);
    const all = await storage.getEvalsByTraceId(LOCAL_TENANT, traceId);
    expect(all).toHaveLength(2);
    expect(verdictOfRecord(all)?.passed).toBe(false);
    const stored = await storage.getEvalById(LOCAL_TENANT, body.id as string);
    expect(stored?.reference_trace_id).toBe(traceId);
    expect(stored?.trace_id ?? null).toBeNull();
    expect(stored?.provenance?.beside).toEqual(['judge']);
  });

  it('a supported citation check does not either', async () => {
    const traceId = await failingTrace();
    verifyCitations.mockResolvedValueOnce({
      overallScore: 1,
      passed: true,
      totalCitationsFound: 1,
      totalResolved: 1,
      totalJudged: 1,
      totalSupported: 1,
      totalUnsupported: 0,
      totalCostUsd: 0.0012,
      citations: [
        {
          citation: { raw: '[1]', kind: 'numbered', identifier: '1', offsetStart: 10, offsetEnd: 13, contextWindow: 'claim' },
          resolveStatus: 'ok',
          source: { url: 'https://example.org/paper', status: 200, contentType: 'text/html', bytesFetched: 4321, truncated: false },
          judge: { supported: true, confidence: 0.9, rationale: 'supports', costUsd: 0.0012, latencyMs: 120, inputTokens: 100, outputTokens: 20 },
        },
      ],
    });
    const body = parse(await client.callTool({ name: 'verify_citations', arguments: { output: 'A claim [1].', model: 'claude-haiku-4-5', trace_id: traceId } }));
    expect(body.passed).toBe(true);
    expect(body).not.toHaveProperty('trace_id');
    expect(body.reference_trace_id).toBe(traceId);
    const run = await storage.getRunResults(LOCAL_TENANT, 'nightly-1');
    expect(run[0].passed).toBe(false);
    expect((await storage.getEvalById(LOCAL_TENANT, body.id as string))?.provenance?.beside).toEqual(['citations']);
  });

  it('with no trace named, neither field appears', async () => {
    callLLMJudge.mockResolvedValueOnce({ content: JSON.stringify({ score: 0.9, rationale: 'fine', dimensions: { a: 0.9 } }), inputTokens: 10, outputTokens: 10, latencyMs: 1, rawProviderResponseId: 'resp-2' });
    const body = parse(await client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'an answer', input: 'a question', template: 'accuracy', model: 'claude-haiku-4-5' } }));
    expect(body).not.toHaveProperty('trace_id');
    expect(body).not.toHaveProperty('reference_trace_id');
  });
});
