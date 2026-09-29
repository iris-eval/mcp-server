/*
 * storage.searchIndex: "off" (#729).
 *
 * A store may keep no full-text index: a write then stores the trace and
 * nothing else, and a search reads the traces (the scan, search-match.ts)
 * and says so (`search.index: "scan"`). What this file proves, on both
 * drivers:
 *
 *   - off on a new file: no index, no triggers, nothing queued; a search
 *     finds what the index would have, and health reports `off`;
 *   - on, then off: the index the file kept is erased after the start, and
 *     a trace deleted while it is off leaves no word in the file;
 *   - off, then on: the next start builds a new index from every trace,
 *     and a search reads it again;
 *   - the setting: config.json's storage.searchIndex, IRIS_SEARCH_INDEX over
 *     it, and anything else refused at startup, naming it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createStorage } from '../../../src/storage/index.js';
import { loadConfig } from '../../../src/config/index.js';
import { buildHealth } from '../../../src/health.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import { nodeSqliteAvailable, type Driver } from '../../../src/storage/driver.js';
import type { Trace } from '../../../src/types/trace.js';
import { driverHasFts5 } from './fts5-here.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
const open: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of open.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
const tempDb = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'iris-index-off-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
};

const DRIVERS = (['native', ...(nodeSqliteAvailable() ? ['node'] : [])] as Array<'native' | 'node'>).filter((d) => driverHasFts5(d));
const at = (minute: number) => new Date(Date.UTC(2026, 8, 20, 12, minute)).toISOString();
const trace = (trace_id: string, output: string, minute = 0): Trace => ({ trace_id, agent_name: 'bot', output, timestamp: at(minute) });
const CORPUS = [
  trace('a', 'The refund was approved on Monday.', 1),
  trace('b', 'refund refund refund, billing escalated', 2),
  trace('c', 'Shipping delayed by the carrier.', 3),
  trace('d', 'A partial refund for the damaged item.', 4),
];

const rawDb = (s: SqliteAdapter) => (s as unknown as { db: Driver }).db;
/** The search index's tables, triggers and covering index in the file, by name. */
const searchObjects = (s: SqliteAdapter): string[] =>
  (rawDb(s).prepare("SELECT name FROM sqlite_master WHERE name LIKE 'trace_search%' OR name = 'idx_traces_search_filter' ORDER BY name").all() as Array<{ name: string }>).map((r) => r.name);
const holds = (file: string, needle: string) => [file, `${file}-wal`].some((f) => existsSync(f) && readFileSync(f).includes(Buffer.from(needle, 'utf8')));
const found = async (s: SqliteAdapter, search: string) => {
  const r = await s.queryTraces(LOCAL_TENANT, { search, sort_by: 'timestamp', sort_order: 'asc', limit: 100 });
  return { ids: r.traces.map((t) => t.trace_id), index: r.search?.index, complete: r.search?.complete };
};

