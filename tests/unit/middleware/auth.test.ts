import { describe, it, expect } from 'vitest';
import express from 'express';
import { createAuthMiddleware } from '../../../src/middleware/auth.js';
import type { IrisConfig } from '../../../src/types/config.js';

function makeConfig(apiKey?: string): Pick<IrisConfig, 'security'> {
  return {
    security: {
      apiKey,
      allowedOrigins: ['http://localhost:*'],
      rateLimit: { api: 100, mcp: 20 },
      requestSizeLimit: '1mb',
    },
  };
}

async function testRequest(app: express.Application, path: string, headers?: Record<string, string>) {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}${path}`, { headers });
    return { status: res.status, body: await res.json() };
  } finally {
    server.close();
  }
}

describe('auth middleware', () => {
  it('should pass through when no API key configured', async () => {
    const app = express();
    app.use(createAuthMiddleware(makeConfig(undefined)));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    const { status } = await testRequest(app, '/test');
    expect(status).toBe(200);
  });

  it('should return 401 when API key configured but no header sent', async () => {
    const app = express();
    app.use(createAuthMiddleware(makeConfig('secret123')));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    const { status } = await testRequest(app, '/test');
    expect(status).toBe(401);
  });

  it('should return 403 when wrong API key sent', async () => {
    const app = express();
    app.use(createAuthMiddleware(makeConfig('secret123')));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    const { status } = await testRequest(app, '/test', { Authorization: 'Bearer wrongkey' });
    expect(status).toBe(403);
  });

  it('should pass through when correct API key sent', async () => {
    const app = express();
    app.use(createAuthMiddleware(makeConfig('secret123')));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    const { status } = await testRequest(app, '/test', { Authorization: 'Bearer secret123' });
    expect(status).toBe(200);
  });

  it('should bypass auth for /health endpoint', async () => {
    const app = express();
    app.use(createAuthMiddleware(makeConfig('secret123')));
    app.get('/health', (_req, res) => res.json({ ok: true }));
    const { status } = await testRequest(app, '/health');
    expect(status).toBe(200);
  });

  it('should bypass auth for /api/v1/health endpoint', async () => {
    const app = express();
    app.use(createAuthMiddleware(makeConfig('secret123')));
    app.get('/api/v1/health', (_req, res) => res.json({ ok: true }));
    const { status } = await testRequest(app, '/api/v1/health');
    expect(status).toBe(200);
  });

  // Length-leak guard: short, same-length, and long mismatched tokens must
  // all flow through the same hash-compare path (no length-conditional
  // short-circuit). The unit test cannot observe timing, but it exercises
  // the additional code paths and documents the contract.
  it('rejects mismatched tokens regardless of length (no length leak)', async () => {
    const app = express();
    app.use(createAuthMiddleware(makeConfig('secret123')));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    // Note: an empty value after `Bearer ` is normalized away by fetch/undici
    // (trailing whitespace stripped), so it lands in the 401 branch, not 403.
    // The cases below exercise short, same-length-1-off, and long mismatches.
    for (const wrong of ['x', 'wrong1234', 'farTooLongForTheKey']) {
      const { status } = await testRequest(app, '/test', { Authorization: `Bearer ${wrong}` });
      expect(status).toBe(403);
    }
  });
});
