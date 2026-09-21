import type { Driver } from '../driver.js';

export const id = '002-eval-skip-fields';

export function up(db: Driver): void {
  db.exec(`
    ALTER TABLE eval_results ADD COLUMN rules_evaluated INTEGER;
    ALTER TABLE eval_results ADD COLUMN rules_skipped INTEGER;
    ALTER TABLE eval_results ADD COLUMN insufficient_data INTEGER DEFAULT 0;
  `);
}
