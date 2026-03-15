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
});
