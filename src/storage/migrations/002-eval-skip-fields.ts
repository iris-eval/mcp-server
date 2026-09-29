import type { Driver } from '../driver.js';

export const id = '002-eval-skip-fields';
/** The release that introduced it, and the oldest that can use a database it has been applied to (migrations/index.ts). */
export const compatFloor = '0.2.0';

export function up(db: Driver): void {
  db.exec(`
    ALTER TABLE eval_results ADD COLUMN rules_evaluated INTEGER;
    ALTER TABLE eval_results ADD COLUMN rules_skipped INTEGER;
    ALTER TABLE eval_results ADD COLUMN insufficient_data INTEGER DEFAULT 0;
  `);
}
