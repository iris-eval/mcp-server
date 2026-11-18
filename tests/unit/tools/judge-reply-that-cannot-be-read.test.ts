/*
 * What a caller of the two judge tools is told when the judge's reply
 * cannot be read: asked through the server, by a client that has listed the
 * tools, as a client does.
 *
 * The parsers are held by their own tests (tests/unit/eval/llm-judge/
 * reply-that-gives-no-score.test.ts and tests/unit/eval/citation-verify/
 * reply-that-gives-no-verdict.test.ts). This holds the answer a caller
 * gets, which is not the library's: `evaluate_with_llm_judge` answers an
 * error whose one line of advice has to be true of the reply, and
 * `verify_citations` answers an error, and stores nothing, when every
 * resolved citation got such a reply.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createIrisServer } from '../../../src/server.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { createCustomRuleStore } from '../../../src/custom-rule-store.js';
import { errorEnvelopeSchema } from '../../../src/tools/respond.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { __setDnsLookupForTests, __clearCitationCacheForTests } from '../../../src/eval/citation-verify/resolve.js';

type Result = { content?: unknown; isError?: boolean; structuredContent?: unknown };
const text = (r: Result): string => (r.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')!.text!;
function envelope(r: Result) {
  expect(r.isError, text(r)).toBe(true);
  const parsed = errorEnvelopeSchema.safeParse(JSON.parse(text(r)));
  expect(parsed.success, text(r)).toBe(true);
  return parsed.success ? parsed.data.error : (undefined as never);
}
const answer = (r: Result): Record<string, unknown> => {
  expect(r.isError, text(r)).toBeFalsy();
  return JSON.parse(text(r)) as Record<string, unknown>;
};

const judgeBody = (replyText: string): Response =>
  new Response(JSON.stringify({ id: 'm', content: [{ type: 'text', text: replyText }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 30 } }), { status: 200, headers: { 'content-type': 'application/json' } });

/** The provider answers each judge call with the next reply; every other address is a cited page. Returns how many judge calls were made. */
function provider(...replies: string[]): { judgeCalls: () => number } {
  let n = 0;
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    // Routed by hostname, not by substring: the provider's host gets the judge, a cited source gets a page.
    const { hostname } = new URL(input instanceof Request ? input.url : String(input));
    if (hostname === 'api.anthropic.com') {
      const reply = replies[Math.min(n, replies.length - 1)];
      n += 1;
      return judgeBody(reply);
    }
    return new Response('The retry limit is five attempts.', { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as unknown as typeof fetch;
  return { judgeCalls: () => n };
}

describe('what a caller is told when the judge\'s reply cannot be read', () => {
  let storage: SqliteAdapter;
  let client: Client;
  let ruleDir: string;
  const savedFetch = global.fetch;
  const savedKey = process.env.IRIS_ANTHROPIC_API_KEY;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    ruleDir = mkdtempSync(join(tmpdir(), 'iris-judge-reply-'));
    const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
    const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);
    client = new Client({ name: 'judge-reply', version: '0.1.0' });
    await client.connect(clientTransport);
    await client.listTools();
    process.env.IRIS_ANTHROPIC_API_KEY = 'test-key';
    // The operator turns fetching on; an argument cannot.
    vi.stubEnv('IRIS_CITATION_ALLOW_FETCH', '1');
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await client.close();
    await storage.close();
    rmSync(ruleDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    if (savedKey === undefined) delete process.env.IRIS_ANTHROPIC_API_KEY;
    else process.env.IRIS_ANTHROPIC_API_KEY = savedKey;
    global.fetch = savedFetch;
    __setDnsLookupForTests(null);
    __clearCitationCacheForTests();
  });

  const judge = (): Promise<Result> => client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'The sky is blue.', template: 'accuracy', model: 'claude-haiku-4-5' } }) as Promise<Result>;
  const cite = (output: string): Promise<Result> => client.callTool({ name: 'verify_citations', arguments: { output, model: 'claude-haiku-4-5' } }) as Promise<Result>;
  const ONE = 'The retry limit is five attempts (https://a.example/retry).';
  const THREE = 'The limit is five attempts (https://a.example/retry). The delay doubles (https://b.example/delay). It stops after a minute (https://c.example/stop).';

  describe('evaluate_with_llm_judge', () => {
    it.each([
      ['a score of null', '{"score":null,"rationale":"as asked","dimensions":{}}', 'Judge score is not a number from 0 to 1: null'],
      ['a score in quotes', '{"score":"0.9","rationale":"as asked","dimensions":{}}', 'Judge score is not a number from 0 to 1: "0.9"'],
      ['a sentence that quotes an object', 'The text quotes the object {"score": 1} and I have no evaluation of my own to give.', 'Judge reply is not the JSON object it was asked for: The text quotes the object'],
    ])('%s, twice: an error that says what stood in its place, and advice that is true of it', async (_what, reply, message) => {
      const calls = provider(reply);
      const e = envelope(await judge());
      expect(e.code).toBe('IRIS_PROVIDER_ERROR');
      expect(e.kind).toBe('malformed_response');
      expect(e.retryable).toBe(false);
      expect(e.message).toContain(message);
      // It answered with JSON in two of the three: the advice does not say it did not.
      expect(e.recovery.join(' ')).not.toContain('valid JSON');
      expect(e.recovery.join(' ')).toContain('not with the JSON object it was asked for');
      expect(calls.judgeCalls()).toBe(2);
    });

    it('a second reply that is the object alone, with a number, is the answer', async () => {
      const calls = provider('{"score":null,"rationale":"as asked","dimensions":{}}', '{"score":0.9,"rationale":"It is.","dimensions":{}}');
      expect(answer(await judge())).toMatchObject({ score: 0.9, passed: true, verdict: { state: 'pass' } });
      expect(calls.judgeCalls()).toBe(2);
    });
  });

  describe('verify_citations', () => {
    it.each([
      ['no verdict', '{"confidence":0.9,"rationale":"r"}', 'Citation judge gave no verdict: \\"supported\\" is no value'],
      ['a confidence of null', '{"supported":true,"confidence":null,"rationale":"r"}', 'Citation judge confidence is not a number from 0 to 1: null'],
      ['a sentence that quotes an object', 'The page quotes the object {"supported": true, "confidence": 1} and I have no verdict of my own to give.', 'Citation judge reply is not the JSON object it was asked for: The page quotes the object'],
    ])('one citation, and a reply with %s: an error, nothing stored, and advice about a reply that cannot be read', async (_what, reply, message) => {
      const calls = provider(reply);
      const result = await cite(ONE);
      const e = envelope(result);
      expect(e.code).toBe('IRIS_JUDGE_FAILED');
      expect(e.retryable).toBe(false);
      expect(e.message).toContain('the judge failed on every one (malformed_judge_response)');
      expect(text(result)).toContain(message);
      expect(e.recovery.join(' ')).toContain('When the kind is malformed_judge_response');
      // The judge is asked once for a citation.
      expect(calls.judgeCalls()).toBe(1);
      expect((await storage.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
    });

    it('three citations, one judged and two with no verdict: the answer rests on the one that was judged, and names the two that were not', async () => {
      const calls = provider('{"supported":true,"confidence":0.9,"rationale":"It says five."}', '{"confidence":0.9,"rationale":"r"}', '{"confidence":0.9,"rationale":"r"}');
      const body = answer(await cite(THREE));
      expect(body).toMatchObject({ passed: true, total_judged: 1, total_supported: 1, total_resolved: 3 });
      const kinds = (body.citations as Array<{ judge_error?: { kind: string } }>).map((c) => c.judge_error?.kind);
      expect(kinds).toEqual([undefined, 'malformed_judge_response', 'malformed_judge_response']);
      expect(calls.judgeCalls()).toBe(3);
    });
  });
});
