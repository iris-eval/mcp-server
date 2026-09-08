/*
 * The typed error model (D-1): a failed response is classified by kind,
 * carries the server's reason, and a thrown fetch is "unreachable".
 *
 * What this checks, precisely: each status band maps to its kind; the
 * body's `error` field becomes the detail; 429 carries its schedule and is
 * still a RateLimitError for the code that keys on that; a network throw
 * from fetch surfaces through the client as an unreachable ApiError with
 * its path; and every kind has its own sentence.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { ApiError, RateLimitError, asApiError, networkError, sentenceFor, toApiError } from '../../src/api/errors';
import { api } from '../../src/api/client';

const res = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  new Response(body === undefined ? null : typeof body === 'string' ? body : JSON.stringify(body), { status, headers });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('toApiError', () => {
  it('maps each status band to its kind and keeps the path', async () => {
    expect((await toApiError(res(401), '/api/v1/traces')).kind).toBe('unauthorized');
    expect((await toApiError(res(403), '/api/v1/traces')).kind).toBe('unauthorized');
    expect((await toApiError(res(404, { error: 'Trace not found' }), '/api/v1/traces/x')).kind).toBe('not-found');
    expect((await toApiError(res(500, 'boom'), '/api/v1/summary')).kind).toBe('server-error');
    expect((await toApiError(res(400, { error: 'Invalid query parameters' }), '/api/v1/moments')).kind).toBe('bad-request');
    const e = await toApiError(res(503), '/api/v1/summary');
    expect(e.path).toBe('/api/v1/summary');
    expect(e.status).toBe(503);
    expect(e).toBeInstanceOf(ApiError);
  });

  it('carries the server\'s own reason as the detail, from JSON or text', async () => {
    const bad = await toApiError(res(400, { error: 'Invalid query parameters' }), '/api/v1/moments');
    expect(bad.detail).toBe('Invalid query parameters');
    expect(bad.message).toContain('Invalid query parameters');
    const text = await toApiError(res(500, 'stack trace here'), '/x');
    expect(text.detail).toBe('stack trace here');
  });

  it('429 is a RateLimitError of kind rate-limited with its schedule and policy', async () => {
    const e = await toApiError(res(429, null, { 'ratelimit-reset': '45', 'ratelimit-policy': '600;w=60' }), '/api/v1/summary');
    expect(e).toBeInstanceOf(RateLimitError);
    expect(e.kind).toBe('rate-limited');
    expect(e.retryAfterMs).toBe(45_000);
    expect((e as RateLimitError).policy).toBe('600;w=60');
    expect(e.message).toMatch(/retry in 45s/);
  });

  it('every kind has its own sentence', () => {
    const kinds = ['unreachable', 'unauthorized', 'not-found', 'rate-limited', 'server-error', 'bad-request'] as const;
    const sentences = kinds.map((k) => sentenceFor(k, '/p', { status: 500, retryAfterMs: 5000 }));
    expect(new Set(sentences).size).toBe(kinds.length);
    for (const s of sentences) expect(s.length).toBeGreaterThan(20);
  });
});

describe('the client', () => {
  it('a fetch that throws surfaces as an unreachable ApiError naming the path', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Failed to fetch')));
    let caught: unknown;
    try {
      await api.getSummary();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe('unreachable');
    expect((caught as ApiError).path).toContain('/summary');
    expect((caught as ApiError).message).toMatch(/did not answer/);
  });

  it('a failed response surfaces as the classified ApiError, not a bare Error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(res(500, { error: 'db locked' })));
    let caught: unknown;
    try {
      await api.getSummary();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ApiError);
    expect((caught as ApiError).kind).toBe('server-error');
    expect((caught as ApiError).detail).toBe('db locked');
  });

  it('asApiError passes an ApiError through and wraps anything else as unreachable', () => {
    const e = new ApiError('not-found', '/x');
    expect(asApiError(e)).toBe(e);
    expect(asApiError(new Error('socket hang up'), '/y').kind).toBe('unreachable');
    expect(networkError('/z', new Error('ECONNREFUSED')).detail).toBe('ECONNREFUSED');
  });
});
