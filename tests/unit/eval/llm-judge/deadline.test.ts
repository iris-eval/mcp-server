/*
 * A judge call answers inside its deadline: every request, its whole reply
 * and the wait after a rate limit share one time (timeout_ms, default
 * 50,000 ms), so the call answers before an MCP client's own 60-second
 * timeout. A reply whose body never ends is ended by the deadline, a rate
 * limit whose wait would outlast it is answered at once, a request that
 * cannot be made is the provider's failure, and a reply that is not a JSON
 * object is a malformed reply. Fake timers: nothing here waits for real.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { callLLMJudge, LLMJudgeError, type LLMJudgeRequest } from '../../../../src/eval/llm-judge/client.js';
import { DEFAULT_JUDGE_DEADLINE_MS } from '../../../../src/eval/llm-judge/deadline.js';
import { evaluateWithLLMJudge } from '../../../../src/eval/llm-judge/evaluator.js';
import { toIrisError } from '../../../../src/tools/errors.js';

const originalFetch = global.fetch;
const REQUEST: LLMJudgeRequest = { provider: 'anthropic', model: 'claude-haiku-4-5', systemPrompt: 's', userPrompt: 'u', maxOutputTokens: 100, temperature: 0, apiKey: 'k' };
const JUDGMENT = JSON.stringify({ id: 'm', content: [{ type: 'text', text: '{"score":0.9,"passed":true,"rationale":"on the subject"}' }], usage: { input_tokens: 10, output_tokens: 5 } });

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

  it('is 50 seconds where the caller names none, below the 60 seconds an MCP client waits by default', () => {
    expect(DEFAULT_JUDGE_DEADLINE_MS).toBe(50_000);
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
  });

  it('a rate limit whose wait fits is waited out and asked again, inside the same deadline', async () => {
    let n = 0;
    global.fetch = vi.fn(async () => (n++ === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '3' } }) : new Response(JUDGMENT, { status: 200 }))) as typeof fetch;
    const r = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 10_000 }), 5_000);
    expect(r.value?.content).toContain('"score":0.9');
    expect(r.at).toBe(3_000);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  it('Retry-After is a number of seconds from 0, or an HTTP date; anything else names no wait', async () => {
    const waitFor = async (value: string): Promise<unknown> => {
      global.fetch = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'retry-after': value } })) as typeof fetch;
      // A deadline too short for any wait: the rate limit is answered at once, carrying what was read.
      const r = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 1 }), 10);
      return (r.error as LLMJudgeError).retryAfterSeconds;
    };
    expect(await waitFor('0')).toBe(0);
    expect(await waitFor('7')).toBe(7);
    expect(await waitFor('1.5')).toBe(1.5);
    expect(await waitFor('-1')).toBeUndefined();
    expect(await waitFor('1,5')).toBeUndefined();
    expect(await waitFor('soon')).toBeUndefined();
    const inTenSeconds = new Date(Date.now() + 10_000).toUTCString();
    expect(await waitFor(inTenSeconds)).toBe(10);
    expect(await waitFor(new Date(Date.now() - 10_000).toUTCString())).toBe(0);
  });

  it("Anthropic's reset time is read as a wait where Retry-After names none", async () => {
    const reset = new Date(Date.now() + 4_000).toISOString();
    global.fetch = vi.fn(async () => new Response('slow down', { status: 429, headers: { 'anthropic-ratelimit-requests-reset': reset } })) as typeof fetch;
    const r = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 1 }), 10);
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
    // Through the mapping: the provider's failure, to be retried.
    expect(toIrisError(r.error).envelope).toMatchObject({ code: 'IRIS_PROVIDER_ERROR', kind: 'unreachable', retryable: true });
  });

  it('a reply that is not a JSON object is a malformed reply: null, a list, a string', async () => {
    for (const body of ['null', '[]', '"a judgment"', '42']) {
      global.fetch = vi.fn(async () => new Response(body, { status: 200 })) as typeof fetch;
      const r = await settle(callLLMJudge({ ...REQUEST }), 10);
      expect(r.error, body).toMatchObject({ kind: 'malformed_response', message: 'Anthropic response was not a JSON object' });
    }
    global.fetch = vi.fn(async () => new Response('{"id":', { status: 200 })) as typeof fetch;
    expect((await settle(callLLMJudge({ ...REQUEST }), 10)).error).toMatchObject({ kind: 'malformed_response', message: 'Anthropic response was not valid JSON' });
  });

  it('a deadline already past makes no request: the call is a timeout at once', async () => {
    global.fetch = vi.fn(async () => new Response(JUDGMENT, { status: 200 })) as typeof fetch;
    const r = await settle(callLLMJudge({ ...REQUEST, timeoutMs: 1_000, deadline: Date.now() - 1 }), 10);
    expect(r.error).toMatchObject({ kind: 'timeout', message: 'Anthropic did not answer within 1000 ms' });
    expect(r.at).toBe(0);
    expect(global.fetch).not.toHaveBeenCalled();
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