describe.each(DRIVERS)('storage.searchIndex off on %s', (driver) => {
  const store = async (path: string, searchIndex: 'on' | 'off'): Promise<SqliteAdapter> => {
    const s = new SqliteAdapter(path, { driver, searchWorker: false, searchIndex });
    await s.initialize();
    open.push(s);
    await s.whenIdle();
    return s;
  };
  const closeStore = async (s: SqliteAdapter) => {
    open.splice(open.indexOf(s), 1);
    await s.close();
  };

  it('on a new file: no index is kept, a search reads the traces and finds the same, and health says off', async () => {
    const off = await store(tempDb(), 'off');
    const on = await store(tempDb(), 'on');
    for (const s of [off, on]) await s.insertTraces(LOCAL_TENANT, CORPUS);
    await on.whenSearchIndexReady();

    expect(searchObjects(off)).toEqual([]);
    expect(rawDb(off).prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%trace_search%'").all()).toEqual([]);
    for (const q of ['refund', 'refund approved', '"partial refund"', 'ship*', 'nothing']) {
      const [a, b] = [await found(off, q), await found(on, q)];
      expect(a.ids, q).toEqual(b.ids);
      expect(a.index, q).toBe('scan');
      expect(b.index, q).toBe('fts5');
      expect(a.complete, q).toBe(true);
    }
    expect(await off.searchStatus()).toMatchObject({ state: 'off', index: 'scan', retired: false });
    const { body } = await buildHealth({ storage: off } as unknown as Parameters<typeof buildHealth>[0]);
    expect(body.search).toEqual({ state: 'off', index: 'scan', progress: null });
  });

  it('on, then off: the kept index is erased after the start, and a trace deleted while off leaves no word in the file', async () => {
    const path = tempDb();
    const on = await store(path, 'on');
    await on.insertTraces(LOCAL_TENANT, [...CORPUS, trace('z', 'the zebrafinch escalation', 5)]);
    await on.whenSearchIndexReady();
    expect(searchObjects(on)).toContain('trace_search');
    await closeStore(on);

    const off = await store(path, 'off');
    expect(searchObjects(off)).toEqual([]);
    expect(await off.searchStatus()).toMatchObject({ state: 'off', retired: false });
    expect((await found(off, 'zebrafinch')).ids).toEqual(['z']);
    expect(await off.deleteTrace(LOCAL_TENANT, 'z')).toBe(true);
    expect((await found(off, 'zebrafinch')).ids).toEqual([]);
    await closeStore(off);
    expect(holds(path, 'zebrafinch')).toBe(false);
  });

  it('off, then on: the next start builds a new index from every trace, and a search reads it', async () => {
    const path = tempDb();
    const off = await store(path, 'off');
    await off.insertTraces(LOCAL_TENANT, CORPUS);
    await closeStore(off);

    const on = await store(path, 'on');
    expect(await on.whenSearchIndexReady()).toBe('ready');
    expect(await found(on, 'refund')).toEqual({ ids: ['a', 'b', 'd'], index: 'fts5', complete: true });
    const db = rawDb(on);
    db.exec("INSERT INTO trace_search (trace_search, rank) VALUES ('integrity-check', 0)");
    expect(Number((db.prepare('SELECT COUNT(*) AS n FROM trace_search_docs').get() as { n: number }).n)).toBe(CORPUS.length);
  });
});

describe('the storage.searchIndex setting', () => {
  const VARS = ['IRIS_HOME', 'IRIS_DB_PATH', 'IRIS_SEARCH_INDEX'] as const;
  const saved: Record<string, string | undefined> = {};
  let home: string;
  beforeEach(() => {
    for (const v of VARS) saved[v] = process.env[v];
    const scratch = mkdtempSync(join(tmpdir(), 'iris-config-search-index-'));
    dirs.push(scratch);
    home = join(scratch, 'home');
    mkdirSync(home, { recursive: true });
    process.env.IRIS_HOME = home;
    delete process.env.IRIS_DB_PATH;
    delete process.env.IRIS_SEARCH_INDEX;
  });
  afterEach(() => {
    for (const v of VARS) {
      if (saved[v] === undefined) delete process.env[v];
      else process.env[v] = saved[v];
    }
  });
  const writeConfig = (value: unknown) => writeFileSync(join(home, 'config.json'), JSON.stringify(value));

  it('is unset by default, reads config.json, and the environment over it', () => {
    expect(loadConfig().storage.searchIndex).toBeUndefined();
    writeConfig({ storage: { searchIndex: 'off' } });
    expect(loadConfig().storage.searchIndex).toBe('off');
    process.env.IRIS_SEARCH_INDEX = ' ON ';
    expect(loadConfig().storage.searchIndex).toBe('on');
  });

  it('refuses anything but on or off, naming it', () => {
    for (const bad of ['false', '0', 'disabled']) {
      process.env.IRIS_SEARCH_INDEX = bad;
      expect(() => loadConfig(), bad).toThrow(`IRIS_SEARCH_INDEX=${JSON.stringify(bad)} is not valid (use on or off)`);
    }
    delete process.env.IRIS_SEARCH_INDEX;
    for (const bad of [false, 'no', 1]) {
      writeConfig({ storage: { searchIndex: bad } });
      expect(() => loadConfig(), String(bad)).toThrow(/storage\.searchIndex/);
    }
  });

  it('reaches the store', async () => {
    process.env.IRIS_SEARCH_INDEX = 'off';
    const storage = createStorage(loadConfig());
    await storage.initialize();
    try {
      await storage.insertTraces(LOCAL_TENANT, [trace('t1', 'refund approved', 1)]);
      const r = await storage.queryTraces(LOCAL_TENANT, { search: 'refund' });
      expect(r.search?.index).toBe('scan');
      expect(r.traces.map((t) => t.trace_id)).toEqual(['t1']);
      expect((await (storage as SqliteAdapter).searchStatus()).state).toBe('off');
    } finally {
      await storage.close();
    }
  });
});
