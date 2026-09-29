import type { Driver } from '../driver.js';

export const id = '003-eval-passed-index';
/** The release that introduced it, and the oldest that can use a database it has been applied to (migrations/index.ts). */
export const compatFloor = '0.2.1';

export function up(db: Driver): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_eval_results_passed ON eval_results(passed);
  `);
}
