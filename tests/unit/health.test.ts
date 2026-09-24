/*
 * buildHealth — the one health contract.
 *
 * Both ports call this function, so its shape is asserted once, here: the
 * driver word, the checks block (storage, the deployed-rules file, the
 * migrations applied against known), the all-time trace count, and the
 * verdict — `ok` only when every check that could run is ok, `degraded`
 * with 503 otherwise. The route tests only prove the routes call it.
 */
import { describe, it, expect } from 'vitest';
import { buildHealth } from '../../src/health.js';
import { SqliteAdapter, SQLITE_DRIVER } from '../../src/storage/sqlite-adapter.js';
import { KNOWN_MIGRATION_IDS } from '../../src/storage/migrations/index.js';
import type { IStorageAdapter } from '../../src/types/query.js';
import type { CustomRuleStore } from '../../src/custom-rule-store.js';

const storageThat = (overrides: Partial<Record<keyof IStorageAdapter, unknown>>): IStorageAdapter =>
  ({
    driver: 'mock',
    queryTraces: async () => ({ traces: [], total: 4, limit: 1, offset: 0 }),
    migrations: async () => ({ applied: KNOWN_MIGRATION_IDS.length, known: KNOWN_MIGRATION_IDS.length, pending: [] }),
    ...overrides,
  }) as unknown as IStorageAdapter;

describe('buildHealth', () => {
  it('with no storage: ok, every check absent, no driver, no trace count', async () => {
    const { status, body } = await buildHealth({ version: '9.9.9' });
    expect(status).toBe(200);
    expect(body.status).toBe('ok');
    expect(body.version).toBe('9.9.9');
    expect(body.driver).toBeNull();
    expect(body.checks).toEqual({ storage: 'absent', rules_store: 'absent', migrations: { status: 'absent', applied: 0, known: 0 } });
    expect(body).not.toHaveProperty('trace_count');
    expect(body).not.toHaveProperty('storage');
    expect(body.mode).toBe('real');
    expect(typeof body.uptime_seconds).toBe('number');
    expect(body.judge).toHaveProperty('enabled');
    expect(body.judge).toHaveProperty('provider');
  });

  it('with a real store: the driver word, every known migration applied and counted, the all-time count, the mode', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    try {
      const { status, body } = await buildHealth({ storage, version: '9.9.9', mode: 'demo' });
      expect(status).toBe(200);
      expect(body.status).toBe('ok');
      // The word is the driver that holds the file — the native addon by default, the built-in when IRIS_SQLITE_DRIVER=node (the CI matrix runs both).
      expect(body.driver).toBe(storage.driver);
      expect(['better-sqlite3', 'node']).toContain(body.driver);
      expect(SQLITE_DRIVER).toBe('better-sqlite3');
      expect(body.checks.storage).toBe('ok');
      expect(KNOWN_MIGRATION_IDS.length).toBeGreaterThanOrEqual(11);
      expect(body.checks.migrations).toEqual({ status: 'ok', applied: KNOWN_MIGRATION_IDS.length, known: KNOWN_MIGRATION_IDS.length });
      expect(body.trace_count).toBe(0);
      expect(body.storage).toBe('connected');
      expect(body.mode).toBe('demo');
    } finally {
      await storage.close();
    }
  });

  it('a store that cannot count degrades to 503 and names the check that failed', async () => {
    const storage = storageThat({
      queryTraces: async () => {
        throw new Error('database is locked');
      },
    });
    const { status, body } = await buildHealth({ storage });
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks.storage).toBe('fail');
    expect(body.checks.migrations.status).toBe('ok');
    expect(body.storage).toBe('disconnected');
    expect(body).not.toHaveProperty('trace_count');
  });

  it('a migration this build knows and the database has not applied is a failed check, with the numbers', async () => {
    const storage = storageThat({ migrations: async () => ({ applied: 11, known: 12, pending: ['012-datasets'] }) });
    const { status, body } = await buildHealth({ storage });
    expect(status).toBe(503);
    expect(body.status).toBe('degraded');
    expect(body.checks.storage).toBe('ok');
    expect(body.checks.migrations).toEqual({ status: 'fail', applied: 11, known: 12 });
  });

  it('the deployed-rules store is checked when given: a readable file is ok, one that throws degrades', async () => {
    const readable = { list: () => [] } as unknown as CustomRuleStore;
    const broken = {
      list: () => {
        throw new Error('custom-rules.json: unexpected token');
      },
    } as unknown as CustomRuleStore;
    const ok = await buildHealth({ storage: storageThat({}), customRuleStore: readable });
    expect(ok.status).toBe(200);
    expect(ok.body.checks.rules_store).toBe('ok');
    const bad = await buildHealth({ storage: storageThat({}), customRuleStore: broken });
    expect(bad.status).toBe(503);
    expect(bad.body.status).toBe('degraded');
    expect(bad.body.checks.rules_store).toBe('fail');
    expect(bad.body.checks.storage).toBe('ok');
  });
});
