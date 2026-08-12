/*
 * An unmatched /api/ path must answer as an API, not as the app.
 *
 * Found by an end-user persona review of the packed tarball, not by this
 * suite — which is the point. Every test we write hits routes we know
 * exist; a user's first encounter with the API is often a typo.
 *
 * Before the fix, the SPA catch-all swallowed mistyped API routes:
 *   GET /api/v1/tracez  ->  200 OK, Content-Type: text/html, index.html
 * A client saw SUCCESS and then threw "Unexpected token '<'" out of
 * res.json(), sending the developer to debug their payload instead of
 * their URL, and a liveness probe asserting only status === 200 would
 * report a nonexistent endpoint healthy. POST to an unknown /api/ route
 * reached Express's stock HTML error page — the same problem, smaller hat.
 *
 * Drives the REAL server over a REAL socket so the assertion covers the
 * actual middleware order, which is where the bug lived.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { defaultConfig } from '../../src/config/defaults.js';

const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

interface Booted {
  storage: SqliteAdapter;
  server: Server;
  base: string;
}

const booted: Booted[] = [];

afterEach(async () => {
  for (const b of booted.splice(0)) {
    b.server.closeAllConnections?.();
    await new Promise<void>((resolve) => b.server.close(() => resolve()));
    await b.storage.close();
  }
});

async function boot(): Promise<Booted> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const config = {
    ...defaultConfig,
    dashboard: { ...defaultConfig.dashboard, port: 0 },
  };
  const dashboard = createDashboardServer(storage, config, mockLogger);
  const server = dashboard.start();
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const entry = { storage, server, base: `http://127.0.0.1:${port}` };
  booted.push(entry);
  return entry;
}

describe('unknown /api/ routes answer as an API', () => {
  it('GET a mistyped API route is 404 JSON, not 200 HTML', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/v1/tracez`);

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    // The load-bearing assertion: a client can parse the failure.
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });

  it('POST to an unknown API route is 404 JSON, not an HTML error page', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/v1/nope`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });

    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toContain('application/json');
    await expect(res.json()).resolves.toMatchObject({ error: expect.any(String) });
  });

  it('every method on an unknown API route stays JSON', async () => {
    const { base } = await boot();
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const res = await fetch(`${base}/api/v1/not-a-route`, { method });
      expect(res.status, `${method} status`).toBe(404);
      expect(res.headers.get('content-type'), `${method} content-type`).toContain('application/json');
    }
  });

  it('a REAL API route still works — the guard is scoped, not a blanket', async () => {
    const { base } = await boot();
    const res = await fetch(`${base}/api/v1/health`);

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  it('non-API paths still fall through to the SPA so deep links survive a reload', async () => {
    const { base } = await boot();
    // Without a built UI bundle the SPA fallback is not registered at all and
    // Express answers 404; with one it serves index.html. Either is correct —
    // what must NOT happen is this path being captured by the API 404 guard,
    // which would break /traces/<id> on refresh.
    const res = await fetch(`${base}/traces/abc123`);

    if (res.status === 200) {
      expect(res.headers.get('content-type')).toContain('text/html');
    } else {
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('Unknown API route');
    }
  });
});
