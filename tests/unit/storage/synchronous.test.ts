/*
 * storage.synchronous — when a commit reaches the disk (#711).
 *
 * NORMAL by default from 0.20.0: in WAL mode SQLite syncs the log at each
 * checkpoint instead of on every commit. A crash of Iris loses nothing and
 * the file cannot be corrupted; a power cut or an operating-system crash
 * can roll back the writes since the last sync. `full` keeps every commit
 * through both. This file proves the default and the switch on both
 * drivers, through the config file, and that config.json refuses any
 * other value.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { createStorage } from '../../../src/storage/index.js';
import { nodeSqliteAvailable, type Driver } from '../../../src/storage/driver.js';
import { loadConfig } from '../../../src/config/index.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

let scratch: string;
let home: string;
const saved = { home: process.env.IRIS_HOME, db: process.env.IRIS_DB_PATH };
beforeEach(() => {
  scratch = mkdtempSync(join(tmpdir(), 'iris-sync-'));
  home = join(scratch, 'home');
  mkdirSync(home, { recursive: true });
  process.env.IRIS_HOME = home;
  process.env.IRIS_DB_PATH = join(scratch, 'iris.db');
});
afterEach(() => {
  for (const [key, value] of [['IRIS_HOME', saved.home], ['IRIS_DB_PATH', saved.db]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(scratch, { recursive: true, force: true });
});

/** PRAGMA synchronous answers 1 for NORMAL and 2 for FULL. */
const pragma = (store: SqliteAdapter, name: string): unknown => ((store as unknown as { db: Driver }).db.prepare(`PRAGMA ${name}`).get() as Record<string, unknown>)[name];
const level = (store: SqliteAdapter): number => Number(pragma(store, 'synchronous'));

const DRIVERS: Array<'native' | 'node'> = ['native', ...(nodeSqliteAvailable() ? (['node'] as const) : [])];

describe.each(DRIVERS)('storage.synchronous on %s', (driver) => {
  it('is NORMAL by default and FULL when chosen, and the store works either way', async () => {
    for (const [option, expected] of [[undefined, 1], ['normal', 1], ['full', 2]] as const) {
      const store = new SqliteAdapter(join(scratch, `${option ?? 'default'}-${driver}.db`), { driver, ...(option ? { synchronous: option } : {}) });
      await store.initialize();
      try {
        expect(level(store), String(option)).toBe(expected);
        expect(pragma(store, 'journal_mode')).toBe('wal');
        await store.insertTrace(LOCAL_TENANT, { trace_id: 't1', agent_name: 'a', output: 'An answer.', timestamp: '2026-09-01T00:00:00.000Z' });
        expect((await store.getTrace(LOCAL_TENANT, 't1'))?.trace_id).toBe('t1');
      } finally {
        await store.close();
      }
    }
  });
});

describe('what a store ran before the setting existed', () => {
  it("better-sqlite3's SQLite opens a file that is already WAL at NORMAL: 0.19.0's native stores ran NORMAL on every start but the first", async () => {
    const { default: Database } = await import('better-sqlite3');
    const path = join(scratch, 'plain.db');
    const first = new Database(path);
    first.pragma('journal_mode = WAL');
    expect(first.pragma('synchronous', { simple: true })).toBe(2);
    expect((first.pragma('compile_options') as Array<{ compile_options: string }>).map((r) => r.compile_options)).toContain('DEFAULT_WAL_SYNCHRONOUS=1');
    first.close();
    const again = new Database(path);
    expect(again.pragma('synchronous', { simple: true })).toBe(1);
    again.close();
  });
});

describe('storage.synchronous in config.json', () => {
  it('defaults to normal, and the file chooses full', async () => {
    expect(defaultConfig.storage.synchronous).toBe('normal');
    const byDefault = createStorage(loadConfig()) as SqliteAdapter;
    await byDefault.initialize();
    expect(level(byDefault)).toBe(1);
    await byDefault.close();

    writeFileSync(join(home, 'config.json'), JSON.stringify({ storage: { synchronous: 'full' } }));
    const config = loadConfig();
    expect(config.storage.synchronous).toBe('full');
    // IRIS_DB_PATH replaced the path; the file's other storage keys still apply.
    expect(config.storage.path).toBe(join(scratch, 'iris.db'));
    const full = createStorage(config) as SqliteAdapter;
    await full.initialize();
    expect(level(full)).toBe(2);
    await full.close();
  });

  it('refuses any other value, naming the two', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({ storage: { synchronous: 'off' } }));
    expect(() => loadConfig()).toThrow(/storage\.synchronous.*("normal".*"full"|normal.*full)/s);
  });
});
