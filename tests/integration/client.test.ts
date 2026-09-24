/*
 * The typed client against a real dashboard.
 *
 * `createClient` posts the same body the `log_trace` tool accepts and
 * returns the same evaluation `evaluate_output` returns; a refusal
 * carries the server's own sentence and status; the Bearer key is sent
 * when given and withheld when not; `health()` reads the unauthenticated
 * route on a keyed server too.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { createDashboardServer } from '../../src/dashboard/server.js';
import { SqliteAdapter } from '../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { createClient, IrisClientError } from '../../src/client.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

const mockLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const KEY = 'client-test-key-7c1d';

interface Booted {
  storage: SqliteAdapter;
  server: Server;
  base: string;
}
const booted: Booted[] = [];
afterEach(async () => {
  for (const b of booted.splice(0)) {
    b.server.closeAllConnections?.();
    await new Promise<void>((resolve) => b.server.close(() => resolve()));
    await b.storage.close();
  }
});

async function boot(apiKey?: string): Promise<Booted> {
  const storage = new SqliteAdapter(':memory:');
  await storage.initialize();
  const config = {
    ...defaultConfig,
    dashboard: { ...defaultConfig.dashboard, port: 0 },
    security: { ...defaultConfig.security, apiKey },
  };
  const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
  const server = createDashboardServer(storage, config, mockLogger, { evalEngine }).start();
  await new Promise((r) => server.once('listening', r));
  const port = (server.address() as { port: number }).port;
  const entry = { storage, server, base: `http://127.0.0.1:${port}/` };
  booted.push(entry);
  return entry;
}

describe('createClient', () => {
  it('stores and evaluates a trace in one call, and the evaluation is the one the tool returns', async () => {
    const { base, storage } = await boot();
    const iris = createClient({ baseUrl: base });
    const r = await iris.logTrace({ agent_name: 'client-test', input: 'Summarise the notes.', output: 'TODO: write the summary.', evaluate: true });
    expect(r.status).toBe('stored');
    expect(r.trace_id).toMatch(/^[0-9a-f]{32}$/);
    expect(r.evaluation?.verdict?.state).toBe('fail');
    expect(r.evaluation?.rule_results.some((x) => x.ruleName === 'no_stub_output' && x.passed === false)).toBe(true);
    // Stored, not merely answered.
    const stored = await storage.getTrace(LOCAL_TENANT, r.trace_id);
    expect(stored?.agent_name).toBe('client-test');
  });

  it('a store without evaluate returns no evaluation; health and capabilities read', async () => {
    const { base } = await boot();
    const iris = createClient({ baseUrl: base.replace(/\/$/, '') });
    const r = await iris.logTrace({ agent_name: 'client-test', output: 'Just stored.' });
    expect(r.status).toBe('stored');
    expect(r.evaluation).toBeUndefined();
    const health = await iris.health();
    expect(health.status).toBe('ok');
    expect(health.version).toMatch(/^\d+\.\d+\.\d+/);
    const caps = await iris.capabilities();
    expect(caps).toHaveProperty('tools');
  });

  it('on a keyed server the Bearer key authenticates, no key is refused with the server’s own sentence, and health stays open', async () => {
    const { base } = await boot(KEY);
    const keyed = createClient({ baseUrl: base, apiKey: KEY });
    const r = await keyed.logTrace({ agent_name: 'client-test', output: 'Stored with a key.' });
    expect(r.status).toBe('stored');

    const bare = createClient({ baseUrl: base });
    await expect(bare.logTrace({ agent_name: 'client-test', output: 'x' })).rejects.toBeInstanceOf(IrisClientError);
    try {
      await bare.logTrace({ agent_name: 'client-test', output: 'x' });
    } catch (err) {
      const e = err as IrisClientError;
      expect(e.status).toBe(401);
      expect(e.message).toMatch(/Authorization header/);
      expect(e.body).toHaveProperty('error');
    }
    expect((await bare.health()).status).toBe('ok');
  });

  it('a body the server refuses comes back as its 400 sentence, and evaluate without an output is refused before storing', async () => {
    const { base } = await boot();
    const iris = createClient({ baseUrl: base });
    try {
      await iris.logTrace({ agent_name: 'client-test', evaluate: true });
      throw new Error('expected a refusal');
    } catch (err) {
      const e = err as IrisClientError;
      expect(e).toBeInstanceOf(IrisClientError);
      expect(e.status).toBe(400);
      expect(JSON.stringify(e.body)).toMatch(/output/);
    }
  });
});
