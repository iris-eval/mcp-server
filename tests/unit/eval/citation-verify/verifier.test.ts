import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { verifyCitations } from '../../../../src/eval/citation-verify/verifier.js';
import {
  __clearCitationCacheForTests,
  __setDnsLookupForTests,
} from '../../../../src/eval/citation-verify/resolve.js';

const originalFetch = global.fetch;

// Default permissive DNS mock so resolve.ts's pre-resolve guard doesn't
// hit real DNS for test fixture hosts like a.com / b.com.
beforeEach(() => {
  __setDnsLookupForTests(async () => [{ address: '8.8.8.8', family: 4 }]);
});

afterEach(() => {
  global.fetch = originalFetch;
  __clearCitationCacheForTests();
  __setDnsLookupForTests(null);
});

function makeMockedFetch(
  handlers: Array<(url: string, init: RequestInit) => Response | Promise<Response>>,
) {
  let call = 0;
  return vi.fn(async (url: string, init: RequestInit = {}) => {
    const handler = handlers[call] ?? handlers[handlers.length - 1];
    call++;
    return handler(url, init);
  }) as typeof fetch;
}

describe('verifyCitations', () => {
  it('returns overall_score=null when no citations are present', async () => {
    global.fetch = makeMockedFetch([() => new Response('ignored')]);
    const res = await verifyCitations({
      output: 'No citations here.',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
      allowFetch: true,
    });
    expect(res.overallScore).toBeNull();
    /*
     * Nothing was judged, so there is no verdict — null, not true. Until
     * 0.10.0 this returned `passed: true`, so an output whose sources were
     * never checked came back looking verified, and a caller reading
     * `passed` shipped it.
     */
    expect(res.passed).toBeNull();
    expect(res.totalCitationsFound).toBe(0);
    expect(res.totalResolved).toBe(0);
  });

  it('skips unresolvable citations (numbered, author_year)', async () => {
    global.fetch = makeMockedFetch([]);
    const res = await verifyCitations({
      output: 'According to [1] and (Smith, 2020) this is true.',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
      allowFetch: true,
    });
    expect(res.totalCitationsFound).toBe(2);
    expect(res.totalResolved).toBe(0);
    expect(res.overallScore).toBeNull();
    for (const c of res.citations) {
      expect(c.resolveStatus).toBe('skipped');
      expect(c.resolveError?.kind).toBe('unresolvable_kind');
    }
  });

  it('refuses unknown models before any network call', async () => {
    let called = false;
    global.fetch = vi.fn(async () => {
      called = true;
      return new Response();
    }) as typeof fetch;
    await expect(
      verifyCitations({
        output: 'Check https://example.com',
        provider: 'anthropic',
        model: 'claude-nonexistent',
        apiKey: 'k',
        allowFetch: true,
      }),
    ).rejects.toThrow(/Unknown model/);
    expect(called).toBe(false);
  });

  it('records fetch errors with structured error kinds', async () => {
    global.fetch = makeMockedFetch([
      async () => new Response('', { status: 404 }),
    ]);
    const res = await verifyCitations({
      output: 'See https://example.com/missing',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
      allowFetch: true,
    });
    expect(res.citations[0].resolveStatus).toBe('error');
    expect(res.citations[0].resolveError?.kind).toBe('bad_status');
    // A resolve-stage failure never reaches the judge, so it has no judgeError.
    expect(res.citations[0].judgeError).toBeUndefined();
    expect(res.totalResolved).toBe(0);
  });

  it('happy path — 1 URL citation, judge says supported', async () => {
    global.fetch = makeMockedFetch([
      // source fetch
      async () =>
        new Response('The capital of France is Paris.', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
      // judge call
      async () =>
        new Response(
          JSON.stringify({
            id: 'msg',
            content: [{ type: 'text', text: '{"supported":true,"confidence":0.95,"rationale":"source states it plainly"}' }],
            usage: { input_tokens: 150, output_tokens: 25 },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    ]);

    const res = await verifyCitations({
      output: 'Per https://example.com/fact the capital of France is Paris.',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
      allowFetch: true,
    });

    expect(res.totalCitationsFound).toBe(1);
    expect(res.totalResolved).toBe(1);
    expect(res.totalJudged).toBe(1);
    expect(res.totalSupported).toBe(1);
    expect(res.overallScore).toBe(1);
    expect(res.passed).toBe(true);
    expect(res.citations[0].resolveStatus).toBe('ok');
    expect(res.citations[0].judge?.supported).toBe(true);
    expect(res.citations[0].judge?.confidence).toBe(0.95);
  });

  it('fails when majority of sources do not support', async () => {
    // 2 URLs: 1 supported, 1 contradicted
    global.fetch = makeMockedFetch([
      // source 1
      async () => new Response('supporting source', { headers: { 'content-type': 'text/plain' } }),
      // judge 1 — supported
      async () =>
        new Response(
          JSON.stringify({
            id: 'm',
            content: [{ type: 'text', text: '{"supported":true,"confidence":0.9,"rationale":"x"}' }],
            usage: { input_tokens: 50, output_tokens: 10 },
          }),
        ),
      // source 2
      async () => new Response('contradicts claim', { headers: { 'content-type': 'text/plain' } }),
      // judge 2 — not supported
      async () =>
        new Response(
          JSON.stringify({
            id: 'm2',
            content: [{ type: 'text', text: '{"supported":false,"confidence":0.85,"rationale":"y"}' }],
            usage: { input_tokens: 50, output_tokens: 10 },
          }),
        ),
    ]);

    const res = await verifyCitations({
      output: 'Claim one https://a.com and claim two https://b.com.',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
      allowFetch: true,
    });

    expect(res.totalSupported).toBe(1);
    expect(res.totalResolved).toBe(2);
    expect(res.overallScore).toBe(0.5);
    /*
     * Counts, not a proportion. One judged source did not support the
     * claim, and that is the finding — a fabricated citation among real
     * ones used to score 0.67 and pass. The score is still reported; it is
     * no longer what decides.
     */
    expect(res.totalUnsupported).toBe(1);
    expect(res.passed).toBe(false);
  });

  it("a citation's input the judge's reply says was read from the cache or written to it is priced at those rates", async () => {
    global.fetch = makeMockedFetch([
      async () => new Response('The retry limit is five attempts.', { headers: { 'content-type': 'text/plain' } }),
      async () =>
        new Response(
          JSON.stringify({
            id: 'c',
            choices: [{ message: { content: '{"supported":true,"confidence":0.9,"rationale":"It says five."}' }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 50_000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 10_000, cache_write_tokens: 20_000 } },
          }),
        ),
    ]);
    const res = await verifyCitations({ output: 'The retry limit is five attempts https://a.com/retry.', provider: 'openai', model: 'gpt-6.2-astra', apiKey: 'k', allowFetch: true, maxCostUsdTotal: 10 });
    expect(res.totalJudged).toBe(1);
    // 20,000 plain × 8 + 10,000 read × 0.40 + 20,000 written × 10, and 100 out × 40 = $0.368
    expect(res.totalCostUsd).toBe(0.368);
  });

  it("a citation's worst case counts its input at the margin times its estimate, at the rates for that count: one near Haiku 5.5's line is held at the higher rates", async () => {
    // A citation's prompt carries its claim, and a URL's fragment is never sent to the server, so a long fragment makes a prompt near the line.
    const judged: number[] = [];
    const verify = async (fragment: number) => {
      __clearCitationCacheForTests();
      let calls = 0;
      global.fetch = vi.fn(async (url: string) => {
        if (new URL(String(url)).hostname !== 'api.anthropic.com') return new Response('The retry limit is five attempts.', { headers: { 'content-type': 'text/plain' } });
        calls += 1;
        return new Response(JSON.stringify({ id: 'm', content: [{ type: 'text', text: '{"supported":true,"confidence":0.9,"rationale":"five"}' }], usage: { input_tokens: 1_000, output_tokens: 50 } }));
      }) as typeof fetch;
      const res = await verifyCitations({ output: `The retry limit is five https://a.com/page#${'x'.repeat(fragment)} here.`, provider: 'anthropic', model: 'claude-haiku-5-5', apiKey: 'k', allowFetch: true, maxCostUsdTotal: 0.02 });
      judged.push(calls);
      return res.citations[0];
    };
    // A fragment of 300,000 characters: an estimate of about 76,500 tokens, under the line raised by 1.3 (about 99,500), so the worst case is at the base rates, about $0.010, and fits a cap of $0.02.
    expect((await verify(300_000)).judgeError).toBeUndefined();
    // 330,000: about 84,000 tokens, over the line raised (about 109,300), so at the higher rates, about $0.055: not judged.
    expect((await verify(330_000)).judgeError?.kind).toBe('cost_cap_reached');
    expect(judged).toEqual([1, 0]);
  });

  it('stops calling judge when total cost cap would be exceeded', async () => {
    global.fetch = makeMockedFetch([
      // source 1 — tiny body
      async () => new Response('a', { headers: { 'content-type': 'text/plain' } }),
      // judge 1 — reports high token usage -> drives cost close to cap
      async () =>
        new Response(
          JSON.stringify({
            id: 'm',
            content: [{ type: 'text', text: '{"supported":true,"confidence":1,"rationale":"x"}' }],
            usage: { input_tokens: 500_000, output_tokens: 100_000 }, // $1.00 on haiku
          }),
        ),
      // source 2 — shouldn't reach judge because cap hits
      async () => new Response('b', { headers: { 'content-type': 'text/plain' } }),
    ]);

    const res = await verifyCitations({
      output: 'One https://a.com and two https://b.com.',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
      allowFetch: true,
      maxCostUsdTotal: 0.5, // force cap
    });

    // First source judged + cost consumed. Second source fetched but
    // judge skipped due to cap.
    expect(res.citations[0].judge).toBeDefined();
    // A judge-stage failure, on a source that resolved: judgeError, and
    // resolveError stays empty (#407).
    expect(res.citations[1].resolveStatus).toBe('ok');
    expect(res.citations[1].judgeError?.kind).toBe('cost_cap_reached');
    expect(res.citations[1].resolveError).toBeUndefined();
    // Hitting the cap is an infrastructure stop, not evidence against the
    // citation: 1 judged, 1 supported — full marks, not 1/2.
    expect(res.totalResolved).toBe(2);
    expect(res.totalJudged).toBe(1);
    expect(res.overallScore).toBe(1);
  });

  /*
   * The denominator is citations the judge actually RULED ON, not
   * citations that merely fetched. Before this fix totalResolved was the
   * denominator and it incremented on fetch success — so a judge timeout
   * on half the supported citations scored 0.5, indistinguishable from
   * half the citations being fabricated. Infrastructure failure must
   * never be reported as "source does not support the claim".
   */
  it('judge timeout mid-run leaves citations unverified, not unsupported', async () => {
    global.fetch = makeMockedFetch([
      // source 1
      async () => new Response('supporting source', { headers: { 'content-type': 'text/plain' } }),
      // judge 1 — supported
      async () =>
        new Response(
          JSON.stringify({
            id: 'm',
            content: [{ type: 'text', text: '{"supported":true,"confidence":0.9,"rationale":"x"}' }],
            usage: { input_tokens: 50, output_tokens: 10 },
          }),
        ),
      // source 2
      async () => new Response('also supporting', { headers: { 'content-type': 'text/plain' } }),
      // judge 2 — times out (client.ts converts AbortError -> LLMJudgeError 'timeout')
      async () => {
        throw Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
      },
    ]);

    const res = await verifyCitations({
      output: 'Claim one https://a.com and claim two https://b.com.',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
      allowFetch: true,
    });

    expect(res.totalResolved).toBe(2);
    expect(res.totalJudged).toBe(1);
    expect(res.totalSupported).toBe(1);
    // 1/1 judged — NOT 1/2. The timed-out citation is unverified.
    expect(res.overallScore).toBe(1);
    expect(res.passed).toBe(true);
    expect(res.citations[1].judge).toBeUndefined();
    // A judge-stage failure, on a source that resolved: judgeError, and
    // resolveError stays empty (#407).
    expect(res.citations[1].judgeError?.kind).toBe('timeout');
    expect(res.citations[1].resolveError).toBeUndefined();
  });

  it("a judge whose request fails with nothing at all is the provider failing to be reached, named on the citation", async () => {
    global.fetch = makeMockedFetch([
      async () => new Response('supporting source', { headers: { 'content-type': 'text/plain' } }),
      async () => {
        throw null;
      },
    ]);
    const res = await verifyCitations({ output: 'Claim one https://a.com.', provider: 'anthropic', model: 'claude-haiku-4-5', apiKey: 'k', allowFetch: true });
    expect(res.totalResolved).toBe(1);
    expect(res.totalJudged).toBe(0);
    expect(res.citations[0].judgeError).toMatchObject({ kind: 'unreachable', message: 'Anthropic could not be reached: no reason given' });
  });

  it('scores null (not zero) when every judge call fails', async () => {
    global.fetch = makeMockedFetch([
      // source fetch succeeds
      async () => new Response('source text', { headers: { 'content-type': 'text/plain' } }),
      // judge — provider outage
      async () => new Response('', { status: 500 }),
    ]);

    const res = await verifyCitations({
      output: 'See https://a.com for details.',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
      allowFetch: true,
    });

    expect(res.totalResolved).toBe(1);
    expect(res.totalJudged).toBe(0);
    expect(res.totalSupported).toBe(0);
    // Nothing was judged — there is no verdict, so no score and no fail.
    expect(res.overallScore).toBeNull();
    /*
     * The judge failed on every citation, so nothing was verified. That is
     * not a pass — a judge outage used to come back looking like a clean
     * bill of health for the sources.
     */
    expect(res.passed).toBeNull();
    // A judge-stage failure, on a source that resolved: judgeError, and
    // resolveError stays empty (#407).
    expect(res.citations[0].resolveStatus).toBe('ok');
    expect(res.citations[0].judgeError?.kind).toBe('server_error');
    expect(res.citations[0].resolveError).toBeUndefined();
  });

  it('excludes malformed judge responses from the denominator', async () => {
    global.fetch = makeMockedFetch([
      // source 1
      async () => new Response('supporting source', { headers: { 'content-type': 'text/plain' } }),
      // judge 1 — supported
      async () =>
        new Response(
          JSON.stringify({
            id: 'm',
            content: [{ type: 'text', text: '{"supported":true,"confidence":0.9,"rationale":"x"}' }],
            usage: { input_tokens: 50, output_tokens: 10 },
          }),
        ),
      // source 2
      async () => new Response('also supporting', { headers: { 'content-type': 'text/plain' } }),
      // judge 2 — replies, but not with JSON
      async () =>
        new Response(
          JSON.stringify({
            id: 'm2',
            content: [{ type: 'text', text: 'I cannot answer in the requested format.' }],
            usage: { input_tokens: 50, output_tokens: 10 },
          }),
        ),
    ]);

    const res = await verifyCitations({
      output: 'Claim one https://a.com and claim two https://b.com.',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
      allowFetch: true,
    });

    expect(res.totalResolved).toBe(2);
    expect(res.totalJudged).toBe(1);
    expect(res.overallScore).toBe(1);
    // A judge-stage failure, on a source that resolved: judgeError, and
    // resolveError stays empty (#407).
    expect(res.citations[1].judgeError?.kind).toBe('malformed_judge_response');
    expect(res.citations[1].resolveError).toBeUndefined();
  });

  it('respects max_citations', async () => {
    global.fetch = makeMockedFetch([
      async () => new Response('A', { headers: { 'content-type': 'text/plain' } }),
      async () =>
        new Response(
          JSON.stringify({
            id: 'm',
            content: [{ type: 'text', text: '{"supported":true,"confidence":1,"rationale":"x"}' }],
            usage: { input_tokens: 10, output_tokens: 5 },
          }),
        ),
    ]);
    const res = await verifyCitations({
      output: 'https://a.com https://b.com https://c.com',
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      apiKey: 'k',
      allowFetch: true,
      maxCitations: 1,
    });
    expect(res.citations).toHaveLength(1);
    expect(res.totalCitationsFound).toBe(3);
  });
});
