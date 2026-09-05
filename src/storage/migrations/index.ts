import type Database from 'better-sqlite3';
import * as migration001 from './001-initial-schema.js';
import * as migration002 from './002-eval-skip-fields.js';
import * as migration003 from './003-eval-passed-index.js';
import * as migration004 from './004-tenant-id.js';
import * as migration005 from './005-normalize-created-at.js';
import * as migration006 from './006-eval-critical-failures.js';
import * as migration007 from './007-eval-provenance.js';
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

  const applied = new Set(appliedRows.map((r) => r.id));
  for (const migration of migrations) {
    if (!applied.has(migration.id)) {
      db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO _iris_migrations (id) VALUES (?)').run(migration.id);
      })();
    }
  }
  // Every applied migration names the binary that applied it (this one, for
  // rows written before the column existed — the closest true statement).
  db.prepare('UPDATE _iris_migrations SET writer_version = ? WHERE writer_version IS NULL').run(PKG_VERSION);
}
