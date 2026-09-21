/*
 * The SQLite driver seam (arc 8, R-0).
 *
 * The bold sentence: when the native SQLite module cannot load, Iris falls
 * back to Node's built-in SQLite on Node 22.13+. This file proves the
 * seam three ways: the built-in driver chosen on purpose carries the
 * adapter through migrations, writes, reads and health with the same
 * PRAGMA set; a native load failure falls back to the built-in with one
 * warning (and does not when the fallback is forbidden, naming both); and
 * transactions on the built-in roll back and nest as the native ones do.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter, SQLITE_DRIVER } from '../../../src/storage/sqlite-adapter.js';
import { openDriver, requestedDriver, nodeSqliteAvailable, DRIVER_VAR, type Driver } from '../../../src/storage/driver.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { buildHealth } from '../../../src/health.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const dirs: string[] = [];
const drivers: Driver[] = [];
afterEach(async () => {
  for (const d of drivers.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-driver-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
};

const builtIn = nodeSqliteAvailable();
// The CI matrix runs this file with IRIS_SQLITE_DRIVER=node; the selection tests below are about what happens WITHOUT a choice, so they clear it and restore it.
const envBefore = process.env[DRIVER_VAR];
beforeEach(() => {
  delete process.env[DRIVER_VAR];
});
afterEach(() => {
  if (envBefore === undefined) delete process.env[DRIVER_VAR];
  else process.env[DRIVER_VAR] = envBefore;
});
/** On a Node without node:sqlite the built-in cannot be chosen; that refusal is the assertion there (a skip would drift the truthbase). */
const withoutBuiltIn = (path: string): void => {
  expect(builtIn).toBe(false);
  expect(() => openDriver(path, { driver: 'node' })).toThrow(/IRIS_SQLITE_DRIVER=node needs Node 22\.13\.0 or later/);
};

