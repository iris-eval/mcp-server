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
    expect(res.passed).toBe(true); // nothing to fail
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
    expect(res.passed).toBe(true); // 0.5 >= 0.5 threshold
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
    expect(res.citations[1].resolveError?.kind).toBe('cost_cap_reached');
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
