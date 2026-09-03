/*
 * Browser sign-in for an --api-key dashboard (#373 item 6).
 *
 * The Bearer middleware is right for MCP clients and capture SDKs and
 * useless for a browser: with `--api-key` set, the dashboard UI 401'd
 * every page load. The session layer in src/dashboard/session-auth.ts
 * lets a browser present the key ONCE — `?key=` on any dashboard URL, or
 * the sign-in form — and then ride an HttpOnly cookie.
 *
 * Every test drives the REAL dashboard server over a REAL socket so the
 * request passes the same middleware stack production traffic does.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { SESSION_COOKIE } from '../../src/dashboard/session-auth.js';

const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

interface BootedServer {
  storage: SqliteAdapter;
  server: Server;
  base: string;
}

const booted: BootedServer[] = [];

afterEach(async () => {
  for (const b of booted.splice(0)) {
    b.server.closeAllConnections?.();
    await new Promise<void>((resolve) => b.server.close(() => resolve()));
    await b.storage.close();
  }
});

async function bootServer(apiKey?: string): Promise<BootedServer> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const config = {
    ...defaultConfig,
    dashboard: { ...defaultConfig.dashboard, port: 0 },
    security: { ...defaultConfig.security, apiKey },
  };
  const server = createDashboardServer(storage, config, mockLogger).start();
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const entry = { storage, server, base: `http://127.0.0.1:${port}` };
  booted.push(entry);
  return entry;
}

const KEY = 'team-dashboard-key-9f2c';
const HTML = { accept: 'text/html,application/xhtml+xml' };

/** The `name=value` pair from a Set-Cookie header, for sending back. */
function cookiePair(res: Response): string {
  const raw = res.headers.get('set-cookie');
  expect(raw, 'expected a Set-Cookie header').toBeTruthy();
  return (raw as string).split(';')[0];
}

describe('session auth — with --api-key', () => {
  it('a browser navigation without a session gets the sign-in page, not a JSON 401', async () => {
    const { base } = await bootServer(KEY);
    const res = await fetch(`${base}/moments`, { headers: HTML, redirect: 'manual' });
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain('<form');
    expect(body).toContain('API key');
    expect(body).toContain('?key=');
  });

  it('API calls without a session still get the Bearer 401 JSON', async () => {
    const { base } = await bootServer(KEY);
    const res = await fetch(`${base}/api/v1/traces`);
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toMatch(/Authorization header/);
  });

  it('/api/v1/health stays open without a key or a session', async () => {
    const { base } = await bootServer(KEY);
    const res = await fetch(`${base}/api/v1/health`);
    expect(res.status).toBe(200);
  });

  it('?key= exchanges the key for an HttpOnly cookie and redirects with the key stripped', async () => {
    const { base } = await bootServer(KEY);
    const res = await fetch(`${base}/traces?since=2026-01-01&key=${KEY}`, { headers: HTML, redirect: 'manual' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/traces?since=2026-01-01');

    const setCookie = res.headers.get('set-cookie') as string;
    expect(setCookie).toMatch(new RegExp(`^${SESSION_COOKIE}=[A-Za-z0-9_-]{40,}`));
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    // Plain http — no Secure attribute, or the browser would drop the cookie.
    expect(setCookie).not.toMatch(/Secure/i);
    // The cookie is a session token, never the key itself.
    expect(setCookie).not.toContain(KEY);

    // …and that cookie now authenticates API calls without a Bearer header.
    const cookie = cookiePair(res);
    const api = await fetch(`${base}/api/v1/traces`, { headers: { cookie } });
    expect(api.status).toBe(200);
    // A page load with the cookie is no longer intercepted by the sign-in page.
    const page = await fetch(`${base}/moments`, { headers: { ...HTML, cookie }, redirect: 'manual' });
    expect(page.status).not.toBe(401);

    // A browser that ALREADY has a session and opens a shared ?key= link is
    // still redirected to the key-free URL — the key never lingers in the
    // address bar just because the exchange was unnecessary.
    const again = await fetch(`${base}/rules?key=${KEY}`, { headers: { ...HTML, cookie }, redirect: 'manual' });
    expect(again.status).toBe(302);
    expect(again.headers.get('location')).toBe('/rules');
  });

  it('a wrong ?key= is refused with 403, no cookie, and the key is not echoed', async () => {
    const { base } = await bootServer(KEY);
    const wrong = 'zzz-not-the-key-4a1b';
    const res = await fetch(`${base}/?key=${wrong}`, { headers: HTML, redirect: 'manual' });
    expect(res.status).toBe(403);
    expect(res.headers.get('set-cookie')).toBeNull();
    const body = await res.text();
    expect(body).toContain('did not match');
    expect(body).not.toContain(wrong);
  });

  it('a forged or expired cookie is not a session', async () => {
    const { base } = await bootServer(KEY);
    const res = await fetch(`${base}/api/v1/traces`, { headers: { cookie: `${SESSION_COOKIE}=forged-token` } });
    expect(res.status).toBe(401);
  });

  it('the sign-in form exchanges the key and lands on /', async () => {
    const { base } = await bootServer(KEY);
    const ok = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: KEY }).toString(),
      redirect: 'manual',
    });
    expect(ok.status).toBe(303);
    expect(ok.headers.get('location')).toBe('/');
    const cookie = cookiePair(ok);
    const api = await fetch(`${base}/api/v1/rules/custom`, { headers: { cookie } });
    // Rules routes are not wired in this boot (no store) — a 404 from the
    // API router proves auth passed; a 401 would mean it did not.
    expect(api.status).not.toBe(401);

    const bad = await fetch(`${base}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ key: 'wrong' }).toString(),
      redirect: 'manual',
    });
    expect(bad.status).toBe(403);
    expect(bad.headers.get('set-cookie')).toBeNull();
  });

  it('Bearer auth is unchanged for API clients', async () => {
    const { base } = await bootServer(KEY);
    const res = await fetch(`${base}/api/v1/traces`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(res.status).toBe(200);
    const wrong = await fetch(`${base}/api/v1/traces`, { headers: { authorization: 'Bearer nope' } });
    expect(wrong.status).toBe(403);
  });

  it('throttles key-exchange attempts independently of the API limiter', async () => {
    const { base } = await bootServer(KEY);
    let last = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${base}/?key=wrong-${i}`, { headers: HTML, redirect: 'manual' });
      last = res.status;
      if (last === 429) break;
    }
    expect(last).toBe(429);
  });
});

describe('session auth — without --api-key', () => {
  it('leaves ?key= alone and sets no cookie', async () => {
    const { base } = await bootServer(undefined);
    const res = await fetch(`${base}/?key=anything`, { headers: HTML, redirect: 'manual' });
    expect(res.status).not.toBe(302);
    expect(res.headers.get('set-cookie')).toBeNull();
    const api = await fetch(`${base}/api/v1/traces`);
    expect(api.status).toBe(200);
  });
});
