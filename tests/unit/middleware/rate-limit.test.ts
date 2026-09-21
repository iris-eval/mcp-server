import { describe, it, expect } from 'vitest';
import express from 'express';
import {
  createApiRateLimiter,
  createMcpRateLimiter,
  JSON_RPC_RATE_LIMITED,
} from '../../../src/middleware/rate-limit.js';
import type { IrisConfig } from '../../../src/types/config.js';
import type { AuthedRequest } from '../../../src/middleware/auth.js';

function makeConfig(apiLimit: number, mcpLimit = 20): Pick<IrisConfig, 'security'> {
  return {
    security: {
      apiKey: undefined,
      allowedOrigins: ['*'],
      rateLimit: { api: apiLimit, mcp: mcpLimit },
      requestSizeLimit: '1mb',
    },
  };
}

/*
 * #373 item 4 — the MCP endpoint's 429 must be a JSON-RPC message. The
 * stock express-rate-limit body `{ "error": "Too many requests" }` made a
 * strict client surface a PROTOCOL failure instead of "wait, then retry".
 */
describe('MCP rate limiter speaks JSON-RPC on 429', () => {
  async function bootMcpApp(limit: number): Promise<{ url: string; close: () => void }> {
    const app = express();
    app.use(express.json());
    app.post('/mcp', createMcpRateLimiter(makeConfig(600, limit)), (_req, res) => res.json({ jsonrpc: '2.0', id: 1, result: {} }));
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    return { url: `http://localhost:${addr.port}/mcp`, close: () => server.close() };
  }

  const post = (url: string, body: unknown) =>
    fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('returns a JSON-RPC error envelope echoing the request id, with the limit and a retry hint', async () => {
    const { url, close } = await bootMcpApp(2);
    try {
      await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      await post(url, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      const res = await post(url, { jsonrpc: '2.0', id: 'req-3', method: 'tools/list' });
      expect(res.status).toBe(429);
      const body = (await res.json()) as {
        jsonrpc: string;
        id: unknown;
        error: { code: number; message: string; data: { limit: number; windowMs: number; retryAfterSeconds: number } };
      };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBe('req-3');
      expect(body.error.code).toBe(JSON_RPC_RATE_LIMITED);
      expect(body.error.message).toContain('2 requests per minute');
      expect(body.error.message).toContain('security.rateLimit.mcp');
      expect(body.error.data.limit).toBe(2);
      expect(body.error.data.windowMs).toBe(60_000);
      expect(body.error.data.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(body.error.data.retryAfterSeconds).toBeLessThanOrEqual(60);
      // The stock non-JSON-RPC shape is gone.
      expect((body as unknown as { error: unknown }).error).not.toBe('Too many requests, please try again later');
    } finally {
      close();
    }
  });

  it('uses id: null when the request carried no usable id (batch or malformed)', async () => {
    const { url, close } = await bootMcpApp(1);
    try {
      await post(url, { jsonrpc: '2.0', id: 1, method: 'tools/list' });
      const res = await post(url, [{ jsonrpc: '2.0', id: 1, method: 'tools/list' }]);
      expect(res.status).toBe(429);
      const body = (await res.json()) as { jsonrpc: string; id: unknown; error: { code: number } };
      expect(body.jsonrpc).toBe('2.0');
      expect(body.id).toBeNull();
      expect(body.error.code).toBe(JSON_RPC_RATE_LIMITED);
    } finally {
      close();
    }
  });
});

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

/*
 * What the MCP budget is counted against (arc 8, R-6): the client address
 * by default (the pre-0.15.0 behaviour), or the API key that authenticated
 * the request — so two agents behind one address each get their own
 * minute, and a request no key authenticated falls back to its address.
 */
describe('MCP rate limiter — mcpKeyBy', () => {
  function bootKeyed(keyBy: 'ip' | 'apiKey' | undefined, limit: number): { url: string; close: () => void } {
    const config = makeConfig(600, limit);
    if (keyBy) config.security.rateLimit = { ...config.security.rateLimit, mcpKeyBy: keyBy };
    const app = express();
    app.use(express.json());
    // Stand-in for the Bearer middleware: the id of the key the request presented.
    app.use((req, _res, next) => {
      const id = req.headers['x-test-key-id'];
      if (typeof id === 'string') (req as AuthedRequest).apiKeyId = id;
      next();
    });
    app.post('/mcp', createMcpRateLimiter(config), (_req, res) => res.json({ jsonrpc: '2.0', id: 1, result: {} }));
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    return { url: `http://localhost:${addr.port}/mcp`, close: () => server.close() };
  }

  const postAs = (url: string, keyId?: string) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(keyId ? { 'x-test-key-id': keyId } : {}) },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });

  it("by default the budget is per address: two keys from one address share it, and the sentence says 'client address'", async () => {
    const { url, close } = bootKeyed(undefined, 2);
    try {
      expect((await postAs(url, 'a')).status).toBe(200);
      expect((await postAs(url, 'b')).status).toBe(200);
      const third = await postAs(url, 'a');
      expect(third.status).toBe(429);
      const body = (await third.json()) as { error: { message: string } };
      expect(body.error.message).toContain('2 requests per minute per client address');
    } finally {
      close();
    }
  });

  it("with mcpKeyBy 'apiKey' each key has its own budget, an unkeyed request falls back to its address, and the sentence says 'API key'", async () => {
    const { url, close } = bootKeyed('apiKey', 2);
    try {
      expect((await postAs(url, 'a')).status).toBe(200);
      expect((await postAs(url, 'a')).status).toBe(200);
      const aThird = await postAs(url, 'a');
      expect(aThird.status).toBe(429);
      expect(((await aThird.json()) as { error: { message: string } }).error.message).toContain('2 requests per minute per API key');
      // b is untouched by a's spend.
      expect((await postAs(url, 'b')).status).toBe(200);
      expect((await postAs(url, 'b')).status).toBe(200);
      expect((await postAs(url, 'b')).status).toBe(429);
      // No key: the address bucket, still fresh.
      expect((await postAs(url)).status).toBe(200);
      expect((await postAs(url)).status).toBe(200);
      expect((await postAs(url)).status).toBe(429);
    } finally {
      close();
    }
  });
});
