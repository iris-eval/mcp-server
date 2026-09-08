/*
 * The DNS-rebinding guard runs BEFORE the body parser, on both servers (A6-7).
 *
 * Until 0.13.0 `express.json()` was mounted first on both the dashboard and
 * the MCP HTTP transport, so a request from a rejected Origin still had its
 * body — up to the 1 MB limit — read and parsed before the guard answered
 * 403. Parsing a hostile body is work the server should never do; the
 * rejection is the cheapest response and it must come first.
 *
 * The proposition this file tests, precisely: a POST from a bad Origin
 * whose body the parser would REFUSE (it is over the size limit) is
 * answered 403 by the guard, not 413 by the parser. The control case —
 * the same body from no Origin — is 413, which proves the parser would
 * indeed have refused it and therefore that the guard answered first.
 * No spy on the parser is needed: the two middlewares have different
 * status codes, and the order of the pipeline is what the status reveals.
 *
 * Measured before this file was written (S97): the guard answers a rejected
 * Origin in ~12 ms with only the headers and one small chunk on the wire;
 * the parser answers 413 only after it has read the body (~28 ms with the
 * full 2 MB) — it does not refuse on the declared Content-Length alone. So
 * the two cases are sent differently, and that difference IS the
 * proposition: the rejected-Origin request sends headers plus 1 KB and
 * expects 403 within three seconds — if the parser ran first it would sit
 * waiting for the rest of the body and the client-side timeout turns that
 * into a failure; the control sends the whole body and expects 413.
 *
 * Every request rides a REAL socket so the middleware stack is production's.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { createHttpTransport } from '../../src/transport/http.js';
import { defaultConfig } from '../../src/config/defaults.js';

const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

/** Over the shipped 1mb request limit, and not JSON either. */
const OVERSIZED_BODY = Buffer.alloc(2 * 1024 * 1024, 0x78);
/** Long enough that a parser waiting for the rest of the body is unmistakable. */
const ANSWER_WITHIN_MS = 3_000;

const opened: Server[] = [];
let storage: SqliteAdapter | undefined;

afterEach(async () => {
  for (const s of opened.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  await storage?.close();
  storage = undefined;
});

/**
 * `send: 'headers-only'` writes the headers and 1 KB of a declared 2 MB body
 * and waits for an answer; `'full-body'` writes all 2 MB. Resolves with the
 * status, or with `'no answer'` when nothing came back in time.
 */
function post(
  port: number,
  path: string,
  opts: { origin?: string; send: 'headers-only' | 'full-body' },
): Promise<number | 'no answer'> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'Content-Length': String(OVERSIZED_BODY.length),
      Connection: 'close',
    };
    if (opts.origin) headers.Origin = opts.origin;
    let settled = false;
    const settle = (value: number | 'no answer') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The answer is in (or is not coming); any reset on the socket after this is noise.
      req.on('error', () => {});
      req.destroy();
      resolve(value);
    };
    const req = httpRequest({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      res.resume();
      settle(res.statusCode ?? 0);
    });
    const timer = setTimeout(() => settle('no answer'), ANSWER_WITHIN_MS);
    req.once('error', (err) => {
      if (!settled) {
        clearTimeout(timer);
        reject(err);
      }
    });
    if (opts.send === 'full-body') req.end(OVERSIZED_BODY);
    else req.write(OVERSIZED_BODY.subarray(0, 1024));
  });
}

async function bootDashboard(): Promise<number> {
  storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const config = { ...defaultConfig, dashboard: { ...defaultConfig.dashboard, port: 0 } };
  const server = createDashboardServer(storage, config, mockLogger).start();
  opened.push(server);
  await new Promise((r) => server.once('listening', r));
  return (server.address() as { port: number }).port;
}

async function bootTransport(): Promise<number> {
  const mcpServer = new McpServer({ name: 'guard-order-test', version: '0.0.0' });
  const config = { ...defaultConfig, transport: { ...defaultConfig.transport, host: '127.0.0.1', port: 0 } };
  const { httpServer } = await createHttpTransport(mcpServer, config, mockLogger);
  opened.push(httpServer);
  return (httpServer.address() as { port: number }).port;
}

describe('the rebinding guard answers before the body parser reads anything', () => {
  it('dashboard: a rejected Origin is 403 before the body arrives; the same oversized body with no Origin is 413 from the parser', async () => {
    const port = await bootDashboard();
    expect(await post(port, '/api/v1/traces', { send: 'full-body' })).toBe(413);
    expect(await post(port, '/api/v1/traces', { origin: 'http://evil.example', send: 'headers-only' })).toBe(403);
  });

  it('MCP HTTP transport: a rejected Origin is 403 before the body arrives; the same oversized body with no Origin is 413 from the parser', async () => {
    const port = await bootTransport();
    expect(await post(port, '/mcp', { send: 'full-body' })).toBe(413);
    expect(await post(port, '/mcp', { origin: 'http://evil.example', send: 'headers-only' })).toBe(403);
  });
});
