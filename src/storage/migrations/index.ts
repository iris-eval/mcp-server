import type Database from 'better-sqlite3';
import * as migration001 from './001-initial-schema.js';
import * as migration002 from './002-eval-skip-fields.js';

interface Migration {
  id: string;
  up(db: Database.Database): void;
}

const migrations: Migration[] = [migration001, migration002];

export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _iris_migrations (
      id TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (datetime('now'))
    )
  `);

  const applied = new Set(
    db
      .prepare('SELECT id FROM _iris_migrations')
      .all()
      .map((row) => (row as { id: string }).id),
  );

  for (const migration of migrations) {
    if (!applied.has(migration.id)) {
      db.transaction(() => {
        migration.up(db);
        db.prepare('INSERT INTO _iris_migrations (id) VALUES (?)').run(migration.id);
      })();
    }
  }
}
