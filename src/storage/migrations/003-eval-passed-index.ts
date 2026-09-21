import type { Driver } from '../driver.js';

export const id = '003-eval-passed-index';

export function up(db: Driver): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_eval_results_passed ON eval_results(passed);
  `);
}
