import { describe, it, expect, afterEach } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../src/dashboard/server.js';
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
