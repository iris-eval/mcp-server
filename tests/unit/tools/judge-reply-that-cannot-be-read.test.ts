/*
 * What a caller of the judge tools is told when the judge's reply cannot be
 * read: asked through the server, by a client that has listed the tools, as
 * a client does.
 *
 * The parsers are held by their own tests (tests/unit/eval/llm-judge/
 * reply-that-gives-no-score.test.ts and tests/unit/eval/citation-verify/
 * reply-that-gives-no-verdict.test.ts). This holds the answer a caller
 * gets, which is not the library's: `evaluate_with_llm_judge` answers an
 * error whose one line of advice has to be true of the reply;
 * `verify_citations` answers an error, and stores nothing, when every
 * resolved citation got such a reply; `evaluate_output` with a relevance
 * judge installed answers a verdict the judge had no part in; and each
 * charges the day's budget by its own rule.
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
import { worstCaseJudgeCostUsd } from '../../../src/eval/llm-judge/evaluator.js';
import { estimateCostUsd } from '../../../src/eval/llm-judge/pricing.js';

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

const MODEL = 'claude-haiku-4-5';
// What the stand-in provider bills a call: 100 tokens in and 30 out.
const ONE_CALL_USD = estimateCostUsd(MODEL, 100, 30)!;
const judgeBody = (replyText: string): Response =>
  new Response(JSON.stringify({ id: 'm', content: [{ type: 'text', text: replyText }], stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 30 } }), { status: 200, headers: { 'content-type': 'application/json' } });
/** A reply whose compressed body arrived and could not be decoded, with the error Node's fetch gives (zlib's code on the cause). */
const undecodableReply = (): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.error(new TypeError('terminated', { cause: Object.assign(new Error('incorrect header check'), { code: 'Z_DATA_ERROR' }) }));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
const serverError = (): Response => new Response(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'the provider is down' } }), { status: 500, headers: { 'content-type': 'application/json' } });

