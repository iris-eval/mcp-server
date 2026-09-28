/*
 * A browser session lives only as long as the key it was opened with.
 *
 * Each session records the id of the key the browser presented and asks
 * the ring about that key on every request (KeyRing.expiryOf). The ring the
 * server builds at boot is fixed for the life of the process, so today a
 * key leaves it by expiring (tests/integration/dashboard-session-auth.test.ts
 * proves that through the real dashboard) or by a restart, which drops
 * every session anyway. This file proves the other half of the contract
 * against the real middleware: when the ring stops holding a key, every
 * session that key opened ends on its next request, and sessions opened
 * with other keys do not. A ring that changes under a running server is
 * the test double here, so the check does not depend on how a future ring
 * learns a key was revoked.
 */
import { describe, it, expect, afterEach } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { createSessionAuth, SESSION_COOKIE } from '../../../src/dashboard/session-auth.js';
import type { KeyRing } from '../../../src/security/keys.js';

const HTML = { accept: 'text/html,application/xhtml+xml' };
const opened: Server[] = [];

afterEach(async () => {
  for (const s of opened.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
});

/** A ring whose keys can be revoked while the server runs. Keys are id → { secret, expiresAt }. */
function mutableRing(keys: Map<string, { secret: string; expiresAt: number | null }>): KeyRing {
  return {
    get empty() {
      return keys.size === 0;
    },
    get ids() {
      return [...keys.keys()];
    },
    expired: [],
    match(candidate: string, now = Date.now()) {
      for (const [id, k] of keys) if (k.secret === candidate && (k.expiresAt === null || k.expiresAt > now)) return id;
      return null;
    },
    expiryOf(id: string) {
      const k = keys.get(id);
      return k === undefined ? undefined : k.expiresAt;
    },
  };
}

async function boot(ring: KeyRing): Promise<string> {
  const app = express();
  const bearerAuth: express.RequestHandler = (req, res, next) => {
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    if (token !== undefined && ring.match(token) !== null) return next();
    res.status(401).json({ error: 'unauthorized' });
  };
  app.use(createSessionAuth({ keys: ring, bearerAuth }));
  app.get('/', (_req, res) => res.type('html').send('<h1>dashboard</h1>'));
  app.get('/api/v1/traces', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0, '127.0.0.1');
  opened.push(server);
  await new Promise((r) => server.once('listening', r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function signIn(base: string, key: string): Promise<string> {
  const res = await fetch(`${base}/?key=${key}`, { headers: HTML, redirect: 'manual' });
  expect(res.status).toBe(302);
  const pair = (res.headers.get('set-cookie') ?? '').split(';')[0];
  expect(pair.startsWith(`${SESSION_COOKIE}=`)).toBe(true);
  return pair;
}

describe('a browser session and its key', () => {
  it('a key removed from the ring ends every session it opened, on the next request, and no other', async () => {
    const keys = new Map([
      ['old', { secret: 'old-key-5d1e', expiresAt: null }],
      ['new', { secret: 'new-key-8c3a', expiresAt: null }],
    ]);
    const base = await boot(mutableRing(keys));
    const oldA = await signIn(base, 'old-key-5d1e');
    const oldB = await signIn(base, 'old-key-5d1e');
    const fresh = await signIn(base, 'new-key-8c3a');
    const page = (cookie: string) => fetch(`${base}/`, { headers: { ...HTML, cookie }, redirect: 'manual' });
    const api = (cookie: string) => fetch(`${base}/api/v1/traces`, { headers: { cookie } });

    for (const c of [oldA, oldB, fresh]) expect((await page(c)).status).toBe(200);

    keys.delete('old');

    for (const c of [oldA, oldB]) {
      expect((await page(c)).status).toBe(401);
      expect((await api(c)).status).toBe(401);
    }
    expect((await page(fresh)).status).toBe(200);
    expect((await api(fresh)).status).toBe(200);
  });

  it('a key whose expiry is moved earlier ends its sessions at the new time', async () => {
    const keys = new Map([['k', { secret: 'k-key-2b7f', expiresAt: null as number | null }]]);
    const base = await boot(mutableRing(keys));
    const cookie = await signIn(base, 'k-key-2b7f');
    const page = () => fetch(`${base}/`, { headers: { ...HTML, cookie }, redirect: 'manual' });
    expect((await page()).status).toBe(200);

    keys.set('k', { secret: 'k-key-2b7f', expiresAt: Date.now() - 1 });
    expect((await page()).status).toBe(401);
  });
});
