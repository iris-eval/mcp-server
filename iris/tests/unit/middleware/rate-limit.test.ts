import { describe, it, expect } from 'vitest';
import express from 'express';
import { createApiRateLimiter } from '../../../src/middleware/rate-limit.js';
import type { IrisConfig } from '../../../src/types/config.js';

function makeConfig(apiLimit: number): Pick<IrisConfig, 'security'> {
  return {
    security: {
      apiKey: undefined,
      allowedOrigins: ['*'],
      rateLimit: { api: apiLimit, mcp: 20 },
      requestSizeLimit: '1mb',
    },
  };
}

describe('rate limit middleware', () => {
  it('should allow requests within limit', async () => {
    const app = express();
    app.use(createApiRateLimiter(makeConfig(10)));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const res = await fetch(`http://localhost:${addr.port}/test`);
      expect(res.status).toBe(200);
    } finally {
      server.close();
    }
  });

  it('should return 429 when limit exceeded', async () => {
    const app = express();
    app.use(createApiRateLimiter(makeConfig(2)));
    app.get('/test', (_req, res) => res.json({ ok: true }));
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      await fetch(`http://localhost:${addr.port}/test`);
      await fetch(`http://localhost:${addr.port}/test`);
      const res = await fetch(`http://localhost:${addr.port}/test`);
      expect(res.status).toBe(429);
    } finally {
      server.close();
    }
  });
});
