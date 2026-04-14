import type Database from 'better-sqlite3';

export const id = '003-eval-passed-index';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_eval_results_passed ON eval_results(passed);
  `);
}
