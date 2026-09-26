/*
 * verify_citations reports each failure under the stage that failed (#407).
 *
 * Until 0.20.0 a citation whose source resolved and whose judge call then
 * failed carried `resolve_status: "ok"` and the judge's error under
 * `resolve_error` — a field that says the source failed, when it had not.
 * A `resolve_error.kind` of `timeout` could have been the fetch or the judge.
 *
 * These run the real tool, the real verifier and the real judge client over
 * an in-memory MCP transport. Only the network is replaced: the cited hosts
 * and the provider are answered by a fetch routed on hostname.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { __clearCitationCacheForTests, __setDnsLookupForTests } from '../../../src/eval/citation-verify/resolve.js';
import { unjudgedSummary } from '../../../src/tools/verify-citations.js';

type Result = { content?: unknown; isError?: boolean };
type Citation = {
  citation: { raw: string };
  resolve_status: string;
  resolve_error?: { kind: string; message: string };
  judge_error?: { kind: string; message: string };
  judge?: { supported: boolean };
};
const body = (r: Result) =>
  JSON.parse((r.content as Array<{ type: string; text: string }>).find((c) => c.type === 'text')!.text) as Record<string, unknown>;

const supportedVerdict = () =>
  new Response(
    JSON.stringify({
      id: 'msg_1',
      content: [{ type: 'text', text: '{"supported":true,"confidence":0.9,"rationale":"the page states it"}' }],
      usage: { input_tokens: 50, output_tokens: 10 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/**
 * Sources by hostname; the provider answers each judge call in turn from
 * `judge`. Routed on the parsed hostname, never a substring of the URL.
 */
function network(sources: Record<string, () => Response>, judge: Array<() => Response | Promise<Response>>) {
  let judgeCall = 0;
  return vi.fn(async (input: RequestInfo | URL) => {
    const { hostname } = new URL(input instanceof Request ? input.url : String(input));
    if (hostname === 'api.anthropic.com') {
      const reply = judge[judgeCall] ?? judge[judge.length - 1];
      judgeCall += 1;
      return reply();
    }
    const source = sources[hostname];
    if (!source) throw new Error(`unexpected fetch to ${hostname}`);
    return source();
  }) as unknown as typeof fetch;
}

const page = (text: string) => () => new Response(text, { status: 200, headers: { 'content-type': 'text/plain' } });

