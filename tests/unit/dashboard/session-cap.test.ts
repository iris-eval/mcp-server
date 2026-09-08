/*
 * The session map at its cap (A6-7).
 *
 * Until 0.13.0 the sign-in that found the map full evicted the OLDEST
 * session whether or not it was still valid — a burst of sign-ins, or one
 * holder of the key, silently logged every live browser out. Expired
 * sessions are now swept first, and a sign-in that still finds every slot
 * live is refused with 503 and no cookie; no live session is ever evicted.
 *
 * The real middleware is mounted on a bare express app with the cap lowered
 * to two: the production cap of 256 sits behind a 10-per-minute sign-in
 * limiter, so the refusal path cannot be reached through the dashboard in a
 * test — the same code runs here, with the same sign-in page, the same
 * exchange and the same cookie. What this file checks, precisely: with the
 * cap full of LIVE sessions the next `?key=` is 503 without a cookie and
 * the first session still works; with the cap full of EXPIRED sessions the
 * next sign-in succeeds because the sweep made room.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createSessionAuth, SESSION_COOKIE } from '../../../src/dashboard/session-auth.js';
import { createAuthGateRateLimiter } from '../../../src/middleware/rate-limit.js';
import { defaultConfig } from '../../../src/config/defaults.js';

const KEY = 'cap-test-key-1a2b';
const HTML = { accept: 'text/html,application/xhtml+xml' };
const opened: Server[] = [];

afterEach(async () => {
  vi.useRealTimers();
  for (const s of opened.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

async function boot(maxSessions: number): Promise<string> {
  const app = express();
  const bearerAuth: express.RequestHandler = (req, res, next) => {
    if (req.headers.authorization === `Bearer ${KEY}`) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
  // The same per-address limiter the dashboard mounts ahead of every authorization decision.
  app.use(createAuthGateRateLimiter(defaultConfig));
  app.use(createSessionAuth({ apiKey: KEY, bearerAuth, maxSessions }));
  app.get('/', (_req, res) => res.type('html').send('<h1>dashboard</h1>'));
  app.get('/api/v1/traces', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  opened.push(server);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

function cookiePair(res: Response): string {
  const raw = res.headers.get('set-cookie');
  expect(raw, 'expected a Set-Cookie header').toBeTruthy();
  const pair = (raw as string).split(';')[0];
  expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return pair;
}

describe('the session cap', () => {
  it('refuses a sign-in when every slot holds a live session, sets no cookie, and keeps the first session alive', async () => {
    const base = await boot(2);
    const signIn = () => fetch(`${base}/?key=${KEY}`, { headers: HTML, redirect: 'manual' });

    const first = await signIn();
    expect(first.status).toBe(302);
    const firstCookie = cookiePair(first);
    expect((await signIn()).status).toBe(302);

    const refused = await signIn();
    expect(refused.status).toBe(503);
    expect(refused.headers.get('set-cookie')).toBeNull();
    expect(await refused.text()).toContain('live browser sessions');

    const page = await fetch(`${base}/`, { headers: { ...HTML, cookie: firstCookie }, redirect: 'manual' });
    expect(page.status).toBe(200);

    // Bearer clients never touch the map.
    const api = await fetch(`${base}/api/v1/traces`, { headers: { authorization: `Bearer ${KEY}` } });
    expect(api.status).toBe(200);
  });

  it('sweeps expired sessions first, so a full map of dead sessions does not refuse anyone', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const base = await boot(2);
    const signIn = () => fetch(`${base}/?key=${KEY}`, { headers: HTML, redirect: 'manual' });

    const stale = cookiePair(await signIn());
    expect((await signIn()).status).toBe(302);

    // Past the 30-day TTL: both sessions are expired, the map is still "full".
    vi.setSystemTime(Date.now() + 31 * 24 * 60 * 60 * 1000);

    const fresh = await signIn();
    expect(fresh.status).toBe(302);
    expect(fresh.headers.get('set-cookie')).toBeTruthy();

    // The stale cookie is not a session any more; the new one is.
    const old = await fetch(`${base}/`, { headers: { ...HTML, cookie: stale }, redirect: 'manual' });
    expect(old.status).toBe(401);
    const now = await fetch(`${base}/`, { headers: { ...HTML, cookie: cookiePair(fresh) }, redirect: 'manual' });
    expect(now.status).toBe(200);
  });
});
