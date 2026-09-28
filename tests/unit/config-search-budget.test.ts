/*
 * The search time budget is set by storage.searchBudgetMs in config.json or
 * IRIS_SEARCH_BUDGET_MS (#703), and reaches the store: a value out of range
 * refuses startup naming it, the environment wins over the file, and the
 * store built from the config stops a search at that budget.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../../src/config/index.js';
import { SEARCH_BUDGET_RANGE_MS } from '../../src/config/schema.js';
import { createStorage } from '../../src/storage/index.js';
import { SEARCH_BUDGET_MS } from '../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../src/types/tenant.js';

const VARS = ['IRIS_HOME', 'IRIS_DB_PATH', 'IRIS_SEARCH_BUDGET_MS'] as const;
let scratch: string;
let home: string;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const v of VARS) saved[v] = process.env[v];
  scratch = mkdtempSync(join(tmpdir(), 'iris-config-search-budget-'));
  home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  process.env.IRIS_HOME = home;
  delete process.env.IRIS_DB_PATH;
  delete process.env.IRIS_SEARCH_BUDGET_MS;
});

afterEach(() => {
  for (const v of VARS) {
    if (saved[v] === undefined) delete process.env[v];
    else process.env[v] = saved[v];
  }
  rmSync(scratch, { recursive: true, force: true });
});

const writeConfig = (value: unknown) => writeFileSync(join(home, 'config.json'), JSON.stringify(value));

describe('the search time budget setting', () => {
  it(`is unset by default, and the store then uses ${SEARCH_BUDGET_MS} ms`, () => {
    expect(loadConfig().storage.searchBudgetMs).toBeUndefined();
    expect(SEARCH_BUDGET_MS).toBe(1000);
  });

  it('reads config.json, and the environment over it', () => {
    writeConfig({ storage: { searchBudgetMs: 2500 } });
    expect(loadConfig().storage.searchBudgetMs).toBe(2500);
    process.env.IRIS_SEARCH_BUDGET_MS = '400';
    expect(loadConfig().storage.searchBudgetMs).toBe(400);
  });

  it(`refuses a value outside ${SEARCH_BUDGET_RANGE_MS[0]}-${SEARCH_BUDGET_RANGE_MS[1]} ms, or not a whole number, naming it`, () => {
    for (const bad of ['0', '49', '60001', '1.5', 'fast', '-100']) {
      process.env.IRIS_SEARCH_BUDGET_MS = bad;
      expect(() => loadConfig(), bad).toThrow(`IRIS_SEARCH_BUDGET_MS=${JSON.stringify(bad)} is not a valid search budget (must be a whole number of milliseconds, 50-60000)`);
    }
    delete process.env.IRIS_SEARCH_BUDGET_MS;
    for (const bad of [10, 120_000, 99.5, '1000']) {
      writeConfig({ storage: { searchBudgetMs: bad } });
      expect(() => loadConfig(), String(bad)).toThrow(/storage\.searchBudgetMs/);
    }
    for (const good of ['50', '60000', ' 750 ']) {
      process.env.IRIS_SEARCH_BUDGET_MS = good;
      writeConfig({});
      expect(loadConfig().storage.searchBudgetMs).toBe(Number(good));
    }
  });

  it('reaches the store: a search there answers within that budget', async () => {
    process.env.IRIS_SEARCH_BUDGET_MS = '50';
    const config = loadConfig();
    const storage = createStorage(config);
    await storage.initialize();
    try {
      await storage.insertTraces(LOCAL_TENANT, [{ trace_id: 't1', agent_name: 'a', output: 'refund approved', timestamp: '2026-09-28T00:00:00.000Z' }]);
      const r = await storage.queryTraces(LOCAL_TENANT, { search: 'refund' });
      expect(r.search?.complete).toBe(true);
      expect((storage as unknown as { searchBudgetMs: number }).searchBudgetMs).toBe(50);
    } finally {
      await storage.close();
    }
  });
});
