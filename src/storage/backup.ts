/*
 * The copy of the database taken before a migration (0.20.0, #704).
 *
 * A migration cannot be undone, and the release before it refuses the file
 * once it has run, so without a copy there is no way back. Before the first
 * pending migration is applied to a file that already holds data, the
 * adapter writes a consistent copy next to it with `VACUUM INTO` — a
 * snapshot of the committed state, the write-ahead log included, readable
 * by any SQLite and written while other processes keep reading — named for
 * the release that last migrated the file and the one migrating it now:
 *
 *   iris.db.0.19.0-to-0.20.0.20260928T101500Z.bak
 *
 * Restoring it is a file copy (README, "Downgrading"). The newest
 * BACKUPS_KEPT are kept and older ones deleted, so the copies cannot grow
 * without bound. A copy holds every trace as it was, so it is created
 * owner-only like the database, `--purge` deletes it with everything else,
 * and the retention sweep deletes one older than `retention.days`.
 *
 * When the disk has no room for the copy, or it cannot be written, the
 * migration goes ahead without one and says so: refusing to start would
 * take every MCP client down over a copy the user may never need, and the
 * sentence tells them how to make one themselves.
 */
import { closeSync, openSync, readdirSync, statfsSync, unlinkSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import type { Driver } from './driver.js';
import { OWNER_ONLY_FILE_MODE } from '../utils/write-atomic.js';

/** How many copies are kept per database. */
export const BACKUPS_KEPT = 3;

/** Room left beyond the copy's own size, so the copy never takes the last of the disk. */
const FREE_SPACE_MARGIN_BYTES = 64 * 1024 * 1024;

export interface BackupFile {
  path: string;
  /** The release that last migrated the file the copy was taken from (`unknown` when none was recorded). */
  from: string;
  /** The release that was about to migrate it. */
  to: string;
  /** When the copy was taken. */
  takenAt: Date;
}

export type BackupResult = { taken: true; path: string; bytes: number } | { taken: false; reason: string };

function stamp(at: Date): string {
  return at.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

/** A version as it may appear in a file name. */
function safe(version: string): string {
  return version.replace(/[^0-9A-Za-z.+-]/g, '_');
}

/** The name of a copy taken at `at`; `n` tells apart two taken in the same second. */
export function backupPath(dbPath: string, from: string, to: string, at: Date, n = 0): string {
  return `${dbPath}.${safe(from)}-to-${safe(to)}.${stamp(at)}${n > 0 ? `-${n}` : ''}.bak`;
}

const NAME = /^(.+?)-to-(.+)\.(\d{8}T\d{6}Z)(?:-\d+)?\.bak$/;

/** The copies taken of `dbPath`, newest first. */
export function listBackups(dbPath: string): BackupFile[] {
  const dir = dirname(dbPath);
  const prefix = `${basename(dbPath)}.`;
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: BackupFile[] = [];
  for (const name of names) {
    if (!name.startsWith(prefix)) continue;
    const m = NAME.exec(name.slice(prefix.length));
    if (!m) continue;
    const s = m[3];
    const takenAt = new Date(`${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(9, 11)}:${s.slice(11, 13)}:${s.slice(13, 15)}Z`);
    if (Number.isNaN(takenAt.getTime())) continue;
    out.push({ path: join(dir, name), from: m[1], to: m[2], takenAt });
  }
  return out.sort((a, b) => b.takenAt.getTime() - a.takenAt.getTime() || b.path.localeCompare(a.path));
}

/**
 * Delete copies of `dbPath`: all but the newest `keep`, and, when
 * `olderThan` is given, every one taken before it. Returns the paths removed.
 */
export function pruneBackups(dbPath: string, options: { keep?: number; olderThan?: Date } = {}): string[] {
  const keep = options.keep ?? BACKUPS_KEPT;
  const removed: string[] = [];
  for (const [i, b] of listBackups(dbPath).entries()) {
    if (i < keep && !(options.olderThan && b.takenAt < options.olderThan)) continue;
    try {
      unlinkSync(b.path);
      removed.push(b.path);
    } catch {
      // Held open by another process or already gone: the next prune tries again.
    }
  }
  return removed;
}

/** Free bytes for this user on the disk holding `dir`, or undefined when the platform cannot say. */
function freeBytes(dir: string): number | undefined {
  try {
    const s = statfsSync(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return undefined;
  }
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export interface BackupOptions {
  /** The release that last migrated the file. */
  from: string | null;
  /** The release about to migrate it. */
  to: string;
  now?: Date;
  /** Injectable for tests: free bytes on the disk. */
  freeBytes?: (dir: string) => number | undefined;
}

/**
 * Write a consistent copy of the open database next to it, then prune the
 * older copies. Never throws: a copy that cannot be made is a reason.
 */
export function backupDatabase(db: Driver, dbPath: string, options: BackupOptions): BackupResult {
  const planned = planBackup(db, dbPath, options);
  if (!('path' in planned)) return planned;
  try {
    db.exec(vacuumInto(planned.path));
  } catch (err) {
    return copyFailed(planned.path, err);
  }
  pruneBackups(dbPath);
  return { taken: true, path: planned.path, bytes: planned.needed };
}

/**
 * backupDatabase, with the copy itself written by `exec` on another
 * connection to the same file: the checkpoint worker's, so the seconds a
 * large file takes to copy are not spent on the event loop
 * (sqlite-adapter.ts, the upgrade after the start). `db` only reads the
 * sizes the disk check needs.
 */
export async function backupDatabaseWith(db: Driver, dbPath: string, options: BackupOptions, exec: (sql: string) => Promise<void>): Promise<BackupResult> {
  const planned = planBackup(db, dbPath, options);
  if (!('path' in planned)) return planned;
  try {
    await exec(vacuumInto(planned.path));
  } catch (err) {
    return copyFailed(planned.path, err);
  }
  pruneBackups(dbPath);
  return { taken: true, path: planned.path, bytes: planned.needed };
}

const vacuumInto = (path: string) => `VACUUM INTO '${path.replace(/'/g, "''")}'`;

/** The copy's path, created empty and owner-only, and the bytes it will take; or why there will be none. */
function planBackup(db: Driver, dbPath: string, options: BackupOptions): { path: string; needed: number } | { taken: false; reason: string } {
  const read = (name: string) => Number(Object.values(db.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[0]);
  const pageSize = read('page_size');
  const pages = read('page_count');
  const free = read('freelist_count');
  // VACUUM INTO writes the pages in use and none of the free ones.
  const needed = Math.max(0, pages - free) * pageSize;
  const available = (options.freeBytes ?? freeBytes)(dirname(dbPath));
  if (available !== undefined && available < needed + FREE_SPACE_MARGIN_BYTES) {
    return { taken: false, reason: `the disk has ${mib(available)} free and the copy needs about ${mib(needed)} plus ${mib(FREE_SPACE_MARGIN_BYTES)} to spare` };
  }

  const at = options.now ?? new Date();
  // The file is created first, empty and owner-only (VACUUM INTO writes into an empty file), so the copy is never readable by other accounts and two processes never pick one name.
  for (let n = 0; ; n++) {
    const path = backupPath(dbPath, options.from ?? 'unknown', options.to, at, n);
    try {
      closeSync(openSync(path, 'wx', OWNER_ONLY_FILE_MODE));
      return { path, needed };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST' && n < 100) continue;
      return { taken: false, reason: `${path} could not be created (${(err as NodeJS.ErrnoException).code ?? (err as Error).message})` };
    }
  }
}

function copyFailed(path: string, err: unknown): BackupResult {
  try {
    unlinkSync(path);
  } catch {
    // Nothing was written, or it is already gone.
  }
  return { taken: false, reason: `writing ${path} failed (${err instanceof Error ? err.message : String(err)})` };
}
