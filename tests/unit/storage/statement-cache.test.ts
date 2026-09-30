/*
 * The prepared-statement cache (#711).
 *
 * Until 0.20.0 every call compiled its SQL again, and once the search
 * index existed that was most of a write: compiling the insert into spans
 * compiles six triggers. Each driver now keeps what it prepares. This file
 * proves the cache on both drivers: one compile per SQL text, a bounded
 * least-recently-used list, statements that stay right when the schema
 * changes under them (in this connection or another), a retry when SQLite
 * gives up with SQLITE_SCHEMA, and the adapter's write path compiling
 * nothing the second time.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { openDriver, nodeSqliteAvailable, statementCache, isSchemaError, STATEMENT_CACHE_SIZE, type Driver, type Statement } from '../../../src/storage/driver.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const open: Driver[] = [];
afterEach(() => {
  for (const d of open.splice(0)) d.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});
const tempDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-stmt-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
};

const DRIVERS: Array<'native' | 'node'> = ['native', ...(nodeSqliteAvailable() ? (['node'] as const) : [])];
const require = createRequire(import.meta.url);

/** Every SQL text the driver's SQLite compiles while this runs, counted where each module compiles it. */
function countCompiles(driver: 'native' | 'node'): { compiled: string[]; restore: () => void } {
  const proto = (driver === 'native' ? (require('better-sqlite3') as { prototype: object }) : (require('node:sqlite') as { DatabaseSync: { prototype: object } }).DatabaseSync).prototype as { prepare: (sql: string, ...rest: unknown[]) => unknown };
  const original = proto.prepare;
  const compiled: string[] = [];
  proto.prepare = function (this: unknown, sql: string, ...rest: unknown[]) {
    compiled.push(sql);
    return original.call(this, sql, ...rest);
  };
  return { compiled, restore: () => (proto.prepare = original) };
}

describe('statementCache', () => {
  const fake = () => {
    const compiled: string[] = [];
    const cache = statementCache((sql) => {
      compiled.push(sql);
      return { run: () => ({ changes: 0 }), get: () => sql, all: () => [sql] };
    }, 3);
    return { compiled, cache };
  };

  it('compiles each SQL text once and hands back the same statement', () => {
    const { compiled, cache } = fake();
    const a = cache.prepare('SELECT 1');
    expect(cache.prepare('SELECT 1')).toBe(a);
    cache.prepare('SELECT 2');
    expect(compiled).toEqual(['SELECT 1', 'SELECT 2']);
  });

  it('is bounded, and the least recently used statement is the one that goes', () => {
    const { compiled, cache } = fake();
    cache.prepare('A');
    cache.prepare('B');
    cache.prepare('C');
    cache.prepare('A'); // A is now the most recent; B is the oldest.
    cache.prepare('D');
    expect(cache.size).toBe(3);
    cache.prepare('A');
    cache.prepare('C');
    cache.prepare('D');
    expect(compiled).toEqual(['A', 'B', 'C', 'D']);
    cache.prepare('B');
    expect(compiled).toEqual(['A', 'B', 'C', 'D', 'B']);
    expect(cache.size).toBe(3);
  });

  it('the default bound is large enough for the working set and small enough to matter', () => {
    expect(STATEMENT_CACHE_SIZE).toBe(256);
  });

  it('SQLITE_SCHEMA from either driver prepares the statement again and retries once; a second failure, or any other error, is thrown as it came', () => {
    expect(isSchemaError({ code: 'SQLITE_SCHEMA' })).toBe(true);
    expect(isSchemaError({ code: 'ERR_SQLITE_ERROR', errcode: 17 })).toBe(true);
    expect(isSchemaError({ code: 'SQLITE_BUSY' })).toBe(false);
    expect(isSchemaError({ errcode: 5 })).toBe(false);
    expect(isSchemaError(null)).toBe(false);

    let compiles = 0;
    let failures = 1;
    const cache = statementCache((): Statement => {
      compiles += 1;
      const generation = compiles;
      return {
        run: () => ({ changes: generation }),
        get: () => {
          if (failures > 0) {
            failures -= 1;
            throw Object.assign(new Error('database schema has changed'), { code: 'SQLITE_SCHEMA' });
          }
          return generation;
        },
        all: () => {
          throw Object.assign(new Error('database schema has changed'), { errcode: 17 });
        },
      };
    });
    const st = cache.prepare('SELECT x');
    expect(st.get()).toBe(2);
    expect(compiles).toBe(2);
    // The kept statement is the re-prepared one.
    expect(st.run().changes).toBe(2);
    // all() fails on every compile: one retry, then the error.
    expect(() => st.all()).toThrow('database schema has changed');
    expect(compiles).toBe(3);

    const busy = statementCache(() => ({
      run: () => {
        throw Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
      },
      get: () => undefined,
      all: () => [],
    }));
    let tried = 0;
    const b = busy.prepare('INSERT');
    expect(() => {
      tried += 1;
      b.run();
    }).toThrow('database is locked');
    expect(tried).toBe(1);
  });
});

