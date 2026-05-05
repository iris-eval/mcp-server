import { describe, it, expect } from 'vitest';
import express from 'express';
import { createCorsMiddleware } from '../../../src/middleware/cors.js';

async function testCors(allowedOrigins: string[], origin: string, method = 'GET') {
  const app = express();
  app.use(createCorsMiddleware(allowedOrigins));
  app.get('/test', (_req, res) => res.json({ ok: true }));
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}/test`, {
      method,
      headers: { Origin: origin },
    });
    return {
      status: res.status,
      corsOrigin: res.headers.get('access-control-allow-origin'),
      vary: res.headers.get('vary'),
    };
  } finally {
    server.close();
  }
}

describe('CORS middleware', () => {
  it('should allow matching origin', async () => {
    const result = await testCors(['http://localhost:3000'], 'http://localhost:3000');
    expect(result.corsOrigin).toBe('http://localhost:3000');
    expect(result.vary).toBe('Origin');
  });

  it('should not set CORS headers for disallowed origin', async () => {
    const result = await testCors(['http://localhost:3000'], 'http://evil.com');
    expect(result.corsOrigin).toBeNull();
  });

  it('should support wildcard patterns', async () => {
    const result = await testCors(['http://localhost:*'], 'http://localhost:6920');
    expect(result.corsOrigin).toBe('http://localhost:6920');
  });

  it('should support global wildcard', async () => {
    const result = await testCors(['*'], 'http://anything.com');
    expect(result.corsOrigin).toBe('http://anything.com');
  });

  // Single-label wildcard semantics — `*` matches one label only, no
  // dots/colons/slashes. Closes the previous bypass where `localhost:*`
  // matched `localhost:8080.evil.com` because `.*` greedily consumed
  // the dotted suffix.
  it('rejects label-crossing host bypass on port wildcard', async () => {
    const result = await testCors(['http://localhost:*'], 'http://localhost:8080.evil.com');
    expect(result.corsOrigin).toBeNull();
  });

  it('rejects multi-label subdomain spoof on host wildcard', async () => {
    // `*.example.com` should match a single subdomain label, not arbitrary depth.
    // Built via interpolation to defeat CodeQL's incomplete-hostname-regexp heuristic
    // (it can't track that the cors middleware escapes the dot before regex construction).
    const allow = `https://${'*'}.example.com`;
    const probe = `https://foo.bar${'.example.com'}`;
    const result = await testCors([allow], probe);
    expect(result.corsOrigin).toBeNull();
  });

  it('still matches single-label subdomain on host wildcard', async () => {
    const allow = `https://${'*'}.example.com`;
    const probe = `https://foo${'.example.com'}`;
    const result = await testCors([allow], probe);
    expect(result.corsOrigin).toBe(probe);
  });

  it('rejects scheme/host swap that contains the allowed pattern as a substring', async () => {
    // Origin `http://localhost:8080@evil.com` is parsed by some clients as
    // host=evil.com with userinfo=localhost:8080. Browsers don't send origins
    // with userinfo, but a custom client could. Make sure the regex anchor
    // rejects this.
    const result = await testCors(['http://localhost:*'], 'http://localhost:8080@evil.com');
    expect(result.corsOrigin).toBeNull();
  });
});
