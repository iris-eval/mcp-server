import type { Driver } from '../driver.js';

/*
 * Which of the three states an evaluation's verdict had: pass, fail, or
 * unknown (not checked).
 *
 * `passed` holds two of them. A verdict that was not checked (nothing was
 * judged, a critical check could not answer, evidence somebody asked for
 * was not sent) is stored with `passed = 0`, beside the failures, and every
 * count and every list that read the column drew it as one: a run of ten
 * with eight passes and two verdicts that could not be reached read "8 of
 * 10 passed" with two red FAIL rows. The verdict itself is still composed
 * on every read (007 says why it is not a column). This column is what a
 * count or a list reads without composing: the state the caller was given
 * when the row was written.
 *
 * It never contradicts `passed`: `pass` exactly when `passed = 1`.
 *
 * Rows written before this migration hold NULL until the background step
 * that stores risk estimates (018) reaches them, which on a database from
 * any earlier release is every row; it writes the state beside the
 * estimate. Until then such a row is counted as it always was, a failure
 * when it did not pass. The index holds only the rows that were not
 * checked, so counting them in a window reads those rows and no others.
 */
export const id = '021-eval-verdict-state';
/** The release that introduced it; an older writer leaves the column NULL, and 015 already holds the file at 0.20.0. */
export const compatFloor = '0.20.0';

export function up(db: Driver): void {
  db.exec(`
    ALTER TABLE eval_results ADD COLUMN verdict_state TEXT;
    CREATE INDEX IF NOT EXISTS idx_eval_results_not_checked ON eval_results(tenant_id, created_at) WHERE verdict_state = 'unknown';
  `);
}
