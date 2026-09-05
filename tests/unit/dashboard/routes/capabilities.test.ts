/*
 * GET /api/v1/capabilities serves the same object iris://capabilities does:
 * the judge state with the enable steps, the roster with proof, the limits,
 * the registrations — and never a key.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../../../src/dashboard/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { createLogger } from '../../../../src/utils/logger.js';
import { EvalEngine } from '../../../../src/eval/engine.js';
import { TOOL_NAMES } from '../../../../src/tools/index.js';
import { RESOURCE_URIS } from '../../../../src/resources/uris.js';

describe('GET /api/v1/capabilities', () => {
  let storage: SqliteAdapter;
  let server: Server;
  let port = 0;
  const saved = process.env.IRIS_ANTHROPIC_API_KEY;

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
    server = createDashboardServer(storage, config, createLogger(config), { evalEngine, mode: 'demo' }).start();
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
    if (saved === undefined) delete process.env.IRIS_ANTHROPIC_API_KEY;
    else process.env.IRIS_ANTHROPIC_API_KEY = saved;
  });

  it('reports the judge state, the roster with proof, the limits and the registrations, and leaks no key', async () => {
    process.env.IRIS_ANTHROPIC_API_KEY = 'sk-ant-secret-key-value-12345678';
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/capabilities`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      version: string;
      judge: { enabled: boolean; provider: string; providers: string[]; costCapUsd: number; howToEnable: string[] };
      rules: Array<{ name: string; critical: boolean; needs: string[]; proof: { precision: number | null; ppvAt: Record<string, number | null> } | null }>;
      limits: { customRulesPerCall: number; regexBudgetMs: number };
      dashboard: { mode: string };
      tools: string[];
      resources: string[];
    };
    expect(body.version).toBe(defaultConfig.server.version);
    expect(body.judge).toMatchObject({ enabled: true, provider: 'anthropic', providers: ['anthropic'] });
    expect(body.judge.howToEnable.length).toBeGreaterThanOrEqual(4);
    expect(JSON.stringify(body)).not.toContain('secret-key-value');
    const pii = body.rules.find((r) => r.name === 'no_pii')!;
    expect(pii.critical).toBe(true);
    expect(pii.proof?.ppvAt).toHaveProperty('0.01');
    expect(body.limits).toMatchObject({ customRulesPerCall: 10, regexBudgetMs: 100 });
    expect(body.dashboard.mode).toBe('demo');
    expect(body.tools.sort()).toEqual([...TOOL_NAMES].sort());
    expect(body.resources.sort()).toEqual([...RESOURCE_URIS].sort());
  });
});
