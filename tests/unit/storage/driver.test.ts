/*
 * The SQLite driver seam.
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
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createRequire } from 'node:module';
import { SqliteAdapter, SQLITE_DRIVER } from '../../../src/storage/sqlite-adapter.js';
import {
  openDriver,
  requestedDriver,
  nodeSqliteAvailable,
  nativeAbortsOnCollect,
  nativeBinaryPath,
  runtimeKeepsAddonHooks,
  OBJECTWRAP_HOOK_SYMBOL,
  sqliteHolding,
  DRIVER_VAR,
  type Driver,
} from '../../../src/storage/driver.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { buildHealth } from '../../../src/health.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const dirs: string[] = [];
const drivers: Driver[] = [];
afterEach(async () => {
  for (const d of drivers.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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
      // Except where this binary would abort the process on this Node: the CI job that compiles it from source on Node 24.
      expect(storage.driver).toBe(nativeAbortsOnCollect(nativeBinaryPath()) ? 'node' : 'better-sqlite3');
      expect(SQLITE_DRIVER).toBe('better-sqlite3');
    } finally {
      await storage.close();
    }
  });

  it('IRIS_SQLITE_DRIVER accepts native and node under both spellings, and refuses anything else naming the two', () => {
    expect(requestedDriver(undefined)).toBeUndefined();
    expect(requestedDriver('')).toBeUndefined();
    expect(requestedDriver('native')).toBe('native');
    expect(requestedDriver('better-sqlite3')).toBe('native');
    expect(requestedDriver('node')).toBe('node');
    expect(requestedDriver(' NODE:SQLITE ')).toBe('node');
    // And the default argument is the environment itself.
    process.env[DRIVER_VAR] = 'node';
    expect(requestedDriver()).toBe('node');
    delete process.env[DRIVER_VAR];
    expect(requestedDriver()).toBeUndefined();
    expect(() => requestedDriver('postgres')).toThrow(/IRIS_SQLITE_DRIVER="postgres" is not a driver\. Use "native" .* or "node"/);
  });

  it('IRIS_SQLITE_DRIVER=node in the environment opens the built-in with no option passed — the CI matrix cell', async () => {
    process.env[DRIVER_VAR] = 'node';
    if (!builtIn) {
      // The adapter opens the store in its constructor, so the refusal is synchronous.
      // With the floor at 22.13 every SUPPORTED runtime ships node:sqlite, so this
      // branch is the unsupported one — kept because the refusal must stay readable.
      expect(() => new SqliteAdapter(tempDb())).toThrow(/IRIS_SQLITE_DRIVER=node needs Node 22\.13\.0 or later/);
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
      await storage.insertEvalResult(LOCAL_TENANT, { id: 'e1', trace_id: 't1', eval_type: 'all', output_text: 'x', score: 0.9, passed: true, rule_results: [] });
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
    expect(warnings[0]).toMatch(/better-sqlite3\) could not load \(Could not locate the bindings file\. Tried: build\/Release\/better_sqlite3\.node\); using Node's built-in SQLite/);
    expect(warnings[0]).toMatch(/npm rebuild better-sqlite3/);
    expect(d.reason).toMatch(/^better-sqlite3 could not load \(Could not locate the bindings file/);
    expect(warnings[0]).toMatch(/IRIS_SQLITE_DRIVER=node/);
    d.exec('CREATE TABLE t (a TEXT)');
    expect(d.prepare('INSERT INTO t VALUES (?)').run('x').changes).toBe(1);
    expect(d.prepare('SELECT a FROM t').all()).toEqual([expect.objectContaining({ a: 'x' })]);
  });

  it('the binding failing at construction — the addon loads lazily, as better-sqlite3 does — falls back the same way', () => {
    if (!builtIn) return withoutBuiltIn(tempDb());
    const warnings: string[] = [];
    class Lazy {
      constructor() {
        throw Object.assign(new Error('Cannot load native addon because loading addons is disabled.'), { code: 'ERR_DLOPEN_DISABLED' });
      }
    }
    const d = openDriver(tempDb(), { loadNative: () => Lazy as never, warn: (line) => warnings.push(line) });
    drivers.push(d);
    expect(d.name).toBe('node');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('could not load (Cannot load native addon because loading addons is disabled.)');
  });

  it('fileMustExist on the built-in refuses a missing file and does not create it', () => {
    const missing = join(tempDb(), '..', 'nope.db');
    if (!builtIn) return withoutBuiltIn(missing);
    expect(() => openDriver(missing, { fileMustExist: true, driver: 'node' })).toThrow(/does not exist/);
    expect(existsSync(missing)).toBe(false);
  });

  it('better-sqlite3 not installed at all (it is optional since 0.20.0): the built-in holds the file, and the warning and the reason say it is absent, not broken', () => {
    if (!builtIn) return withoutBuiltIn(tempDb());
    const warnings: string[] = [];
    const d = openDriver(tempDb(), {
      loadNative: () => {
        throw Object.assign(new Error(["Cannot find module 'better-sqlite3'", 'Require stack:', '- /app/dist/storage/driver.js'].join('\n')), { code: 'MODULE_NOT_FOUND' });
      },
      warn: (line) => warnings.push(line),
    });
    drivers.push(d);
    expect(d.name).toBe('node');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/better-sqlite3\) is not installed — it is optional, and npm skips it when it cannot build it for this platform; using Node's built-in SQLite/);
    expect(warnings[0]).toMatch(/npm install better-sqlite3/);
    expect(warnings[0]).not.toMatch(/npm rebuild/);
    expect(d.reason).toMatch(/^better-sqlite3 is not installed/);
    d.exec('CREATE TABLE t (a TEXT)');
    expect(d.prepare('INSERT INTO t VALUES (?)').run('x').changes).toBe(1);
  });

  it('every driver says why it holds the file', () => {
    const native = openDriver(tempDb());
    drivers.push(native);
    if (native.name === 'better-sqlite3') expect(native.reason).toBe('better-sqlite3 loaded (the default)');
    if (!builtIn) return;
    const chosen = openDriver(tempDb(), { driver: 'node' });
    drivers.push(chosen);
    expect(chosen.reason).toBe("IRIS_SQLITE_DRIVER=node chose Node's built-in SQLite");
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
    ).toThrow(/could not load \(invalid ELF header\)\. IRIS_SQLITE_DRIVER=native forbids the fallback; unset it .* or reinstall it with npm rebuild better-sqlite3/);
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
    ).toThrow(/could not load \(invalid ELF header\)\. Node's built-in SQLite is not available/);
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

/*
 * Driver.writeShadowTables: SQLite's defensive mode off for the work it is
 * given (erasing a retired search index, search-index.ts), and on again
 * after, including when that work throws. Defensive mode is what keeps a
 * statement from writing FTS5's own tables; a connection left without it
 * would let any later statement corrupt the index.
 */