describe.each(DRIVERS)('the %s driver keeps its statements', (driver) => {
  const openHere = (path = tempDb()) => {
    const d = openDriver(path, { driver });
    open.push(d);
    return d;
  };

  it('the same SQL is the same statement; different SQL is not', () => {
    const d = openHere();
    d.exec('CREATE TABLE t (a INTEGER)');
    const insert = d.prepare('INSERT INTO t VALUES (?)');
    expect(d.prepare('INSERT INTO t VALUES (?)')).toBe(insert);
    expect(d.prepare('SELECT a FROM t')).not.toBe(insert);
    insert.run(1);
    insert.run(2);
    expect(d.prepare('SELECT a FROM t ORDER BY a').all()).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('a kept statement sees the schema as it is now: a column added, the table rebuilt, an index created', () => {
    const d = openHere();
    d.exec('CREATE TABLE t (a INTEGER)');
    const read = d.prepare('SELECT * FROM t ORDER BY a');
    d.prepare('INSERT INTO t (a) VALUES (?)').run(1);
    expect(read.all()).toEqual([{ a: 1 }]);
    d.exec('ALTER TABLE t ADD COLUMN b TEXT');
    d.prepare('INSERT INTO t (a, b) VALUES (?, ?)').run(2, 'x');
    expect(read.all()).toEqual([
      { a: 1, b: null },
      { a: 2, b: 'x' },
    ]);
    d.exec('DROP TABLE t; CREATE TABLE t (a INTEGER, c REAL); INSERT INTO t VALUES (3, 0.5)');
    expect(read.all()).toEqual([{ a: 3, c: 0.5 }]);
    d.exec('CREATE INDEX t_a ON t(a)');
    expect(read.all()).toEqual([{ a: 3, c: 0.5 }]);
  });

  it('a table dropped under a kept statement fails as a fresh prepare would, and works again once it is back', () => {
    const d = openHere();
    d.exec('CREATE TABLE t (a INTEGER)');
    const read = d.prepare('SELECT a FROM t');
    expect(read.all()).toEqual([]);
    d.exec('DROP TABLE t');
    expect(() => read.all()).toThrow(/no such table: t/);
    expect(() => d.prepare('SELECT a FROM t').all()).toThrow(/no such table: t/);
    d.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (7)');
    expect(read.all()).toEqual([{ a: 7 }]);
  });

  it('another connection changing the schema — another process upgrading the file — is picked up', () => {
    const path = tempDb();
    const d = openHere(path);
    d.pragma('journal_mode = WAL');
    d.exec('CREATE TABLE t (a INTEGER); INSERT INTO t VALUES (1)');
    const read = d.prepare('SELECT * FROM t');
    expect(read.all()).toEqual([{ a: 1 }]);
    const other = openHere(path);
    other.exec("ALTER TABLE t ADD COLUMN b TEXT DEFAULT 'y'; CREATE INDEX t_b ON t(b)");
    expect(read.all()).toEqual([{ a: 1, b: 'y' }]);
  });

  it('two connections in one process never share a statement: each reads its own file', () => {
    const one = openHere();
    const two = openHere();
    one.exec('CREATE TABLE t (a TEXT); INSERT INTO t VALUES (\'one\')');
    two.exec('CREATE TABLE t (a TEXT); INSERT INTO t VALUES (\'two\')');
    const a = one.prepare('SELECT a FROM t');
    const b = two.prepare('SELECT a FROM t');
    expect(a).not.toBe(b);
    expect(a.all()).toEqual([{ a: 'one' }]);
    expect(b.all()).toEqual([{ a: 'two' }]);
    expect(one.prepare('SELECT a FROM t').get()).toEqual({ a: 'one' });
  });

  it('after close, prepare throws the driver module\'s own closed-connection error, never a kept statement', () => {
    // What the module itself says when asked to prepare on a closed connection.
    const expected = (() => {
      const raw = driver === 'native' ? new (require('better-sqlite3') as new (p: string) => { prepare(s: string): unknown; close(): void })(':memory:') : new (require('node:sqlite') as { DatabaseSync: new (p: string) => { prepare(s: string): unknown; close(): void } }).DatabaseSync(':memory:');
      raw.close();
      try {
        raw.prepare('SELECT 1');
      } catch (err) {
        return (err as Error).message;
      }
      throw new Error('the module prepared on a closed connection');
    })();
    const d = openDriver(tempDb(), { driver });
    d.exec('CREATE TABLE t (a INTEGER)');
    const read = d.prepare('SELECT a FROM t');
    expect(read.all()).toEqual([]);
    d.close();
    expect(() => d.prepare('SELECT a FROM t')).toThrow(expected);
    expect(() => d.prepare('SELECT a FROM t')).toThrow(expected);
    // A statement taken before the close fails too; it is never handed out again.
    expect(() => read.all()).toThrow();
  });

  it('a store used after close rejects with the same closed-connection error', async () => {
    const store = new SqliteAdapter(tempDb(), { driver });
    await store.initialize();
    await store.insertTrace(LOCAL_TENANT, { trace_id: 't1', agent_name: 'a', output: 'An answer.', timestamp: '2026-09-01T00:00:00.000Z' });
    expect((await store.getTrace(LOCAL_TENANT, 't1'))?.trace_id).toBe('t1');
    await store.close();
    await expect(store.getTrace(LOCAL_TENANT, 't1')).rejects.toThrow(driver === 'native' ? /database connection is not open/ : /database is not open/);
    await expect(store.getAgentFailureLog(LOCAL_TENANT, 'a')).rejects.toThrow(driver === 'native' ? /database connection is not open/ : /database is not open/);
  });
});

describe.each(DRIVERS)('the adapter on %s compiles its write path once', (driver) => {
  it('the second and third trace compile nothing, and a batch without spans never compiles the spans insert', async () => {
    const store = new SqliteAdapter(tempDb(), { driver });
    await store.initialize();
    const trace = (id: string) => ({ trace_id: id, agent_name: 'a', input: 'q', output: 'The answer, in full.', timestamp: '2026-09-01T10:00:00.000Z' });
    const counting = countCompiles(driver);
    try {
      await store.insertTrace(LOCAL_TENANT, trace('t1'));
      const first = counting.compiled.length;
      expect(first).toBeGreaterThan(0);
      expect(counting.compiled.some((sql) => /INSERT INTO spans/.test(sql))).toBe(false);
      await store.insertTrace(LOCAL_TENANT, trace('t2'));
      await store.insertTrace(LOCAL_TENANT, trace('t3'));
      expect(counting.compiled.slice(first)).toEqual([]);
      // A trace with spans compiles the spans insert once, and then not again.
      await store.insertTrace(LOCAL_TENANT, { ...trace('t4'), spans: [{ span_id: 's4', trace_id: 't4', name: 'call', kind: 'LLM', status_code: 'OK', start_time: '2026-09-01T10:00:00.000Z' }] });
      expect(counting.compiled.filter((sql) => /INSERT INTO spans/.test(sql))).toHaveLength(1);
      const withSpans = counting.compiled.length;
      await store.insertTrace(LOCAL_TENANT, { ...trace('t5'), spans: [{ span_id: 's5', trace_id: 't5', name: 'call', kind: 'LLM', status_code: 'OK', start_time: '2026-09-01T10:00:00.000Z' }] });
      expect(counting.compiled.slice(withSpans)).toEqual([]);
    } finally {
      counting.restore();
    }
    expect((await store.queryTraces(LOCAL_TENANT, { limit: 10 })).total).toBe(5);
    await store.close();
  });
});
