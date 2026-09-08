/*
 * The connection store and the client that feeds it (D-2).
 *
 * The proposition: every answer the client sees moves the store — a fetch
 * that throws is `unreachable`, an answer of any status is `connected`, a
 * 401/403 is `signed-out` — and the health read returns a 503 body as the
 * answer it is.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  reportConnection,
  connectionSnapshot,
  subscribeConnection,
  resetConnection,
} from '../../src/api/connection';
import { api } from '../../src/api/client';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

describe('the connection store (D-2)', () => {
  beforeEach(() => resetConnection());

  it('starts connected; a different state moves it and stamps when', () => {
    const before = connectionSnapshot();
    expect(before.state).toBe('connected');
    reportConnection('unreachable');
    const after = connectionSnapshot();
    expect(after.state).toBe('unreachable');
    expect(after.since).toBeGreaterThanOrEqual(before.since);
  });

  it('a repeat of the current state is silent; a change tells each subscriber once', () => {
    const listener = vi.fn();
    const off = subscribeConnection(listener);
    reportConnection('connected');
    expect(listener).not.toHaveBeenCalled();
    reportConnection('signed-out');
    expect(listener).toHaveBeenCalledTimes(1);
    reportConnection('signed-out');
    expect(listener).toHaveBeenCalledTimes(1);
    off();
    reportConnection('connected');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});

describe('the client reports every answer (D-2)', () => {
  const realFetch = globalThis.fetch;

  beforeEach(() => resetConnection());
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('a fetch that throws → unreachable', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.getFilters()).rejects.toMatchObject({ kind: 'unreachable' });
    expect(connectionSnapshot().state).toBe('unreachable');
  });

  it('an answer of any status → connected, even a 500', async () => {
    reportConnection('unreachable');
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'boom' }, 500));
    await expect(api.getFilters()).rejects.toMatchObject({ kind: 'server-error' });
    expect(connectionSnapshot().state).toBe('connected');
  });

  it('a 403 → signed-out', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({ error: 'forbidden' }, 403));
    await expect(api.getFilters()).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(connectionSnapshot().state).toBe('signed-out');
  });

  it('getHealth returns a 503 body as the answer and reports connected', async () => {
    reportConnection('unreachable');
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse(
        {
          status: 'degraded',
          version: '0.13.0',
          uptime_seconds: 1,
          storage: 'disconnected',
          judge: { enabled: false },
          mode: 'real',
        },
        503,
      ),
    );
    const health = await api.getHealth();
    expect(health.status).toBe('degraded');
    expect(health.storage).toBe('disconnected');
    expect(connectionSnapshot().state).toBe('connected');
  });

  it('getHealth on a 200 returns the body', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      jsonResponse({ status: 'ok', version: '0.13.0', uptime_seconds: 5, trace_count: 3, storage: 'connected', judge: { enabled: true, provider: 'anthropic' }, mode: 'demo' }),
    );
    const health = await api.getHealth();
    expect(health).toMatchObject({ status: 'ok', mode: 'demo', judge: { enabled: true, provider: 'anthropic' } });
  });

  it('getHealth on a throw → unreachable, and the error names the path', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(api.getHealth()).rejects.toMatchObject({ kind: 'unreachable', path: '/api/v1/health' });
    expect(connectionSnapshot().state).toBe('unreachable');
  });
});
