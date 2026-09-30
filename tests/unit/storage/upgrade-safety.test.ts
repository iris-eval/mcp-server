/*
 * Upgrading a database safely (#704): the copy taken before a migration,
 * the compatibility floor that decides which releases can open the file,
 * and what a start that migrated a file reports.
 *
 * "A file an older release left" is made the way one looks: a file this
 * build wrote, with migration 015's ledger row taken out and every row
 * stamped as 0.19.0 wrote it. The real 0.19.0 package is driven against a
 * real file in tests/upgrade/.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter, upgradeLine } from '../../../src/storage/sqlite-adapter.js';
import { BACKUPS_KEPT, backupDatabase, backupPath, listBackups, pruneBackups } from '../../../src/storage/backup.js';
import { COMPAT_FLOORS, DOWNGRADING_URL, IncompatibleDatabaseError, KNOWN_MIGRATION_IDS, inspectMigrations } from '../../../src/storage/migrations/index.js';
import { openDriver } from '../../../src/storage/driver.js';
import { runRetentionSweep } from '../../../src/retention.js';
import { clearDemoData, demoDbPath } from '../../../src/dashboard/seed-demo-data.js';
import { defaultConfig, PKG_VERSION } from '../../../src/config/defaults.js';
import { isVersion } from '../../../src/utils/versions.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { IrisConfig } from '../../../src/types/index.js';

const FIXTURE_019 = resolve(import.meta.dirname, '../../fixtures/db/iris-0.19.0.db');
/** The migrations after the ones 0.19.0 knows. */
const AFTER_019 = KNOWN_MIGRATION_IDS.slice(14);

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  vi.restoreAllMocks();
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-upgrade-safety-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

const trace = (id: string, output: string) => ({ trace_id: id, agent_name: 'a', input: 'q', output, latency_ms: 1, timestamp: new Date().toISOString() });

