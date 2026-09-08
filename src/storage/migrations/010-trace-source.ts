import type Database from 'better-sqlite3';

/*
 * Which door a trace came through: tool | http | cli | hook | otel. The
 * capture plugin's Stop hook and a model-initiated log_trace can both see
 * one turn; the column is what lets a reader tell them apart, and what the
 * hook reads to skip a turn the model already logged.
 */
export const id = '010-trace-source';

export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE traces ADD COLUMN source TEXT;
  `);
}
