/*
 * The WAL switch on a cold file retries on SQLITE_BUSY (0.16.0, found by
 * a CI run).
 *
 * `PRAGMA journal_mode = WAL` upgrades the connection's SHARED lock to
 * EXCLUSIVE, and SQLite does not run the busy handler on that upgrade —
 * two connections each holding SHARED and each waiting for the other
 * would never return — so it answers SQLITE_BUSY at once. Two processes
 * opening one cold file at the same instant therefore lost one of them on
 * this statement whatever busy_timeout said; the 0.14.0 fix moved the
 * timeout before the switch, which covers a plain wait, not this upgrade.
 * The adapter now waits itself: retry with a short backoff, inside the
 * same budget, until the other process is through. The process race is
 * kept as the integration guard (cli-ingest); this suite makes the busy
 * answer deterministic on each driver's own error shape.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteAdapter, BUSY_TIMEOUT_MS } from '../../../src/storage/sqlite-adapter.js';
import { isBusyError, type Driver } from '../../../src/storage/driver.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'iris-wal-switch-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** better-sqlite3's shape. */
const nativeBusy = () => Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
/** node:sqlite's shape. */
const builtinBusy = () => Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5, errstr: 'database is locked' });

const driverOf = (storage: SqliteAdapter) => (storage as unknown as { db: Driver }).db;

/** The journal mode the driver reports — the native driver answers a row array, the built-in a row. */
const journalModeOf = (storage: SqliteAdapter) => ([] as unknown[]).concat(driverOf(storage).pragma('journal_mode'))[0];

/** The driver under the adapter, with its WAL pragma made to fail `times` times the way `shape` fails. */
function failWalSwitch(storage: SqliteAdapter, times: number, shape: () => Error): { attempts: () => number } {
  const db = driverOf(storage);
  const real = db.pragma.bind(db);
  let attempts = 0;
  db.pragma = (text: string) => {
    if (text.startsWith('journal_mode')) {
      attempts += 1;
      if (attempts <= times) throw shape();
    }
    return real(text);
  };
  return { attempts: () => attempts };
}

describe('the WAL switch on a cold file', () => {
  it('retries on SQLITE_BUSY in either driver\'s shape and comes up in WAL once the other process is through', async () => {
    for (const shape of [nativeBusy, builtinBusy]) {
      const storage = new SqliteAdapter(join(dir, `${shape.name}.db`));
      const { attempts } = failWalSwitch(storage, 3, shape);
      try {
        await storage.initialize();
        expect(attempts(), shape.name).toBe(4);
        expect(journalModeOf(storage)).toEqual({ journal_mode: 'wal' });
      } finally {
        await storage.close();
      }
    }
  });

  it('gives up with the driver\'s own error once the busy budget is spent, and closes the handle', async () => {
    vi.useFakeTimers();
    const storage = new SqliteAdapter(join(dir, 'forever.db'));
    const { attempts } = failWalSwitch(storage, Number.POSITIVE_INFINITY, builtinBusy);
    const outcome = storage.initialize().then(
      () => 'resolved',
      (e: unknown) => e,
    );
    await vi.advanceTimersByTimeAsync(BUSY_TIMEOUT_MS + 1000);
    const err = await outcome;
    expect(err).toMatchObject({ code: 'ERR_SQLITE_ERROR', errcode: 5 });
    expect(attempts()).toBeGreaterThan(5);
    // The handle was closed by the failed boot: a statement on it is refused.
    expect(() => driverOf(storage).prepare('SELECT 1')).toThrow();
  });

  it('never retries an error that is not BUSY', async () => {
    const storage = new SqliteAdapter(join(dir, 'io.db'));
    const { attempts } = failWalSwitch(storage, Number.POSITIVE_INFINITY, () => new Error('disk I/O error'));
    await expect(storage.initialize()).rejects.toThrow('disk I/O error');
    expect(attempts()).toBe(1);
  });

  it('recognises both drivers\' busy shapes and nothing else', () => {
    expect(isBusyError(nativeBusy())).toBe(true);
    expect(isBusyError(builtinBusy())).toBe(true);
    expect(isBusyError(Object.assign(new Error('database table is locked'), { code: 'SQLITE_LOCKED', errcode: 6 }))).toBe(false);
    expect(isBusyError(new Error('disk I/O error'))).toBe(false);
    expect(isBusyError(null)).toBe(false);
    expect(isBusyError('database is locked')).toBe(false);
  });
});
