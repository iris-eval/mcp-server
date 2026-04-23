/*
 * RateLimitError / fetchJson rate-limit parsing.
 *
 * Guards the client-side half of audit item #12. The dashboard API
 * returns 429 with either `RateLimit-Reset` (preferred, RFC draft) or
 * `Retry-After` (fallback, RFC 9110). This suite ensures the client
 * picks the right header, tolerates malformed values, and surfaces a
 * typed RateLimitError instead of the generic "API error: 429" string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RateLimitError } from '../../../src/api/client';

// We intercept fetch to simulate server responses without spinning up
// a real backend. Each test resets the mock so responses don't leak.
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  // jsdom env may not provide window.location — supply a minimal one so
  // the URL(path, origin) ctor inside client.ts doesn't throw.
  if (typeof window !== 'undefined' && !window.location.origin) {
    Object.defineProperty(window, 'location', {
      value: { origin: 'http://localhost' },
      writable: true,
    });
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function makeResponse(status: number, headers: Record<string, string>, body: unknown = {}) {
  return new Response(JSON.stringify(body), {
    status,
    statusText: status === 429 ? 'Too Many Requests' : 'OK',
    headers,
  });
}

async function callGetFilters() {
  const { api } = await import('../../../src/api/client');
  return api.getFilters();
}

describe('RateLimitError', () => {
  it('parses RateLimit-Reset as seconds into retryAfterMs', async () => {
    fetchMock.mockResolvedValue(makeResponse(429, { 'ratelimit-reset': '45' }));
    const err = await callGetFilters().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.kind).toBe('rate-limit');
    expect(err.retryAfterMs).toBe(45_000);
  });

  it('prefers RateLimit-Reset over Retry-After when both present', async () => {
    fetchMock.mockResolvedValue(
      makeResponse(429, { 'ratelimit-reset': '30', 'retry-after': '120' }),
    );
    const err = await callGetFilters().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it('falls back to Retry-After seconds when RateLimit-Reset is missing', async () => {
    fetchMock.mockResolvedValue(makeResponse(429, { 'retry-after': '60' }));
    const err = await callGetFilters().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(60_000);
  });

  it('parses Retry-After as HTTP-date', async () => {
    const future = new Date(Date.now() + 90_000).toUTCString();
    fetchMock.mockResolvedValue(makeResponse(429, { 'retry-after': future }));
    const err = await callGetFilters().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    // Approximately 90s — allow ±2s for test timing drift.
    expect(err.retryAfterMs).toBeGreaterThanOrEqual(88_000);
    expect(err.retryAfterMs).toBeLessThanOrEqual(92_000);
  });

  it('uses 30s fallback when neither header is present', async () => {
    fetchMock.mockResolvedValue(makeResponse(429, {}));
    const err = await callGetFilters().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBe(30_000);
  });

  it('clamps retryAfterMs to minimum 1s to prevent tight-loop retries', async () => {
    fetchMock.mockResolvedValue(makeResponse(429, { 'ratelimit-reset': '0' }));
    const err = await callGetFilters().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.retryAfterMs).toBeGreaterThanOrEqual(1000);
  });

  it('captures RateLimit-Policy for diagnostics', async () => {
    fetchMock.mockResolvedValue(
      makeResponse(429, {
        'ratelimit-reset': '10',
        'ratelimit-policy': '100;w=60',
      }),
    );
    const err = await callGetFilters().catch((e) => e);
    expect(err).toBeInstanceOf(RateLimitError);
    expect(err.policy).toBe('100;w=60');
  });

  it('throws a generic Error (not RateLimitError) for 500 responses', async () => {
    fetchMock.mockResolvedValue(makeResponse(500, {}, { error: 'boom' }));
    const err = await callGetFilters().catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(RateLimitError);
    expect(err.message).toContain('500');
  });

  it('succeeds and resolves to JSON body on 200', async () => {
    fetchMock.mockResolvedValue(
      makeResponse(200, {}, { agent_names: ['a'], frameworks: ['mcp'] }),
    );
    const data = await callGetFilters();
    expect(data.agent_names).toEqual(['a']);
  });
});