/** The provider answers each judge call with the next reply (a text, or a response of its own making); every other address is a cited page. Returns how many judge calls were made. */
function provider(...replies: Array<string | (() => Response)>): { judgeCalls: () => number } {
  let n = 0;
  global.fetch = vi.fn(async (input: string | URL | Request) => {
    // Routed by hostname, not by substring: the provider's host gets the judge, a cited source gets a page.
    const { hostname } = new URL(input instanceof Request ? input.url : String(input));
    if (hostname === 'api.anthropic.com') {
      const reply = replies[Math.min(n, replies.length - 1)];
      n += 1;
      return typeof reply === 'string' ? judgeBody(reply) : reply();
    }
    return new Response('The retry limit is five attempts.', { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as unknown as typeof fetch;
  return { judgeCalls: () => n };
}

/** A server over an in-memory transport, and a client that has listed its tools. */
interface Running {
  storage: SqliteAdapter;
  client: Client;
  stop: () => Promise<void>;
}
async function start(): Promise<Running> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const ruleDir = mkdtempSync(join(tmpdir(), 'iris-judge-reply-'));
  const ruleStore = createCustomRuleStore({ pathFor: () => join(ruleDir, 'custom-rules.json'), auditPath: join(ruleDir, 'audit.log') });
  const { mcpServer } = createIrisServer(defaultConfig, storage, ruleStore);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await mcpServer.connect(serverTransport);
  const client = new Client({ name: 'judge-reply', version: '0.1.0' });
  await client.connect(clientTransport);
  await client.listTools();
  return {
    storage,
    client,
    stop: async () => {
      await client.close();
      await storage.close();
      rmSync(ruleDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    },
  };
}
/** What the day's judge budget has been charged so far, as the server's own capabilities resource reports it. */
async function spent(client: Client): Promise<number> {
  const r = await client.readResource({ uri: 'iris://capabilities' });
  const caps = JSON.parse((r.contents[0] as { text: string }).text) as { judge: { dailyBudget: { spentUsd: number } | null } };
  return caps.judge.dailyBudget!.spentUsd;
}

const savedFetch = global.fetch;

describe('what a caller is told when the judge\'s reply cannot be read', () => {
  let running: Running;

  beforeEach(async () => {
    vi.stubEnv('IRIS_ANTHROPIC_API_KEY', 'test-key');
    // The operator turns fetching on; an argument cannot.
    vi.stubEnv('IRIS_CITATION_ALLOW_FETCH', '1');
    running = await start();
    __setDnsLookupForTests(async () => [{ address: '93.184.216.34', family: 4 }]);
  });

  afterEach(async () => {
    await running.stop();
    vi.unstubAllEnvs();
    global.fetch = savedFetch;
    __setDnsLookupForTests(null);
    __clearCitationCacheForTests();
  });

  const judge = (): Promise<Result> => running.client.callTool({ name: 'evaluate_with_llm_judge', arguments: { output: 'The sky is blue.', template: 'accuracy', model: MODEL } }) as Promise<Result>;
  const cite = (output: string): Promise<Result> => running.client.callTool({ name: 'verify_citations', arguments: { output, model: MODEL } }) as Promise<Result>;
  const ONE = 'The retry limit is five attempts (https://a.example/retry).';
  const TWO = 'The limit is five attempts (https://a.example/retry). The delay doubles (https://b.example/delay).';
  const THREE = `${TWO} It stops after a minute (https://c.example/stop).`;

  describe('evaluate_with_llm_judge', () => {
    it.each([
      ['a score of null', '{"score":null,"rationale":"as asked","dimensions":{}}', 'Judge score is not a number from 0 to 1: null'],
      ['a score in quotes', '{"score":"0.9","rationale":"as asked","dimensions":{}}', 'Judge score is not a number from 0 to 1: "0.9"'],
      ['no object at all', 'I cannot evaluate this text.', 'Judge reply is not the JSON object it was asked for: I cannot evaluate this text.'],
    ])('%s, twice: an error that shows what stood in its place, and advice that is true of it', async (_what, reply, message) => {
      const calls = provider(reply);
      const e = envelope(await judge());
      expect(e.code).toBe('IRIS_PROVIDER_ERROR');
      expect(e.kind).toBe('malformed_response');
      expect(e.retryable).toBe(false);
      expect(e.message).toContain(message);
      // It answered with JSON in two of the three: the advice does not say it did not.
      expect(e.recovery.join(' ')).not.toContain('valid JSON');
      expect(e.recovery.join(' ')).toContain("where the judge's text held no verdict, it shows what stood where the verdict belongs, or the start of it");
      expect(e.recovery).toContain('Otherwise, retry; if it recurs, pick another model.');
      expect(calls.judgeCalls()).toBe(2);
      expect((await running.storage.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
    });

    it.each([
      ['could not be decoded', undecodableReply, 'Anthropic reply could not be decoded: terminated (Z_DATA_ERROR)'],
      ['is not JSON', () => new Response('<html>a gateway page</html>', { status: 200, headers: { 'content-type': 'text/html' } }), 'Anthropic response was not valid JSON'],
    ])('a reply that %s, once: advice that sends it to what stands between this server and the provider', async (_what, reply, message) => {
      const calls = provider(reply);
      const e = envelope(await judge());
      expect(e.code).toBe('IRIS_PROVIDER_ERROR');
      expect(e.kind).toBe('malformed_response');
      expect(e.retryable).toBe(false);
      expect(e.message).toContain(message);
      expect(e.recovery).toContain(
        'Where the message says the reply could not be decoded, or the response was not JSON or not a JSON object, retry; if it recurs, check what stands between this server and the provider (a proxy can alter a reply).',
      );
      // The provider's reply is not asked again: only a judge's text that held no verdict is.
      expect(calls.judgeCalls()).toBe(1);
      expect((await running.storage.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
    });

    it('a second reply that gives a score is the answer', async () => {
      const calls = provider('{"score":null,"rationale":"as asked","dimensions":{}}', '{"score":0.9,"rationale":"It is.","dimensions":{}}');
      expect(answer(await judge())).toMatchObject({ score: 0.9, passed: true, verdict: { state: 'pass' } });
      expect(calls.judgeCalls()).toBe(2);
    });

    it('asked for as structured output, the answer is the object alone: with a sentence before it and a fence around it, it is not the object asked for, and the error shows the reply', async () => {
      const reply = 'Here is the evaluation:\n```json\n{"score":0.9,"rationale":"It is.","dimensions":{}}\n```';
      const calls = provider(reply);
      const e = envelope(await judge());
      expect(e.kind).toBe('malformed_response');
      expect(e.message).toContain('Judge reply is not the JSON object it was asked for: Here is the evaluation:');
      expect(calls.judgeCalls()).toBe(2);
      // The object alone is the answer, on one call.
      const alone = provider('{"score":0.9,"rationale":"It is.","dimensions":{}}');
      expect(answer(await judge())).toMatchObject({ score: 0.9, passed: true });
      expect(alone.judgeCalls()).toBe(1);
    });

    it('the day\'s budget: a call that ends with no verdict is charged the worst case it was priced at, and an answer what its calls cost', async () => {
      provider('{"score":null,"rationale":"as asked","dimensions":{}}');
      let before = await spent(running.client);
      envelope(await judge());
      const worst = worstCaseJudgeCostUsd({ template: 'accuracy', model: MODEL, output: 'The sky is blue.' })!;
      expect((await spent(running.client)) - before).toBeCloseTo(worst, 9);
      // More than the two calls used: the worst case bills the full output cap of each.
      expect(worst).toBeGreaterThan(2 * ONE_CALL_USD);
      provider('{"score":0.9,"rationale":"It is.","dimensions":{}}');
      before = await spent(running.client);
      answer(await judge());
      expect((await spent(running.client)) - before).toBeCloseTo(ONE_CALL_USD, 9);
    });
  });

  describe('verify_citations', () => {
    it.each([
      ['no verdict', '{"confidence":0.9,"rationale":"r"}', 'Citation judge gave no verdict: \\"supported\\" is no value'],
      ['a confidence of null', '{"supported":true,"confidence":null,"rationale":"r"}', 'Citation judge confidence is not a number from 0 to 1: null'],
      ['no object at all', 'I cannot answer in the requested format.', 'Citation judge reply is not the JSON object it was asked for: I cannot answer in the requested format.'],
    ])('one citation, and a reply with %s: an error, nothing stored, and advice about a reply that cannot be read', async (_what, reply, message) => {
      const calls = provider(reply);
      const result = await cite(ONE);
      const e = envelope(result);
      expect(e.code).toBe('IRIS_JUDGE_FAILED');
      expect(e.retryable).toBe(false);
      expect(e.message).toContain('the judge failed on every one (malformed_judge_response)');
      expect(e.message).toContain('First error: Citation judge ');
      expect(text(result)).toContain(message);
      expect(e.recovery.join(' ')).toContain('When the kind is malformed_judge_response');
      expect(e.recovery.join(' ')).toContain('the error of that kind shows the start of what stood in its place');
      // The judge is asked once for a citation.
      expect(calls.judgeCalls()).toBe(1);
      expect((await running.storage.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
    });

    it('one citation, and a reply that could not be decoded: an error, nothing stored, and advice that sends it to what stands between this server and the provider', async () => {
      const calls = provider(undecodableReply);
      const result = await cite(ONE);
      const e = envelope(result);
      expect(e.code).toBe('IRIS_JUDGE_FAILED');
      expect(e.retryable).toBe(false);
      expect(e.message).toContain('the judge failed on every one (malformed_response)');
      expect(text(result)).toContain('Anthropic reply could not be decoded: terminated (Z_DATA_ERROR)');
      expect(e.recovery).toContain(
        "When the kind is malformed_response, the provider's reply could not be read, and the error of that kind says why. Retry; if it recurs, check what stands between this server and the provider (a proxy can alter a reply) where it says the reply could not be decoded or the response was not JSON or not a JSON object, and otherwise pick another model.",
      );
      expect(calls.judgeCalls()).toBe(1);
      expect((await running.storage.queryEvalResults(LOCAL_TENANT, {})).total).toBe(0);
    });

    it('two citations that fail in two ways: the error names both kinds, and shows the first error of each', async () => {
      const calls = provider(serverError, '{"confidence":0.9,"rationale":"r"}');
      const e = envelope(await cite(TWO));
      expect(e.code).toBe('IRIS_JUDGE_FAILED');
      expect(e.message).toContain('the judge failed on every one (server_error, malformed_judge_response)');
      expect(e.message).toContain('First error of each kind: server_error: ');
      // What stood where the verdict belongs is there to read, though another failure came first.
      expect(e.message).toContain(' | malformed_judge_response: Citation judge gave no verdict: "supported" is no value');
      expect(e.retryable).toBe(true);
      expect(calls.judgeCalls()).toBe(2);
    });

    it('three citations, one judged and two with no verdict: the answer rests on the one that was judged, and names the two that were not', async () => {
      const calls = provider('{"supported":true,"confidence":0.9,"rationale":"It says five."}', '{"confidence":0.9,"rationale":"r"}', '{"confidence":0.9,"rationale":"r"}');
      const body = answer(await cite(THREE));
      expect(body).toMatchObject({ passed: true, total_judged: 1, total_supported: 1, total_resolved: 3 });
      const kinds = (body.citations as Array<{ judge_error?: { kind: string } }>).map((c) => c.judge_error?.kind);
      expect(kinds).toEqual([undefined, 'malformed_judge_response', 'malformed_judge_response']);
      expect(calls.judgeCalls()).toBe(3);
    });

    it('a verdict of "not supported" is read as given, and fails the output; given with a sentence before it, it is not the object asked for, and that citation is not judged', async () => {
      const calls = provider('{"supported":true,"confidence":0.9,"rationale":"It says five."}', '{"supported":false,"confidence":0.9,"rationale":"It does not say that."}');
      const body = answer(await cite(TWO));
      expect(body).toMatchObject({ passed: false, total_judged: 2, total_supported: 1, total_resolved: 2 });
      const second = (body.citations as Array<{ judge_error?: unknown; judge?: { supported: boolean } }>)[1];
      expect(second.judge_error).toBeUndefined();
      expect(second.judge).toMatchObject({ supported: false });
      // The citation judge is asked once for each citation.
      expect(calls.judgeCalls()).toBe(2);
      __clearCitationCacheForTests();
      provider('{"supported":true,"confidence":0.9,"rationale":"It says five."}', 'My verdict:\n{"supported":false,"confidence":0.9,"rationale":"It does not say that."}');
      const wrapped = answer(await cite(TWO));
      expect(wrapped).toMatchObject({ total_judged: 1, total_supported: 1, total_resolved: 2 });
      const kinds = (wrapped.citations as Array<{ judge_error?: { kind: string } }>).map((c) => c.judge_error?.kind);
      expect(kinds).toEqual([undefined, 'malformed_judge_response']);
    });

    it('the day\'s budget: a citation whose reply cannot be read is charged what its one call cost', async () => {
      provider('{"confidence":0.9,"rationale":"r"}');
      const before = await spent(running.client);
      envelope(await cite(ONE));
      expect((await spent(running.client)) - before).toBeCloseTo(ONE_CALL_USD, 9);
    });
  });
});

describe('what a caller is told when the relevance judge\'s reply cannot be read', () => {
  let running: Running;
  const ASK = 'What is the capital of France, and roughly how many people live there?';
  const OFF_THE_SUBJECT = 'Bananas are grown in the tropics. They ripen after they are picked. Most are eaten raw.';

  beforeEach(async () => {
    vi.stubEnv('IRIS_ANTHROPIC_API_KEY', 'test-key');
    // The operator installs the judge by naming its model, before the server starts.
    vi.stubEnv('IRIS_RELEVANCE_JUDGE_MODEL', MODEL);
    running = await start();
  });

  afterEach(async () => {
    await running.stop();
    vi.unstubAllEnvs();
    global.fetch = savedFetch;
  });

  const relevance = (): Promise<Result> => running.client.callTool({ name: 'evaluate_output', arguments: { eval_type: 'relevance', input: ASK, output: OFF_THE_SUBJECT } }) as Promise<Result>;
  const aboutTheJudge = (body: Record<string, unknown>): string[] => ((body.interpretations ?? []) as Array<{ text: string }>).map((i) => i.text).filter((t) => t.includes('relevance judge'));

  it('a score the judge gives is the verdict: an answer off the subject fails, on one call', async () => {
    const calls = provider('{"score":0.1,"rationale":"It is about bananas.","dimensions":{}}');
    const body = answer(await relevance());
    expect(body.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate' });
    expect(aboutTheJudge(body)).toEqual([]);
    expect(calls.judgeCalls()).toBe(1);
  });

  it.each([
    ['no score', '{"score":null,"rationale":"It is about bananas.","dimensions":{}}'],
    ['its score in quotes', '{"score":"0.1","rationale":"It is about bananas.","dimensions":{}}'],
  ])('%s, twice: the judge did not answer, the rule falls back to a reading that only advises, and the answer says so', async (_what, reply) => {
    const calls = provider(reply);
    const before = await spent(running.client);
    const body = answer(await relevance());
    // The answer the judge would have failed passes, and is told why.
    expect(body.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    const said = aboutTheJudge(body);
    expect(said).toHaveLength(1);
    expect(said[0]).toContain('did not answer, so answers_the_ask fell back to its lexical reading');
    expect(calls.judgeCalls()).toBe(2);
    // Charged at the worst case the two calls were priced at, which is more than they used.
    const worst = worstCaseJudgeCostUsd({ template: 'relevance', model: MODEL, input: ASK, output: OFF_THE_SUBJECT })!;
    expect((await spent(running.client)) - before).toBeCloseTo(worst, 9);
    expect(worst).toBeGreaterThan(2 * ONE_CALL_USD);
  });
});
