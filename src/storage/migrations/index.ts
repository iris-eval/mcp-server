import type Database from 'better-sqlite3';
import * as migration001 from './001-initial-schema.js';
import * as migration002 from './002-eval-skip-fields.js';
import * as migration003 from './003-eval-passed-index.js';
import * as migration004 from './004-tenant-id.js';
import * as migration005 from './005-normalize-created-at.js';
import * as migration006 from './006-eval-critical-failures.js';
import * as migration007 from './007-eval-provenance.js';
import * as migration008 from './008-trace-tools-catalogue.js';
import * as migration009 from './009-runs-and-case-keys.js';
import * as migration010 from './010-trace-source.js';
import { PKG_VERSION } from '../../config/defaults.js';

interface Migration {
  id: string;
  up(db: Database.Database): void;
}

const migrations: Migration[] = [
  migration001,
  migration002,
  migration003,
  migration004,
  migration005,
  migration006,
  migration007,
  migration008,
  migration009,
  migration010,
];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _iris_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const known = new Set(migrations.map((m) => m.id));
  const hasWriterVersion = (db.prepare("PRAGMA table_info('_iris_migrations')").all() as Array<{ name: string }>).some((c) => c.name === 'writer_version');
  const appliedRows = db
    .prepare(hasWriterVersion ? 'SELECT id, writer_version FROM _iris_migrations' : 'SELECT id, NULL AS writer_version FROM _iris_migrations')
    .all() as Array<{ id: string; writer_version: string | null }>;

  /*
   * A downgrade guard (0.9.0). Before it, a binary that did not know a
   * migration silently ignored it and read a schema newer than itself —
   * half the columns, none of the meaning. Now an applied id this build has
   * never heard of refuses to start, naming the version that wrote it, so
   * the operator upgrades instead of corrupting.
   */
  const unknown = appliedRows.filter((r) => !known.has(r.id));
  if (unknown.length > 0) {
    const writers = [...new Set(unknown.map((r) => r.writer_version ?? 'an unknown version'))].join(', ');
    throw new Error(
      `This database was migrated by a newer Iris (${writers}) — migration(s) ${unknown.map((r) => r.id).join(', ')} are unknown to v${PKG_VERSION}. Upgrade Iris, or point IRIS_DB_PATH at a database this version wrote.`,
    );
  }

  /*
   * Two processes on one cold file — a server booting and a hook-driven
   * `ingest` — both used to read "not applied" and then both try to apply:
   * the second writer failed on SQLITE_BUSY_SNAPSHOT or a duplicate column.
   * Each migration now runs under BEGIN IMMEDIATE (the write lock is taken
   * before anything is read) and re-checks the applied set INSIDE that
   * lock, so the loser of the race sees the winner's row and skips. The
   * busy_timeout the adapter sets is what makes the loser wait rather than
   * fail.
   */
  const isApplied = db.prepare('SELECT 1 FROM _iris_migrations WHERE id = ?');
  const markApplied = db.prepare('INSERT INTO _iris_migrations (id) VALUES (?)');
  for (const migration of migrations) {
    db.transaction(() => {
      if (isApplied.get(migration.id)) return;
      migration.up(db);
      markApplied.run(migration.id);
    }).immediate();
  }
  // Every applied migration names the binary that applied it (this one, for
  // rows written before the column existed — the closest true statement).
  db.prepare('UPDATE _iris_migrations SET writer_version = ? WHERE writer_version IS NULL').run(PKG_VERSION);
}