describe('writeShadowTables', () => {
  const shadowDelete = (d: Driver) => d.prepare('DELETE FROM f_data WHERE rowid IN (SELECT rowid FROM f_data LIMIT 1)').run();
  const withIndex = (d: Driver) => {
    d.exec("CREATE VIRTUAL TABLE f USING fts5(x, content = ''); INSERT INTO f (rowid, x) VALUES (1, 'alpha'), (2, 'beta')");
    return d;
  };

  it('on better-sqlite3: a shadow table is read-only outside it, writable inside it, and read-only again after work that throws', () => {
    if (nativeAbortsOnCollect(nativeBinaryPath())) {
      // A binary that aborts Node when it frees a statement (the job that builds the addon from source): the seam refuses it, so there is no native connection to hold to this.
      expect(() => openDriver(tempDb(), { driver: 'native' })).toThrow(/nodejs\/node#65446/);
      return;
    }
    const d = withIndex(openDriver(tempDb(), { driver: 'native' }));
    drivers.push(d);
    expect(() => shadowDelete(d)).toThrow(/may not be modified/);
    expect(d.writeShadowTables(() => shadowDelete(d).changes)).toBe(1);
    expect(() =>
      d.writeShadowTables(() => {
        throw new Error('a step failed');
      }),
    ).toThrow('a step failed');
    // Restored by the finally: the next statement is refused again.
    expect(() => shadowDelete(d)).toThrow(/may not be modified/);
  });

  it('on the built-in: turns defensive mode off and back on where the Node has the switch, also when the work throws', () => {
    if (!builtIn) return withoutBuiltIn(tempDb());
    const real = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: new (path: string, options?: Record<string, unknown>) => { exec(sql: string): void } };
    const calls: boolean[] = [];
    // A Node whose built-in has enableDefensive (newer lines do); the one this runs on may not.
    class Defensive extends real.DatabaseSync {
      enableDefensive(on: boolean): void {
        calls.push(on);
      }
    }
    const d = openDriver(tempDb(), { driver: 'node', loadNode: () => ({ DatabaseSync: Defensive }) as never });
    drivers.push(d);
    expect(d.writeShadowTables(() => 7)).toBe(7);
    expect(() =>
      d.writeShadowTables(() => {
        throw new Error('a step failed');
      }),
    ).toThrow('a step failed');
    expect(calls).toEqual([false, true, false, true]);
  });
});