describe('verify_citations: judge failures under judge_error, source failures under resolve_error (#407)', () => {
  let client: Client;
  let storage: SqliteAdapter;
  let ruleDir: string;
  const savedKey = process.env.IRIS_ANTHROPIC_API_KEY;
  const savedFetch = global.fetch;

  beforeEach(async () => {
    process.env.IRIS_ANTHROPIC_API_KEY = 'test-key';
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-judge-error-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'judge-error', version: '0.1.0' });
    await client.connect(clientTransport);
  });

  afterEach(async () => {
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true });
    global.fetch = savedFetch;
    __clearCitationCacheForTests();
    __setDnsLookupForTests(null);
    if (savedKey === undefined) delete process.env.IRIS_ANTHROPIC_API_KEY;
    else process.env.IRIS_ANTHROPIC_API_KEY = savedKey;
  });

  it('a judge timeout on a resolved source is judge_error; a dead link is resolve_error; the stored row names both by stage', async () => {
    global.fetch = network(
      { 'a.example': page('Alpha is 42.'), 'b.example': page('Beta is 7.'), 'c.example': () => new Response('', { status: 404 }) },
      [
        supportedVerdict,
        // The judge client turns an aborted request into LLMJudgeError 'timeout'.
        async () => {
          throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
        },
      ],
    );

    const r = (await client.callTool({
      name: 'verify_citations',
      arguments: {
        output: 'Alpha is 42 (https://a.example/alpha). Beta is 7 (https://b.example/beta). Gamma is 3 (https://c.example/gamma).',
        model: 'claude-haiku-4-5',
        allow_fetch: true,
      },
    })) as Result;
    expect(r.isError).toBeFalsy();
    const out = body(r);
    const [a, b, c] = out.citations as Citation[];

    expect(a.resolve_status).toBe('ok');
    expect(a.judge?.supported).toBe(true);
    expect(a.resolve_error).toBeUndefined();
    expect(a.judge_error).toBeUndefined();

    // The source resolved; the judge timed out. Only judge_error says so.
    expect(b.resolve_status).toBe('ok');
    expect(b.judge).toBeUndefined();
    expect(b.judge_error?.kind).toBe('timeout');
    expect(b.resolve_error).toBeUndefined();

    // The source did not resolve; the judge never ran.
    expect(c.resolve_status).toBe('error');
    expect(c.resolve_error?.kind).toBe('bad_status');
    expect(c.judge_error).toBeUndefined();

    // Neither failure is scored as unsupported.
    expect(out.total_resolved).toBe(2);
    expect(out.total_judged).toBe(1);
    expect(out.overall_score).toBe(1);
    expect(out.passed).toBe(true);

    const stored = await storage.getEvalById(LOCAL_TENANT, out.id as string);
    expect(stored?.rule_results[0].message).toBe(
      '1/1 judged sources supported the output. Not judged: the judge failed on 1 resolved source (timeout); 1 source was not resolved (bad_status).',
    );
  });

  it('cost_cap_reached and an unreadable verdict are judge_error, and the tool response still validates', async () => {
    global.fetch = network(
      { 'a.example': page('Alpha is 42.'), 'b.example': page('Beta is 7.') },
      [
        () =>
          new Response(
            JSON.stringify({ id: 'msg_2', content: [{ type: 'text', text: 'I cannot answer in that format.' }], usage: { input_tokens: 50, output_tokens: 10 } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ],
    );
    const unreadable = body(
      (await client.callTool({
        name: 'verify_citations',
        arguments: { output: 'Alpha is 42 (https://a.example/alpha). Beta is 7 (https://b.example/beta).', model: 'claude-haiku-4-5', allow_fetch: true },
      })) as Result,
    );
    // Both judge calls replied with prose: nothing was judged, so the tool
    // fails closed — IRIS_JUDGE_FAILED — rather than returning a verdict.
    expect(unreadable.error).toMatchObject({ code: 'IRIS_JUDGE_FAILED' });
    expect(String((unreadable.error as { message: string }).message)).toContain('malformed_judge_response');

    __clearCitationCacheForTests();
    global.fetch = network({ 'a.example': page('Alpha is 42.') }, [supportedVerdict]);
    const capped = (await client.callTool({
      name: 'verify_citations',
      arguments: { output: 'Alpha is 42 (https://a.example/alpha).', model: 'claude-haiku-4-5', allow_fetch: true, max_cost_usd_total: 0.000001 },
    })) as Result;
    const cappedBody = body(capped);
    expect(cappedBody.error).toMatchObject({ code: 'IRIS_JUDGE_FAILED' });
    expect(String((cappedBody.error as { message: string }).message)).toContain('cost_cap_reached');
    expect((await storage.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
  });

  it('a cost cap after one verdict is reported on the citation it stopped on, as judge_error', async () => {
    global.fetch = network(
      { 'a.example': page('Alpha is 42.'), 'b.example': page('Beta is 7.') },
      [
        () =>
          new Response(
            JSON.stringify({
              id: 'msg_3',
              content: [{ type: 'text', text: '{"supported":true,"confidence":1,"rationale":"x"}' }],
              usage: { input_tokens: 500_000, output_tokens: 100_000 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
      ],
    );
    const out = body(
      (await client.callTool({
        name: 'verify_citations',
        arguments: { output: 'Alpha is 42 (https://a.example/alpha). Beta is 7 (https://b.example/beta).', model: 'claude-haiku-4-5', allow_fetch: true, max_cost_usd_total: 0.5 },
      })) as Result,
    );
    const [, b] = out.citations as Citation[];
    expect(b.resolve_status).toBe('ok');
    expect(b.judge_error?.kind).toBe('cost_cap_reached');
    expect(b.resolve_error).toBeUndefined();
    const stored = await storage.getEvalById(LOCAL_TENANT, out.id as string);
    expect(stored?.rule_results[0].message).toContain('the judge failed on 1 resolved source (cost_cap_reached)');
  });
});

describe('unjudgedSummary', () => {
  it('is empty when every citation was judged', () => {
    expect(unjudgedSummary([{ resolveStatus: 'ok' }, { resolveStatus: 'ok' }])).toBe('');
  });

  it('counts each stage apart, with a stable, tallied list of kinds', () => {
    const judge = (kind: string) => ({ resolveStatus: 'ok', judgeError: { kind, message: kind } });
    const source = (kind: string) => ({ resolveStatus: 'error', resolveError: { kind, message: kind } });
    expect(unjudgedSummary([judge('timeout'), source('ssrf'), judge('auth'), judge('timeout'), source('bad_status')])).toBe(
      'Not judged: the judge failed on 3 resolved sources (auth, timeout: 2); 2 sources were not resolved (bad_status, ssrf).',
    );
  });

  it('counts a skipped citation as not resolved', () => {
    expect(unjudgedSummary([{ resolveStatus: 'skipped', resolveError: { kind: 'unresolvable_kind', message: 'x' } }])).toBe(
      'Not judged: 1 source was not resolved (unresolvable_kind).',
    );
  });
});
