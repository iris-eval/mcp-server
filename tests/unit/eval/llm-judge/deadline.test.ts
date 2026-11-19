/*
 * A judge call answers inside its deadline: every request, its whole reply
 * and the wait after a rate limit share one time (timeout_ms, default
 * 50,000 ms), so the call answers before an MCP client's own 60-second
 * timeout. A reply whose body never ends is ended by the deadline, a rate
 * limit whose wait would outlast it is answered at once, a request that
 * cannot be made is the provider's failure, a reply cut off before its end
 * is read by its status, a key a header cannot carry is never sent, and a
 * reply that is not of the shape the provider documents is a malformed
 * reply. Fake timers: nothing here waits for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_REQUEST_TIMEOUT_MSEC } from '@modelcontextprotocol/sdk/shared/protocol.js';
import { callLLMJudge, LLMJudgeError, type LLMJudgeRequest } from '../../../../src/eval/llm-judge/client.js';
import { DEFAULT_JUDGE_DEADLINE_MS } from '../../../../src/eval/llm-judge/deadline.js';
import { evaluateWithLLMJudge } from '../../../../src/eval/llm-judge/evaluator.js';
import { createRelevanceJudge } from '../../../../src/eval/llm-judge/relevance-judge.js';
import { verifyCitations } from '../../../../src/eval/citation-verify/verifier.js';
import { __clearCitationCacheForTests, __setDnsLookupForTests } from '../../../../src/eval/citation-verify/resolve.js';
import { toIrisError } from '../../../../src/tools/errors.js';

const originalFetch = global.fetch;
const REQUEST: LLMJudgeRequest = { provider: 'anthropic', model: 'claude-haiku-4-5', systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 100, temperature: 0, apiKey: 'k' };
const VERDICT = '{"score":0.9,"passed":true,"rationale":"on the subject"}';
const JUDGMENT = JSON.stringify({ id: 'm', content: [{ type: 'text', text: VERDICT }], usage: { input_tokens: 10, output_tokens: 5 } });

/** A reply that begins at once and whose body never ends, but for an abort of the request. */
const endless = (init: RequestInit): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":"m",'));
        init.signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('This operation was aborted'), { name: 'AbortError' })));
      },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

/** A reply whose body is cut off after its first bytes, with the error the runtime gives a connection closed mid-body. */
const cutOff = (status: number, headers: Record<string, string> = {}): Response =>
  new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"id":'));
        controller.error(new TypeError('terminated', { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }));
      },
    }),
    { status, headers },
  );

