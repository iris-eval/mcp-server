import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { request as httpRequest } from 'node:http';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { createHttpTransport } from '../../src/transport/http.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { defaultConfig } from '../../src/config/defaults.js';

const testConfig = {
  ...defaultConfig,
  dashboard: { ...defaultConfig.dashboard, port: 0 },
};
const mockLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
};

/*
 * DNS-rebinding protection on the MCP HTTP transport.
 *
 * The MCP spec requires servers to validate Origin on HTTP transports.
 * iris bound loopback but validated nothing, and security.apiKey is
 * undefined by default (auth middleware is then a pass-through) — so a
 * default `--transport http` server was reachable from any web page the
 * operator visited, via a hostname rebound to 127.0.0.1.
 *
 * Verified against the unpatched build: an `initialize` carrying
 * `Origin: https://evil.example.com` returned 200 and executed. It must
 * now be refused, WITHOUT breaking real MCP clients — which send no Origin
 * header at all, and which the SDK therefore never rejects.
 */
describe('MCP HTTP transport — DNS rebinding protection', () => {
  let httpServer: Server | undefined;

  afterEach(async () => {
    if (httpServer) {
      // A successful MCP session leaves a keep-alive connection open, and
      // server.close() waits for every socket to drain — which never happens
      // here, so teardown would hang past the hook timeout. Drop the sockets
      // first; nothing in these tests needs a graceful close.
      httpServer.closeAllConnections?.();
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
      httpServer = undefined;
    }
  });

  async function bootTransport() {
    const mcpServer = new McpServer({ name: 'iris-eval-test', version: '0.0.0' });
    const cfg = {
      ...defaultConfig,
      transport: { ...defaultConfig.transport, host: '127.0.0.1', port: 0 },
    };
    const { httpServer: server } = await createHttpTransport(mcpServer, cfg, mockLogger);
    httpServer = server;
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    return `http://127.0.0.1:${port}`;
  }

  const initBody = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    },
  };

  function post(base: string, headers: Record<string, string>) {
    return fetch(`${base}/mcp`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...headers,
      },
      body: JSON.stringify(initBody),
    });
  }

  it('rejects a cross-origin request (the rebinding attack)', async () => {
    const base = await bootTransport();
    const res = await post(base, { origin: 'https://evil.example.com' });
    expect(res.status).toBe(403);
  });

  it('allows a real MCP client, which sends no Origin header', async () => {
    const base = await bootTransport();
    const res = await post(base, {});
    expect(res.status).toBe(200);
  });

  it('allows a browser request from the server own origin', async () => {
    const base = await bootTransport();
    const res = await post(base, { origin: base });
    expect(res.status).toBe(200);
  });

  // Uses node:http rather than fetch: Host is a forbidden header name, so
  // fetch silently drops an override and the request would arrive with the
  // real Host — passing the assertion for the wrong reason.
  it('rejects a forged Host header when bound to loopback', async () => {
    const base = await bootTransport();
    const port = Number(new URL(base).port);
    const status = await new Promise<number>((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            host: 'evil.example.com',
          },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(initBody));
    });
    expect(status).toBe(403);
  });
});

describe('HTTP Transport Integration', () => {
  let httpServer: Server | undefined;
  let storage: SqliteAdapter;

  afterEach(async () => {
    if (httpServer) {
      await new Promise<void>((resolve) => httpServer!.close(() => resolve()));
    }
    if (storage) {
      await storage.close();
    }
  });

  it('should start dashboard server and respond to health check', async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();

    const dashboard = createDashboardServer(storage, testConfig, mockLogger);
    httpServer = dashboard.start();

    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    expect(port).toBeGreaterThan(0);

    const response = await fetch(`http://localhost:${port}/api/v1/health`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.status).toBe('ok');
  });

  it('should return summary data', async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();

    const dashboard = createDashboardServer(storage, testConfig, mockLogger);
    httpServer = dashboard.start();

    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const response = await fetch(`http://localhost:${port}/api/v1/summary`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.total_traces).toBe(0);
  });

  it('should return empty traces list', async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();

    const dashboard = createDashboardServer(storage, testConfig, mockLogger);
    httpServer = dashboard.start();

    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const response = await fetch(`http://localhost:${port}/api/v1/traces`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.traces).toEqual([]);
    expect(data.total).toBe(0);
  });

  it('should return filter options', async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();

    const dashboard = createDashboardServer(storage, testConfig, mockLogger);
    httpServer = dashboard.start();

    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const response = await fetch(`http://localhost:${port}/api/v1/filters`);
    expect(response.ok).toBe(true);
    const data = await response.json();
    expect(data.agent_names).toEqual([]);
    expect(data.frameworks).toEqual([]);
  });

  it('should enforce auth when API key configured', async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();

    const authConfig = { ...testConfig, security: { ...testConfig.security, apiKey: 'test-key' } };
    const dashboard = createDashboardServer(storage, authConfig, mockLogger);
    httpServer = dashboard.start();

    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    // Health should bypass auth
    const healthRes = await fetch(`http://localhost:${port}/api/v1/health`);
    expect(healthRes.ok).toBe(true);

    // API without key should fail
    const noAuthRes = await fetch(`http://localhost:${port}/api/v1/traces`);
    expect(noAuthRes.status).toBe(401);

    // API with key should work
    const authRes = await fetch(`http://localhost:${port}/api/v1/traces`, {
      headers: { Authorization: 'Bearer test-key' },
    });
    expect(authRes.ok).toBe(true);
  });

  it('should reject invalid query params', async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();

    const dashboard = createDashboardServer(storage, testConfig, mockLogger);
    httpServer = dashboard.start();

    const addr = httpServer.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;

    const response = await fetch(`http://localhost:${port}/api/v1/traces?limit=999999`);
    expect(response.status).toBe(400);
  });
});