/** A file the released 0.19.0 wrote (tests/fixtures/db): fourteen migrations stamped 0.19.0, and one more trace. */
async function fileFrom019(path = tempDb()): Promise<string> {
  copyFileSync(FIXTURE_019, path);
  const db = new Database(path);
  db.prepare("INSERT INTO traces (tenant_id, trace_id, agent_name, output, timestamp) VALUES ('local', 't-1', 'a', 'walrus tusks', ?)").run(new Date().toISOString());
  db.close();
  return path;
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Quiet the adapter's stderr line and return what it wrote. */
function captureStderr(): () => string {
  let out = '';
  vi.spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  return () => out;
}

describe('the copy taken before a migration', () => {
  it('is taken before the first pending migration, holds the file as it was, and is reported on stderr', async () => {
    const path = await fileFrom019();
    const stderr = captureStderr();
    const s = new SqliteAdapter(path);
    await s.initialize();
    const report = s.upgradeReport();
    await s.close();

    expect(report).toMatchObject({ dbPath: path, from: '0.19.0', to: PKG_VERSION, applied: AFTER_019, floorBefore: '0.16.0', floorAfter: '0.20.0' });
    expect(report!.backup.taken).toBe(true);
    const copy = (report!.backup as { path: string }).path;
    expect(copy.startsWith(`${path}.0.19.0-to-${PKG_VERSION}.`)).toBe(true);
    expect(copy).toMatch(/\.\d{8}T\d{6}Z\.bak$/);
    expect(listBackups(path).map((b) => b.path)).toEqual([copy]);
    if (process.platform !== 'win32') expect(statSync(copy).mode & 0o777).toBe(0o600);

    const db = new Database(copy, { readonly: true });
    expect((db.prepare('SELECT COUNT(*) AS n FROM _iris_migrations').get() as { n: number }).n).toBe(14);
    expect((db.prepare("SELECT output FROM traces WHERE trace_id = 't-1'").get() as { output: string }).output).toBe('walrus tusks');
    expect(db.prepare("SELECT 1 FROM _iris_migrations WHERE id = '015-trace-search'").get()).toBeUndefined();
    db.close();

    // One line from the adapter; on node:sqlite, Node's own experimental warning shares the stream.
    expect(stderr().split('\n').filter((l) => l.startsWith('[iris.storage]'))).toEqual([upgradeLine(report!)]);
    expect(stderr()).toContain(`[iris.storage] Upgraded ${path} for Iris ${PKG_VERSION} (${AFTER_019.join(', ')}). Iris releases before 0.20.0 cannot open it now. The file as it was is at ${copy}; to go back, see ${DOWNGRADING_URL}.`);
  });

  it('is not taken for a new file, or for a file with nothing pending, and nothing is reported', async () => {
    const path = tempDb();
    const stderr = captureStderr();
    for (let i = 0; i < 2; i++) {
      const s = new SqliteAdapter(path);
      await s.initialize();
      expect(s.upgradeReport()).toBeUndefined();
      await s.close();
    }
    expect(listBackups(path)).toEqual([]);
    expect(stderr()).not.toContain('Upgraded');
  });

  it('turned off, the migration still runs and the line says there is no copy', async () => {
    const path = await fileFrom019();
    const stderr = captureStderr();
    const s = new SqliteAdapter(path, { backup: false });
    await s.initialize();
    await s.close();
    expect(listBackups(path)).toEqual([]);
    expect(stderr()).toContain('No copy was taken first: copies are turned off for this store. To keep one, stop every Iris process and copy the file before the next upgrade.');
  });

  it('is skipped, with the numbers, when the disk has no room for it', () => {
    const path = tempDb();
    const db = openDriver(path);
    db.exec('CREATE TABLE t (x TEXT)');
    const result = backupDatabase(db, path, { from: '0.19.0', to: '0.20.0', freeBytes: () => 1024 });
    db.close();
    expect(result.taken).toBe(false);
    expect((result as { reason: string }).reason).toMatch(/^the disk has 0\.0 MB free and the copy needs about \d+\.\d MB plus 64\.0 MB to spare$/);
    expect(listBackups(path)).toEqual([]);
  });

  it(`keeps the newest ${BACKUPS_KEPT}, and two copies in one second get two names`, () => {
    const path = tempDb();
    const db = openDriver(path);
    db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('a')");
    const at = (day: number) => new Date(Date.UTC(2026, 8, day, 10, 0, 0));
    for (const day of [1, 2, 3, 4, 5]) expect(backupDatabase(db, path, { from: '0.19.0', to: '0.20.0', now: at(day) }).taken).toBe(true);
    const same = backupDatabase(db, path, { from: '0.19.0', to: '0.20.0', now: at(5) });
    db.close();
    expect((same as { path: string }).path).toBe(backupPath(path, '0.19.0', '0.20.0', at(5), 1));
    const kept = listBackups(path);
    expect(kept).toHaveLength(BACKUPS_KEPT);
    expect(kept.map((b) => b.takenAt.getUTCDate())).toEqual([5, 5, 4]);
    expect(existsSync(backupPath(path, '0.19.0', '0.20.0', at(1)))).toBe(false);
  });

  it('is taken the same way on Node’s built-in SQLite, and read back read-only', () => {
    const path = tempDb();
    const db = openDriver(path, { driver: 'node' });
    db.exec("CREATE TABLE t (x TEXT); INSERT INTO t VALUES ('on node:sqlite')");
    const result = backupDatabase(db, path, { from: '0.19.0', to: '0.20.0' });
    db.close();
    expect(result.taken).toBe(true);
    const copy = openDriver((result as { path: string }).path, { driver: 'node', readOnly: true, fileMustExist: true });
    expect(copy.prepare('SELECT x FROM t').get()).toEqual({ x: 'on node:sqlite' });
    expect(() => copy.exec("INSERT INTO t VALUES ('no')")).toThrow(/readonly/i);
    copy.close();
  });

  it('only files named the way copies are named are listed or pruned', () => {
    const path = tempDb();
    const theirs = [`${path}.bak`, `${path}.notes.bak`, `${path}-wal`, `${path}.0.19.0-to-0.20.0.bak`];
    for (const f of theirs) writeFileSync(f, 'x');
    expect(listBackups(path)).toEqual([]);
    expect(pruneBackups(path, { keep: 0 })).toEqual([]);
    for (const f of theirs) expect(existsSync(f)).toBe(true);
  });

  it('the retention sweep deletes a copy older than the window, even the only one; --demo-clear deletes the demo database’s', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-upgrade-retention-'));
    dirs.push(dir);
    const path = join(dir, 'iris.db');
    const old = backupPath(path, '0.19.0', '0.20.0', new Date(Date.now() - 40 * 86_400_000));
    const recent = backupPath(path, '0.19.0', '0.20.0', new Date(Date.now() - 2 * 86_400_000));
    writeFileSync(old, 'x');
    writeFileSync(recent, 'x');
    const config = { ...defaultConfig, storage: { ...defaultConfig.storage, path } } as IrisConfig;
    const storage = { deleteTracesOlderThan: async () => 0, deleteEvalResultsOlderThan: async () => 0, checkpoint: async () => undefined } as never;
    const out = await runRetentionSweep(storage, config, { info: () => undefined, warn: () => undefined });
    expect(out?.deletedBackups).toBe(1);
    expect(existsSync(old)).toBe(false);
    expect(existsSync(recent)).toBe(true);

    const demoCopy = backupPath(demoDbPath(), '0.19.0', '0.20.0', new Date());
    writeFileSync(demoCopy, 'x');
    expect(clearDemoData().removed).toContain(demoCopy);
    expect(existsSync(demoCopy)).toBe(false);
  });
});