/** The provider answers with `judge`; any other host (a cited source) with a page of text. */
const routed = (judge: (init: RequestInit) => Response): typeof fetch =>
  vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const { hostname } = new URL(input instanceof Request ? input.url : String(input));
    return hostname === 'api.anthropic.com' ? judge(init ?? {}) : new Response('The source says so.', { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as unknown as typeof fetch;

/** Settles a promise under fake timers: the clock is moved until it does, and what it settled with is returned. */
async function settle<T>(p: Promise<T>, ms: number): Promise<{ value?: T; error?: unknown; at: number }> {
  const started = Date.now();
  const out: { value?: T; error?: unknown; at: number } = { at: -1 };
  const done = p.then(
    (value) => ((out.value = value), (out.at = Date.now() - started)),
    (error: unknown) => ((out.error = error), (out.at = Date.now() - started)),
  );
  await vi.advanceTimersByTimeAsync(ms);
  await done;
  return out;
}

describe('a judge call answers inside its deadline', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    global.fetch = originalFetch;
    vi.useRealTimers();
  });

  it('is 50 seconds where the caller names none, below the 60 seconds an MCP client built on the TypeScript SDK waits by default', () => {
    expect(DEFAULT_JUDGE_DEADLINE_MS).toBe(50_000);
    expect(DEFAULT_REQUEST_TIMEOUT_MSEC).toBe(60_000);
    expect(DEFAULT_JUDGE_DEADLINE_MS).toBeLessThan(DEFAULT_REQUEST_TIMEOUT_MSEC);
  });

  it('where the caller names no deadline, the call ends at 50 seconds: the client, the evaluator, the citation judge and the relevance judge', async () => {
    const named = 'Anthropic did not answer within 50000 ms';
    global.fetch = routed(endless);
    const client = await settle(callLLMJudge({ ...REQUEST }), 60_000);
    expect(client.error).toMatchObject({ kind: 'timeout', message: named });
    expect(client.at).toBe(50_000);
    const evaluator = await settle(evaluateWithLLMJudge({ template: 'accuracy', output: 'The sky is blue.', provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k' }), 60_000);
    expect(evaluator.error).toMatchObject({ kind: 'timeout', message: named });
    expect(evaluator.at).toBe(50_000);
    __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
    try {
      const cited = await settle(verifyCitations({ output: 'The sky is blue https://a.example/sky.', provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k', allowFetch: true }), 60_000);
      expect(cited.value?.citations[0].judgeError).toMatchObject({ kind: 'timeout', message: named });
      expect(cited.at).toBe(50_000);
    } finally {
      __setDnsLookupForTests(null);
      __clearCitationCacheForTests();
    }
    const relevance = await settle(createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'k' }).judge({ input: 'What colour is the sky on a clear day?', output: 'The sky is blue on a clear day.' }), 60_000);
    expect(relevance.value?.error).toContain(named);
    expect(relevance.at).toBe(50_000);
  });

  it('a reply that begins at once and whose body never ends is ended by the deadline, as a timeout', async () => {
    global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => endless(init ?? {})) as typeof fetch;
    const r = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 1_000 }), 1_500);
    expect(r.error).toBeInstanceOf(LLMJudgeError);
    expect(r.error).toMatchObject({ kind: 'timeout', message: 'Anthropic did not answer within 1000 ms' });
    expect(r.at).toBe(1_000);
  });

  it('a rate limit whose wait would outlast the deadline is answered at once, with the wait the provider asked for', async () => {
    global.fetch = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '30' } })) as typeof fetch;
    const r = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 10_000 }), 1_000);
    expect(r.error).toMatchObject({ kind: 'rate_limit', retryAfterSeconds: 30 });
    expect(r.at).toBe(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
    expect(toIrisError(r.error).envelope).toMatchObject({ code: 'IRIS_PROVIDER_ERROR', kind: 'rate_limit', retryable: true, retryAfterMs: 30_000 });
  });

  it('a wait that ends exactly at the deadline is not waited out: the rate limit is answered at once', async () => {
    global.fetch = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': '5' } })) as typeof fetch;
    const r = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 5_000 }), 6_000);
    expect(r.error).toMatchObject({ kind: 'rate_limit', retryAfterSeconds: 5 });
    expect(r.at).toBe(0);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('a rate limit whose wait fits is waited out and asked again, and the second request has what is left of the same deadline', async () => {
    let n = 0;
    global.fetch = vi.fn(async () => (n++ === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }) : new Response(JUDGMENT, { status: 200 }))) as typeof fetch;
    const answered = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 10_000 }), 5_000);
    expect(answered.value?.content).toBe(VERDICT);
    expect(answered.at).toBe(3_000);
    expect(global.fetch).toHaveBeenCalledTimes(2);

    // The second reply never ends: the call ends at the first request's deadline, not three seconds after it.
    let m = 0;
    global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
      m++ === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }) : endless(init ?? {}),
    ) as typeof fetch;
    const ended = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 10_000 }), 15_000);
    expect(ended.error).toMatchObject({ kind: 'timeout', message: 'Anthropic did not answer within 10000 ms' });
    expect(ended.at).toBe(10_000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('Retry-After is a number of seconds from 0, or an HTTP date; anything else names no wait, and Iris then waits 2 seconds', async () => {
    // The wait read is the time between the first request and the second, under a deadline long enough for any of them.
    const gapFor = async (headers: Record<string, string>): Promise<number> => {
      const at: number[] = [];
      global.fetch = vi.fn(async () => {
        at.push(Date.now());
        return at.length === 1 ? new Response('slow down', { status: 429, headers }) : new Response(JUDGMENT, { status: 200 });
      }) as typeof fetch;
      const r = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 60_000 }), 30_000);
      expect(r.value?.content, JSON.stringify(headers)).toBe(VERDICT);
      return at[1] - at[0];
    };
    expect(await gapFor({ 'retry-after': '0' })).toBe(0);
    expect(await gapFor({ 'retry-after': '7' })).toBe(7_000);
    expect(await gapFor({ 'retry-after': '1.5' })).toBe(1_500);
    expect(await gapFor({ 'retry-after': ' 7 ' })).toBe(7_000);
    for (const none of ['-1', '1,5', 'soon', '+5', '5e0', '1.', '.5']) expect(await gapFor({ 'retry-after': none }), none).toBe(2_000);
    // A date of the right shape that names no day there is: no wait.
    expect(await gapFor({ 'retry-after': 'Mon, 99 Nov 2026 10:00:00 GMT' })).toBe(2_000);
    expect(await gapFor({ 'retry-after': new Date(Date.now() + 10_000).toUTCString() })).toBe(10_000);
    expect(await gapFor({ 'retry-after': new Date(Date.now() - 10_000).toUTCString() })).toBe(0);
  });

  it("Anthropic's reset time is read where Retry-After names none, also where Retry-After is present and empty, and only as an ISO 8601 date and time", async () => {
    const gapFor = async (headers: Record<string, string>): Promise<number> => {
      const at: number[] = [];
      global.fetch = vi.fn(async () => {
        at.push(Date.now());
        return at.length === 1 ? new Response('slow down', { status: 429, headers }) : new Response(JUDGMENT, { status: 200 });
      }) as typeof fetch;
      await settle(callLLMJudge({ ...REQUEST, timeoutMs: 60_000 }), 30_000);
      return at[1] - at[0];
    };
    const reset = 'anthropic-ratelimit-requests-reset';
    expect(await gapFor({ [reset]: new Date(Date.now() + 4_000).toISOString() })).toBe(4_000);
    expect(await gapFor({ 'retry-after': '', [reset]: new Date(Date.now() + 5_000).toISOString() })).toBe(5_000);
    expect(await gapFor({ [reset]: new Date(Date.now() + 5_000).toUTCString() })).toBe(2_000);
    // What was read is carried where the wait would outlast the deadline.
    global.fetch = vi.fn(async () => new Response('slow down', { status: 429, headers: { [reset]: new Date(Date.now() + 4_000).toISOString() } })) as typeof fetch;
    const r = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 1_000 }), 10);
    expect((r.error as LLMJudgeError).retryAfterSeconds).toBe(4);
  });

  it('a request that cannot be made is the provider failing to be reached, with its reason', async () => {
    global.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
    }) as typeof fetch;
    const r = await settle(callLLMJudge({ ...REQUEST }), 10);
    expect(r.error).toMatchObject({ kind: 'unreachable', message: 'Anthropic could not be reached: fetch failed (ECONNREFUSED)' });
    global.fetch = vi.fn(async () => {
      throw null;
    }) as typeof fetch;
    const nothing = await settle(callLLMJudge({ ...REQUEST, provider: 'openai', model: 'gpt-4o-mini' }), 10);
    expect(nothing.error).toMatchObject({ kind: 'unreachable', message: 'OpenAI could not be reached: no reason given' });
    global.fetch = vi.fn(async () => {
      throw 'socket hang up';
    }) as typeof fetch;
    const words = await settle(callLLMJudge({ ...REQUEST }), 10);
    expect(words.error).toMatchObject({ kind: 'unreachable', message: 'Anthropic could not be reached: socket hang up' });
    // Through the mapping: the provider's failure, to be retried.
    expect(toIrisError(r.error).envelope).toMatchObject({ code: 'IRIS_PROVIDER_ERROR', kind: 'unreachable', retryable: true });
  });

  it("a key a request header cannot carry is refused before any request, as the key's fault, and is never shown", async () => {
    for (const apiKey of ['sk-test​', '“sk-test”', 'sk-te\nst']) {
      for (const [provider, model, name] of [
        ['anthropic', 'claude-haiku-4-5', 'Anthropic'],
        ['openai', 'gpt-4o-mini', 'OpenAI'],
      ] as const) {
        global.fetch = vi.fn(async () => new Response(JUDGMENT, { status: 200 })) as typeof fetch;
        const r = await settle(callLLMJudge({ ...REQUEST, provider, model, apiKey }), 10);
        expect(r.error, `${provider} ${JSON.stringify(apiKey)}`).toMatchObject({
          kind: 'auth',
          message: `${name} API key cannot be sent in a request header: it holds a line break, or a character such as a curly quote or a zero-width space copied with it. No request was made.`,
        });
        expect((r.error as Error).message).not.toContain('sk-te');
        expect(global.fetch).not.toHaveBeenCalled();
        expect(toIrisError(r.error).envelope).toMatchObject({ code: 'IRIS_PROVIDER_ERROR', kind: 'auth', retryable: false });
      }
    }
    // A key the runtime carries is sent, as before: a line break at its end (the runtime drops it), a tab inside it, a character from 128 to 255.
    for (const apiKey of ['sk-test\n', 'sk-te\tst', 'sk-tést', 'sk-testÿ']) {
      global.fetch = vi.fn(async () => new Response(JUDGMENT, { status: 200 })) as typeof fetch;
      expect((await settle(callLLMJudge({ ...REQUEST, apiKey }), 10)).value?.content, JSON.stringify(apiKey)).toBe(VERDICT);
      expect(global.fetch, JSON.stringify(apiKey)).toHaveBeenCalledTimes(1);
    }
  });

  it('a reply cut off before its end: with a success status the provider could not be reached; with an error status the status decides', async () => {
    global.fetch = vi.fn(async () => cutOff(200)) as typeof fetch;
    const ok = await settle(callLLMJudge({ ...REQUEST }), 10);
    expect(ok.error).toMatchObject({ kind: 'unreachable', message: 'Anthropic reply was cut off before its end: terminated (UND_ERR_SOCKET)' });
    expect(toIrisError(ok.error).envelope).toMatchObject({ kind: 'unreachable', retryable: true });

    global.fetch = vi.fn(async () => cutOff(401)) as typeof fetch;
    const refused = await settle(callLLMJudge({ ...REQUEST }), 10);
    expect(refused.error).toMatchObject({ kind: 'auth', statusCode: 401, message: 'Anthropic auth failed (401): ' });
    expect(toIrisError(refused.error).envelope).toMatchObject({ kind: 'auth', retryable: false });

    global.fetch = vi.fn(async () => cutOff(503)) as typeof fetch;
    expect((await settle(callLLMJudge({ ...REQUEST }), 10)).error).toMatchObject({ kind: 'server_error', statusCode: 503 });

    // Any success status, not 200 alone.
    global.fetch = vi.fn(async () => cutOff(206)) as typeof fetch;
    expect((await settle(callLLMJudge({ ...REQUEST }), 10)).error).toMatchObject({ kind: 'unreachable', message: 'Anthropic reply was cut off before its end: terminated (UND_ERR_SOCKET)' });

    // An error status whose body the deadline ends: the deadline, since every request and its whole reply share it.
    global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const r = endless(init ?? {});
      return new Response(r.body, { status: 401 });
    }) as typeof fetch;
    const late = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 1_000 }), 2_000);
    expect(late.error).toMatchObject({ kind: 'timeout', message: 'Anthropic did not answer within 1000 ms' });
    expect(late.at).toBe(1_000);

    // A rate limit whose body is cut off is still a rate limit: its wait is read from its headers and waited out.
    let n = 0;
    global.fetch = vi.fn(async () => (n++ === 0 ? cutOff(429, { 'retry-after': '1' }) : new Response(JUDGMENT, { status: 200 }))) as typeof fetch;
    const waited = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 10_000 }), 2_000);
    expect(waited.value?.content).toBe(VERDICT);
    expect(waited.at).toBe(1_000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it("the time taken runs to the end of the reply's body", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              const bytes = new TextEncoder().encode(JUDGMENT);
              controller.enqueue(bytes.slice(0, 10));
              setTimeout(() => {
                controller.enqueue(bytes.slice(10));
                controller.close();
              }, 5_000);
            },
          }),
          { status: 200 },
        ),
    ) as typeof fetch;
    const r = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 10_000 }), 6_000);
    expect(r.value?.content).toBe(VERDICT);
    expect(r.value?.latencyMs).toBe(5_000);
  });

  it('a reply that is not of the shape the provider documents is a malformed reply, and no verdict is read from it', async () => {
    const replyTo = async (provider: 'anthropic' | 'openai', body: string): Promise<unknown> => {
      global.fetch = vi.fn(async () => new Response(body, { status: 200 })) as typeof fetch;
      const r = await settle(callLLMJudge({ ...REQUEST, provider, model: provider === 'anthropic' ? 'claude-haiku-4-5' : 'gpt-4o-mini' }), 10);
      return r.error ?? r.value;
    };
    for (const body of ['null', '[]', '"a judgment"', '42']) {
      expect(await replyTo('anthropic', body), body).toMatchObject({ kind: 'malformed_response', message: 'Anthropic response was not a JSON object' });
    }
    expect(await replyTo('anthropic', '{"id":')).toMatchObject({ kind: 'malformed_response', message: 'Anthropic response was not valid JSON' });

    const notBlocks = { kind: 'malformed_response', message: 'Anthropic response content was not a list of content blocks' };
    const block = { type: 'text', text: VERDICT };
    for (const content of [[null, block], [[block]], [block, 'more'], 'a judgment', block]) {
      expect(await replyTo('anthropic', JSON.stringify({ id: 'm', content })), JSON.stringify(content)).toMatchObject(notBlocks);
    }
    expect(await replyTo('anthropic', JSON.stringify({ id: 'm', content: [{ type: 'text', text: 5 }] }))).toMatchObject({ kind: 'malformed_response', message: 'Anthropic response had no text content block' });
    expect(await replyTo('anthropic', JSON.stringify({ id: 'm', content: [{ type: 'text', text: '' }] }))).toMatchObject({ kind: 'malformed_response', message: 'Anthropic response had no text content block' });
    expect(await replyTo('openai', JSON.stringify({ id: 'c', choices: [{ message: { content: '' } }] }))).toMatchObject({ kind: 'malformed_response', message: 'OpenAI response had no message content' });
    expect(await replyTo('anthropic', JSON.stringify({ id: 'm', content: [{ type: 'thinking' }, block] }))).toMatchObject({ content: VERDICT });

    const noContent = { kind: 'malformed_response', message: 'OpenAI response had no message content' };
    const choice = { message: { content: VERDICT }, finish_reason: 'stop' };
    expect(await replyTo('openai', JSON.stringify({ id: 'c', choices: { 0: choice } }))).toMatchObject(noContent);
    expect(await replyTo('openai', JSON.stringify({ id: 'c', choices: [{ message: { content: 5 } }] }))).toMatchObject(noContent);
    expect(await replyTo('openai', JSON.stringify({ id: 'c', choices: [choice] }))).toMatchObject({ content: VERDICT, stopReason: 'stop' });
  });

  it('a deadline already past, or one that is now, makes no request: the call is a timeout at once', async () => {
    // Each deadline is taken when its call is made: the clock moves between the two calls.
    for (const before of [1, 0]) {
      const deadline = Date.now() - before;
      global.fetch = vi.fn(async () => new Response(JUDGMENT, { status: 200 })) as typeof fetch;
      const r = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 1_000, deadline }), 10);
      expect(r.error).toMatchObject({ kind: 'timeout', message: 'Anthropic did not answer within 1000 ms' });
      expect(r.at).toBe(0);
      expect(global.fetch).not.toHaveBeenCalled();
    }
  });

  it("the evaluator's second request, for a reply it could not read, shares the first one's deadline", async () => {
    let n = 0;
    global.fetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      n += 1;
      if (n === 1) {
        // The first reply comes after 600 ms and holds no judgment.
        await new Promise((resolve) => setTimeout(resolve, 600));
        return new Response(JSON.stringify({ id: 'm', content: [{ type: 'text', text: 'I cannot judge this.' }], usage: { input_tokens: 10, output_tokens: 5 } }), { status: 200 });
      }
      return endless(init ?? {});
    }) as typeof fetch;
    const r = await settle(
      evaluateWithLLMJudge({ template: 'accuracy', output: 'The sky is blue.', provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k', timeoutMs: 1_000 }),
      2_000,
    );
    // The time named is the call's, not what was left of it for the second request.
    expect(r.error).toMatchObject({ kind: 'timeout', message: 'Anthropic did not answer within 1000 ms' });
    // One deadline: the second request had what the first left of the thousand milliseconds.
    expect(r.at).toBe(1_000);
    expect(n).toBe(2);
  });
});
