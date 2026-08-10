import { describe, it, expect } from 'vitest';
import express from 'express';
import { request as httpRequest } from 'node:http';
import {
  createRebindingGuard,
  isLoopbackHost,
  loopbackHostsFor,
} from '../../../src/middleware/rebinding-guard.js';

/*
 * Every assertion drives a REAL express server over a REAL socket, so the
 * header values under test are the ones Node actually produces rather than
 * ones this file invented. That distinction is why the pre-0.4.5 SSRF guard
 * was inert in production: its test asserted '::1' while URL.hostname
 * returns '[::1]'.
 *
 * node:http rather than fetch, deliberately: `Host` is a forbidden header
 * name in fetch, which drops it silently. A fetch-based test of the Host
 * branch passes while asserting nothing — it did, on the first draft of
 * this file.
 */
async function probe(
  guard: { host: string; allowedOrigins?: string[] },
  headers: { origin?: string; host?: string } = {},
): Promise<number> {
  const app = express();
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;

  // Built against the port actually bound, exactly as dashboard/server.ts does.
  app.use(createRebindingGuard({ port, host: guard.host, allowedOrigins: guard.allowedOrigins }));
  app.get('/api/v1/traces', (_req, res) => res.json({ ok: true }));

  try {
    return await new Promise<number>((resolve, reject) => {
      const outgoing: Record<string, string> = {};
      if (headers.origin) outgoing.Origin = headers.origin;
      if (headers.host) outgoing.Host = headers.host;
      const req = httpRequest(
        { host: '127.0.0.1', port, path: '/api/v1/traces', method: 'GET', headers: outgoing },
        (res) => {
          res.resume();
          res.once('end', () => resolve(res.statusCode ?? 0));
        },
      );
      req.once('error', reject);
      req.end();
    });
  } finally {
    server.close();
  }
}

describe('DNS-rebinding guard', () => {
  it('allows a request with no Origin (curl, MCP client, health probe)', async () => {
    expect(await probe({ host: '127.0.0.1' })).toBe(200);
  });

  it("allows this server's own loopback origin", async () => {
    const app = express();
    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    app.use(createRebindingGuard({ port, host: '127.0.0.1' }));
    app.get('/api/v1/traces', (_req, res) => res.json({ ok: true }));
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/v1/traces`, {
        headers: { Origin: `http://localhost:${port}` },
      });
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('REJECTS a hostile Origin — the rebinding attack', async () => {
    expect(await probe({ host: '127.0.0.1' }, { origin: 'http://evil.attacker.com' })).toBe(403);
  });

  it('rejects a loopback origin on a DIFFERENT port', async () => {
    // Another local app (or a rebound page that guessed a port) is still
    // cross-origin to this server.
    expect(await probe({ host: '127.0.0.1' }, { origin: 'http://localhost:1' })).toBe(403);
  });

  it('drops glob entries from the operator allowlist instead of honouring them', async () => {
    // 'http://localhost:*' is the SHIPPED CORS default. Against a single
    // concrete Origin a glob cannot be matched safely, so it must not pass —
    // otherwise the default config defeats the guard.
    expect(
      await probe(
        { host: '127.0.0.1', allowedOrigins: ['http://localhost:*'] },
        { origin: 'http://localhost:9999' },
      ),
    ).toBe(403);
  });

  it('honours an exact operator-configured origin', async () => {
    expect(
      await probe(
        { host: '127.0.0.1', allowedOrigins: ['http://my-proxy.internal:8080'] },
        { origin: 'http://my-proxy.internal:8080' },
      ),
    ).toBe(200);
  });

  it('rejects a foreign Host header when bound to loopback', async () => {
    expect(await probe({ host: '127.0.0.1' }, { host: 'attacker-controlled.example.com' })).toBe(
      403,
    );
  });

  it('does NOT enforce Host when bound beyond loopback (proxy deployments)', async () => {
    expect(await probe({ host: '0.0.0.0' }, { host: 'iris.internal.example.com' })).toBe(200);
  });
});

describe('ephemeral-port binding', () => {
  it('builds the allowlist from the bound port, not the configured 0', async () => {
    /*
     * The dashboard registers this middleware BEFORE listen(), and callers
     * that want an ephemeral port configure 0. A guard that captured the
     * configured value would allow only `http://localhost:0` and 403 every
     * legitimate request — an outage dressed as an attack. Same failure the
     * MCP transport avoids by binding first.
     */
    const app = express();
    let boundPort: number | undefined;
    app.use(createRebindingGuard({ port: () => boundPort ?? 0, host: '127.0.0.1' }));
    app.get('/api/v1/traces', (_req, res) => res.json({ ok: true }));

    const server = app.listen(0, '127.0.0.1');
    await new Promise((r) => server.once('listening', r));
    const port = (server.address() as { port: number }).port;
    boundPort = port;

    try {
      const allowed = await fetch(`http://127.0.0.1:${port}/api/v1/traces`, {
        headers: { Origin: `http://127.0.0.1:${port}` },
      });
      expect(allowed.status).toBe(200);
    } finally {
      server.close();
    }
  });
});

describe('loopback helpers', () => {
  it('treats the bracketed IPv6 literal as loopback', () => {
    // Node reports the IPv6 loopback Host header as '[::1]:port' — brackets
    // included. A guard written against bare '::1' would never fire.
    expect(isLoopbackHost('[::1]')).toBe(true);
    expect(isLoopbackHost('::1')).toBe(true);
    expect(isLoopbackHost('127.0.0.1')).toBe(true);
    expect(isLoopbackHost('localhost')).toBe(true);
    expect(isLoopbackHost('0.0.0.0')).toBe(false);
    expect(isLoopbackHost('192.168.1.10')).toBe(false);
  });

  it('builds host allowlists in the bracketed form Node emits', () => {
    expect(loopbackHostsFor(6920)).toContain('[::1]:6920');
  });
});