describe('the seam', () => {
  it('the default driver is the native addon, and the constant names it', async () => {
    const storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    try {
      expect(storage.driver).toBe('better-sqlite3');
      expect(SQLITE_DRIVER).toBe('better-sqlite3');
    } finally {
      await storage.close();
    }
  });

  it('IRIS_SQLITE_DRIVER accepts native and node under both spellings, and refuses anything else naming the two', () => {
    expect(requestedDriver({})).toBeUndefined();
    expect(requestedDriver({ [DRIVER_VAR]: '' })).toBeUndefined();
    expect(requestedDriver({ [DRIVER_VAR]: 'native' })).toBe('native');
    expect(requestedDriver({ [DRIVER_VAR]: 'better-sqlite3' })).toBe('native');
    expect(requestedDriver({ [DRIVER_VAR]: 'node' })).toBe('node');
    expect(requestedDriver({ [DRIVER_VAR]: ' NODE:SQLITE ' })).toBe('node');
    expect(() => requestedDriver({ [DRIVER_VAR]: 'postgres' })).toThrow(/IRIS_SQLITE_DRIVER="postgres" is not a driver\. Use "native" .* or "node"/);
  });

  it('IRIS_SQLITE_DRIVER=node in the environment opens the built-in with no option passed — the CI matrix cell', async () => {
    process.env[DRIVER_VAR] = 'node';
    if (!builtIn) {
      await expect(new SqliteAdapter(tempDb()).initialize()).rejects.toThrow(/IRIS_SQLITE_DRIVER=node needs Node 22\.13\.0 or later/);
      return;
    }
    const storage = new SqliteAdapter(tempDb());
    await storage.initialize();
    try {
      expect(storage.driver).toBe('node');
    } finally {
      await storage.close();
    }
  });

  it('chosen on purpose, the built-in driver carries the adapter: every migration, a round trip, the PRAGMA set, and health names it', async () => {
    const path = tempDb();
    if (!builtIn) return withoutBuiltIn(path);
    const storage = new SqliteAdapter(path, { driver: 'node' });
    await storage.initialize();
    try {
      expect(storage.driver).toBe('node');
      expect((await storage.migrations()).pending).toEqual([]);
      expect((await storage.migrations()).applied).toBe(KNOWN_MIGRATION_IDS.length);
      await storage.insertTrace(LOCAL_TENANT, { trace_id: 't1', agent_name: 'a', input: 'q', output: 'The answer, in full.', timestamp: '2026-09-01T10:00:00Z', cost_usd: 0.01 });
      expect((await storage.getTrace(LOCAL_TENANT, 't1'))?.output).toBe('The answer, in full.');
      expect((await storage.queryTraces(LOCAL_TENANT, { limit: 10, offset: 0 })).total).toBe(1);
      await storage.insertEvalResult(LOCAL_TENANT, { id: 'e1', trace_id: 't1', eval_type: 'all', output_text: 'x', score: 0.9, passed: true, rule_results: [], suggestions: [] });
      expect((await storage.getEvalsByTraceId(LOCAL_TENANT, 't1')).map((e) => e.id)).toEqual(['e1']);
      const health = await buildHealth({ storage, version: '9.9.9' });
      expect(health.status).toBe(200);
      expect(health.body.driver).toBe('node');
      expect(health.body.checks.migrations.status).toBe('ok');
      // The same PRAGMA set the native driver gets, plus the built-in's own hardening.
      const d = openDriver(path, { driver: 'node' });
      drivers.push(d);
      expect((d.pragma('journal_mode') as { journal_mode: string }).journal_mode).toBe('wal');
      expect((d.pragma('foreign_keys') as { foreign_keys: number }).foreign_keys).toBe(1);
      expect((d.pragma('trusted_schema') as { trusted_schema: number }).trusted_schema).toBe(0);
    } finally {
      await storage.close();
    }
  });

  it('when the native module cannot load, Iris falls back to the built-in with one warning that names the reason and the choice', () => {
    if (!builtIn) return withoutBuiltIn(tempDb());
    const warnings: string[] = [];
    const d = openDriver(tempDb(), {
      loadNative: () => {
        throw new Error('Could not locate the bindings file. Tried: build/Release/better_sqlite3.node');
      },
      warn: (line) => warnings.push(line),
    });
    drivers.push(d);
    expect(d.name).toBe('node');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/better-sqlite3\) could not load \(Could not locate the bindings file\. Tried: build\/Release\/better_sqlite3\.node\); falling back to Node's built-in SQLite/);
    expect(warnings[0]).toMatch(/IRIS_SQLITE_DRIVER=node/);
    d.exec('CREATE TABLE t (a TEXT)');
    expect(d.prepare('INSERT INTO t VALUES (?)').run('x').changes).toBe(1);
    expect(d.prepare('SELECT a FROM t').all()).toEqual([expect.objectContaining({ a: 'x' })]);
  });

  it('with the fallback forbidden — IRIS_SQLITE_DRIVER=native — a native load failure refuses, naming both the reason and the way out', () => {
    expect(() =>
      openDriver(tempDb(), {
        driver: 'native',
        loadNative: () => {
          throw new Error('invalid ELF header');
        },
        warn: () => {
          throw new Error('must not warn');
        },
      }),
    ).toThrow(/could not load: invalid ELF header\. IRIS_SQLITE_DRIVER=native forbids the fallback; unset it .* or reinstall the module \(npm rebuild better-sqlite3\)/);
    // And with no built-in to fall to, the same refusal points at Node.
    expect(() =>
      openDriver(tempDb(), {
        loadNative: () => {
          throw new Error('invalid ELF header');
        },
        loadNode: () => {
          throw new Error('no node:sqlite here');
        },
      }),
    ).toThrow(/could not load: invalid ELF header\. Node's built-in SQLite is not available/);
  });

  it('transactions on the built-in commit, roll back on a throw, run BEGIN IMMEDIATE, and nest as savepoints', () => {
    if (!builtIn) return withoutBuiltIn(tempDb());
    const d = openDriver(tempDb(), { driver: 'node' });
    drivers.push(d);
    d.exec('CREATE TABLE t (a INTEGER)');
    const insert = d.prepare('INSERT INTO t VALUES (?)');
    const count = () => (d.prepare('SELECT COUNT(*) AS n FROM t').get() as { n: number }).n;
    const ok = d.transaction((n: number) => {
      insert.run(n);
      return n * 2;
    });
    expect(ok(1)).toBe(2);
    expect(ok.immediate(2)).toBe(4);
    expect(count()).toBe(2);
    const bad = d.transaction(() => {
      insert.run(3);
      throw new Error('abort');
    });
    expect(() => bad()).toThrow('abort');
    expect(count()).toBe(2);
    // Nested: the inner failure rolls back to its savepoint; the outer commits what it did.
    const outer = d.transaction(() => {
      insert.run(10);
      try {
        d.transaction(() => {
          insert.run(11);
          throw new Error('inner');
        })();
      } catch {
        /* the inner savepoint rolled back */
      }
      insert.run(12);
    });
    outer();
    expect(d.prepare('SELECT a FROM t ORDER BY a').all().map((r) => (r as { a: number }).a)).toEqual([1, 2, 10, 12]);
  });

  it('fileMustExist refuses a missing file on the native driver, as the self-test relies on', () => {
    expect(() => openDriver(join(tempDb(), '..', 'nope.db'), { fileMustExist: true, driver: 'native' })).toThrow();
  });
});