describe('the compatibility floor', () => {
  it('every migration names a floor no later than the release that introduced it; 015 is 0.20.0', () => {
    expect([...COMPAT_FLOORS.keys()]).toEqual(KNOWN_MIGRATION_IDS);
    for (const floor of COMPAT_FLOORS.values()) expect(isVersion(floor)).toBe(true);
    expect(COMPAT_FLOORS.get('015-trace-search')).toBe('0.20.0');
  });

  it('is recorded with each migration, and filled in for rows an older release wrote without one', async () => {
    const path = await fileFrom019();
    captureStderr();
    const s = new SqliteAdapter(path, { backup: false });
    await s.initialize();
    await s.close();
    const db = new Database(path, { readonly: true });
    const rows = db.prepare('SELECT id, compat_floor FROM _iris_migrations ORDER BY id').all() as Array<{ id: string; compat_floor: string }>;
    db.close();
    expect(rows).toEqual(KNOWN_MIGRATION_IDS.map((id) => ({ id, compat_floor: COMPAT_FLOORS.get(id) })));
  });

  it('opens a file a newer release migrated when that migration’s floor is at or below this version', async () => {
    const path = tempDb();
    const s = new SqliteAdapter(path);
    await s.initialize();
    await s.close();
    const db = new Database(path);
    db.prepare("INSERT INTO _iris_migrations (id, writer_version, compat_floor) VALUES ('016-additive', '99.0.0', ?)").run(PKG_VERSION);
    db.close();
    const again = new SqliteAdapter(path);
    await again.initialize();
    await again.insertTraces(LOCAL_TENANT, [trace('t-2', 'still writable')]);
    const reader = openDriver(path, { readOnly: true });
    const plan = inspectMigrations(reader);
    reader.close();
    expect(plan.unknown.map((r) => r.id)).toEqual(['016-additive']);
    expect(plan.blocking).toEqual([]);
    expect(again.upgradeReport()).toBeUndefined();
    await again.close();
  });

  it('refuses a file whose floor is above this version, or unrecorded, before copying or changing anything', async () => {
    for (const [floor, needs] of [["'99.0.0'", 'need Iris 99.0.0 or later'], ['NULL', 'need a newer Iris']] as const) {
      const path = await fileFrom019();
      const db = new Database(path);
      // As a release from 0.20.0 on leaves the ledger: with the floor column.
      db.exec('ALTER TABLE _iris_migrations ADD COLUMN compat_floor TEXT');
      db.prepare(`INSERT INTO _iris_migrations (id, writer_version, compat_floor) VALUES ('099-from-the-future', '99.0.0', ${floor})`).run();
      db.close();
      const before = sha256(path);
      const s = new SqliteAdapter(path);
      const err = await s.initialize().then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(IncompatibleDatabaseError);
      const message = (err as Error).message;
      expect(message).toContain(`This database was migrated by a newer Iris (99.0.0) — migration(s) 099-from-the-future ${needs}, and this is v${PKG_VERSION}.`);
      expect(message).toContain('npx -y @iris-eval/mcp-server@latest install --upgrade');
      expect(message).toContain(DOWNGRADING_URL);
      expect(sha256(path)).toBe(before);
      expect(listBackups(path)).toEqual([]);
    }
  });
});