/*
 * A better-sqlite3 binary compiled against Node 24.19+ headers aborts the
 * process the first time V8 frees one of its statements, on every Node that
 * lacks the global cleanup-hook list (nodejs/node#65446). The integration
 * tests run the real binary (native-addon-collect) and the real server
 * (native-teardown-stdio); these hold the decision itself.
 */
describe('a native binary that would abort on a collected statement', () => {
  const binaryFile = (marked: boolean): string => {
    const file = join(tempDb(), '..', marked ? 'marked.node' : 'plain.node');
    // The mark sits among the binary's imported names, as the linker writes it.
    writeFileSync(file, Buffer.concat([Buffer.alloc(4096, 0x7f), Buffer.from(marked ? `_ZN4node28${OBJECTWRAP_HOOK_SYMBOL}EPN2v87IsolateEPFvPvES3_` : '_ZN4node25AddEnvironmentCleanupHookEPN2v87IsolateEPFvPvES3_'), Buffer.alloc(4096, 0)]));
    return file;
  };

  it('the runtimes that keep the cleanup-hook list: 26.4.0 and later, and no 24.x release yet', () => {
    const table = ['22.13.0', '22.23.3', '24.18.1', '24.19.0', '24.21.0', '26.3.1', '26.4.0', '26.10.0', '27.0.0'].map((v) => [v, runtimeKeepsAddonHooks(v)]);
    expect(Object.fromEntries(table)).toEqual({
      '22.13.0': false,
      '22.23.3': false,
      '24.18.1': false,
      '24.19.0': false,
      '24.21.0': false,
      '26.3.1': false,
      '26.4.0': true,
      '26.10.0': true,
      '27.0.0': true,
    });
  });

  it('a binary is refused only when it carries the mark and the runtime lacks the list; an unreadable or missing one is not evidence', () => {
    const marked = binaryFile(true);
    const plain = binaryFile(false);
    expect(nativeAbortsOnCollect(marked, '24.21.0')).toBe(true);
    expect(nativeAbortsOnCollect(marked, '26.3.1')).toBe(true);
    expect(nativeAbortsOnCollect(marked, '26.4.0')).toBe(false);
    expect(nativeAbortsOnCollect(plain, '24.21.0')).toBe(false);
    expect(nativeAbortsOnCollect(join(marked, '..', 'missing.node'), '24.21.0')).toBe(false);
    expect(nativeAbortsOnCollect(undefined, '24.21.0')).toBe(false);
  });

  it('the file inspected is the one better-sqlite3 loads', () => {
    const binary = nativeBinaryPath();
    expect(binary).toBeDefined();
    expect(existsSync(binary!)).toBe(true);
    // Loading it here would plant a statement this process could abort on: the binary itself is the evidence then.
    if (nativeAbortsOnCollect(binary)) return;
    const req = createRequire(import.meta.url);
    const Database = req('better-sqlite3') as new (p: string) => { close(): void };
    new Database(':memory:').close();
    expect(Object.keys(req.cache).map((k) => k.toLowerCase())).toContain(binary!.toLowerCase());
  });

  it('by default, Iris does not load a marked binary on a runtime without the list: it warns once and holds the file with the built-in', () => {
    if (!builtIn) return withoutBuiltIn(tempDb());
    const warnings: string[] = [];
    let loaded = false;
    const d = openDriver(tempDb(), {
      nativeBinary: () => binaryFile(true),
      loadNative: () => {
        loaded = true;
        throw new Error('the marked binary was loaded');
      },
      warn: (line) => warnings.push(line),
    });
    drivers.push(d);
    if (runtimeKeepsAddonHooks()) {
      // This Node survives the mark: the binary is loaded as any other (the stub fails to load, and that is what the fallback names).
      expect(loaded).toBe(true);
      expect(d.reason).toMatch(/^better-sqlite3 could not load \(the marked binary was loaded\)/);
      return;
    }
    expect(loaded).toBe(false);
    expect(d.name).toBe('node');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/was compiled against Node headers that make it abort on Node \d+\.\d+\.\d+ when it frees a statement \(nodejs\/node#65446\); using Node's built-in SQLite/);
    expect(warnings[0]).toMatch(/npm rebuild better-sqlite3/);
    expect(warnings[0]).toMatch(/IRIS_SQLITE_DRIVER=node/);
    expect(d.reason).toMatch(/^better-sqlite3 here was compiled against Node headers that abort on Node .* \(nodejs\/node#65446\), so Iris uses Node's built-in SQLite$/);
    d.exec('CREATE TABLE t (a TEXT)');
    expect(d.prepare('INSERT INTO t VALUES (?)').run('x').changes).toBe(1);
  });

  it('with IRIS_SQLITE_DRIVER=native, a marked binary is refused before it loads, naming the Node issue and the fix', () => {
    if (runtimeKeepsAddonHooks()) return expect(nativeAbortsOnCollect(binaryFile(true))).toBe(false);
    expect(() =>
      openDriver(tempDb(), {
        driver: 'native',
        nativeBinary: () => binaryFile(true),
        loadNative: () => {
          throw new Error('the marked binary was loaded');
        },
        warn: () => {
          throw new Error('must not warn');
        },
      }),
    ).toThrow(/abort on Node .* when it frees a statement \(nodejs\/node#65446\)\. IRIS_SQLITE_DRIVER=native forbids the fallback; unset it .* or reinstall the prebuilt binary with npm rebuild better-sqlite3/);
  });

  it('a plain binary is loaded as before', () => {
    let loaded = false;
    expect(() =>
      openDriver(tempDb(), {
        driver: 'native',
        nativeBinary: () => binaryFile(false),
        loadNative: () => {
          loaded = true;
          throw new Error('invalid ELF header');
        },
      }),
    ).toThrow(/could not load \(invalid ELF header\)/);
    expect(loaded).toBe(true);
  });
});

/*
 * One copy of SQLite per file (driver.ts). better-sqlite3's SQLite and
 * node:sqlite on one WAL file in one process cannot see each other's
 * locks; tests/fixtures/worker-exit/two-sqlites.cjs shows the SIGBUS that
 * follows. These hold the seam to one copy per file, and Iris's two worker
 * threads to the copy the store's own connection got.
 */
describe('one copy of SQLite per file', () => {
  const other = (d: Driver): 'native' | 'node' => (d.name === 'node' ? 'native' : 'node');

  it('refuses the other copy on a file this thread holds, before it opens anything, naming both and the way out', () => {
    const path = tempDb();
    const first = openDriver(path);
    drivers.push(first);
    if (!builtIn) return;
    expect(() => openDriver(path, { driver: other(first) })).toThrow(/is already open in this process with .*; opening it with .* as well would put two copies of SQLite on one file, whose locks cannot see each other .*sqlite\.org\/howtocorrupt\.html\)\. Open it with (native|node), or close the other connection first\./);
    expect(sqliteHolding(path)).toBe(first.name);
  });

  it('an unset choice follows the file: a second connection uses the copy that holds it, and never falls back to the other', () => {
    if (!builtIn) return withoutBuiltIn(tempDb());
    const path = tempDb();
    const onNode = openDriver(path, { driver: 'node' });
    drivers.push(onNode);
    const second = openDriver(path, {
      loadNative: () => {
        throw new Error('the native copy was loaded for a file node:sqlite holds');
      },
    });
    drivers.push(second);
    expect(second.name).toBe('node');
    expect(second.reason).toBe("this file is already open in this process on Node's built-in SQLite, so Iris uses it here too");
  });

  it('counts connections: the file is let go when the last one closes, and a relative path, a different case where the file system ignores case, and the absolute path are one file', () => {
    const path = tempDb();
    const a = openDriver(path);
    const b = openDriver(path);
    expect(sqliteHolding(path)).toBe(a.name);
    a.close();
    a.close();
    expect(sqliteHolding(path)).toBe(a.name);
    const rel = relative(process.cwd(), path);
    expect(sqliteHolding(rel)).toBe(a.name);
    if (process.platform === 'win32' || process.platform === 'darwin') expect(sqliteHolding(path.toUpperCase())).toBe(a.name);
    b.close();
    expect(sqliteHolding(path)).toBeUndefined();
    // A second close does nothing on either copy: node:sqlite throws on it where better-sqlite3 does not.
    if (builtIn) {
      const n = openDriver(tempDb(), { driver: 'node' });
      n.close();
      expect(() => n.close()).not.toThrow();
    }
    // Let go, the file opens with the other copy: when both can open here (the job that builds the addon from source refuses native on Node 24).
    if (!builtIn || (other(a) === 'native' && nativeAbortsOnCollect(nativeBinaryPath()))) return;
    const c = openDriver(path, { driver: other(a) });
    drivers.push(c);
    expect(c.name).not.toBe(a.name);
    expect(sqliteHolding(':memory:')).toBeUndefined();
  });

  it("the search worker and the checkpoint worker are handed the copy the store's connection got, on either driver", async () => {
    // Each driver that opens here. Where native is refused (the job that builds the addon from source), the refusal is the check for it.
    const nativeRefused = nativeAbortsOnCollect(nativeBinaryPath());
    if (nativeRefused) expect(() => new SqliteAdapter(tempDb(), { driver: 'native' })).toThrow(/nodejs\/node#65446/);
    for (const driver of [...(nativeRefused ? [] : (['native'] as const)), ...(builtIn ? (['node'] as const) : [])]) {
      const storage = new SqliteAdapter(tempDb(), { driver });
      await storage.initialize();
      try {
        await storage.insertTrace(LOCAL_TENANT, { trace_id: 't1', agent_name: 'a', input: 'q', output: 'the refund was approved', timestamp: '2026-09-01T10:00:00Z' });
        await storage.queryTraces(LOCAL_TENANT, { search: 'refund', limit: 5, offset: 0 });
        const inner = storage as unknown as { searchWorker?: { data: { driver: string } }; checkpointer?: { options: { driver: string } } };
        expect(inner.searchWorker?.data.driver).toBe(storage.driver === 'node' ? 'node' : 'native');
        expect(inner.checkpointer?.options.driver).toBe(storage.driver);
      } finally {
        await storage.close();
      }
    }
  });
});
