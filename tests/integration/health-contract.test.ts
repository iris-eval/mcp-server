/*
 * One health contract on both ports, outside every rate limit.
 *
 * Until 0.15.0 the MCP transport's /health answered `{ status, server,
 * timestamp }` while the dashboard's /api/v1/health answered the fuller
 * shape, and the API reference called them "the same contract". Both now
 * call src/health.ts; this test reads both ports and compares the keys.
 *
 * The API reference has also said since 0.5.0 that health is "no rate
 * limit", while the route sat behind the API limiter and the auth-gate
 * limiter. With `rateLimit.api` set to 2, six health reads must all be
 * 200 while the third read of any API route is 429.
 */
import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { createHttpTransport } from '../../src/transport/http.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { KNOWN_MIGRATION_IDS } from '../../src/storage/migrations/index.js';
import type { IrisConfig } from '../../src/types/config.js';

const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

const servers: Server[] = [];
const stores: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  for (const st of stores.splice(0)) await st.close();
});

async function store(): Promise<SqliteAdapter> {
  const s = new SqliteAdapter(':memory:');
  await s.initialize();
  stores.push(s);
  return s;
}

function portOf(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr ? addr.port : 0;
}

async function startDashboard(storage: SqliteAdapter, config: IrisConfig): Promise<string> {
  const server = createDashboardServer(storage, config, mockLogger).start();
  await new Promise((r) => server.once('listening', r));
  servers.push(server);
  return `http://127.0.0.1:${portOf(server)}`;
}

describe('one health contract', () => {
  it('the MCP transport and the dashboard answer the same shape, built from the same store', async () => {
    const storage = await store();
    const config: IrisConfig = {
      ...defaultConfig,
      transport: { ...defaultConfig.transport, host: '127.0.0.1', port: 0 },
      dashboard: { ...defaultConfig.dashboard, port: 0 },
    };
    const { httpServer } = await createHttpTransport(new McpServer({ name: 'iris-eval-test', version: '0.0.0' }), config, mockLogger, { storage });
    servers.push(httpServer);
    const dashboardBase = await startDashboard(storage, config);

    const transportRes = await fetch(`http://127.0.0.1:${portOf(httpServer)}/health`);
    const dashboardRes = await fetch(`${dashboardBase}/api/v1/health`);
    expect(transportRes.status).toBe(200);
    expect(dashboardRes.status).toBe(200);
    const a = (await transportRes.json()) as Record<string, unknown>;
    const b = (await dashboardRes.json()) as Record<string, unknown>;

    for (const body of [a, b]) {
      expect(body.status).toBe('ok');
      expect(body.version).toBe(config.server.version);
      expect(body.driver).toBe(storage.driver);
      expect(body.checks).toEqual({
        storage: 'ok',
        rules_store: 'absent',
        migrations: { status: 'ok', applied: KNOWN_MIGRATION_IDS.length, known: KNOWN_MIGRATION_IDS.length },
      });
      // Unauthenticated: whether the store answers, never how much it holds.
      expect(body).not.toHaveProperty('trace_count');
      expect(body.storage).toBe('connected');
      expect(body.mode).toBe('real');
      // Never the key, never a trace.
      expect(JSON.stringify(body)).not.toMatch(/apiKey|Bearer/);
    }
    expect(Object.keys(a).sort()).toEqual(Object.keys(b).sort());
  });

  it('the dashboard health sits outside the rate limits; the API does not', async () => {
    const storage = await store();
    const config: IrisConfig = {
      ...defaultConfig,
      dashboard: { ...defaultConfig.dashboard, port: 0 },
      security: { ...defaultConfig.security, rateLimit: { api: 2, mcp: 20 } },
    };
    const base = await startDashboard(storage, config);

    const healthCodes: number[] = [];
    for (let i = 0; i < 6; i++) healthCodes.push((await fetch(`${base}/api/v1/health`)).status);
    expect(healthCodes).toEqual([200, 200, 200, 200, 200, 200]);

    const apiCodes: number[] = [];
    for (let i = 0; i < 3; i++) apiCodes.push((await fetch(`${base}/api/v1/summary`)).status);
    expect(apiCodes).toEqual([200, 200, 429]);

    // And health still answers after the API has been limited.
    expect((await fetch(`${base}/api/v1/health`)).status).toBe(200);
  });

  it('the transport health carries no storage when none is attached — the embedder case', async () => {
    const config: IrisConfig = { ...defaultConfig, transport: { ...defaultConfig.transport, host: '127.0.0.1', port: 0 } };
    const { httpServer } = await createHttpTransport(new McpServer({ name: 'iris-eval-test', version: '0.0.0' }), config, mockLogger);
    servers.push(httpServer);
    const body = (await (await fetch(`http://127.0.0.1:${portOf(httpServer)}/health`)).json()) as Record<string, unknown>;
    expect(body.status).toBe('ok');
    expect(body.driver).toBeNull();
    expect(body.checks).toEqual({ storage: 'absent', rules_store: 'absent', migrations: { status: 'absent', applied: 0, known: 0 } });
  });
});
