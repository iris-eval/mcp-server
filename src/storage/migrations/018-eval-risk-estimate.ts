import type { Driver } from '../driver.js';

/*
 * The risk estimate, kept beside the evaluation it was computed for.
 *
 * Every read of an evaluation re-composes its verdict (007 says why the
 * verdict is not a column), and composing runs the risk estimate's 2,000
 * draws. Reading 500 evaluations therefore ran them up to 500 times. The
 * estimate is now stored at write time with the key of the inputs it came
 * from, and a read uses it only when its own inputs give the same key. It
 * is still derived and never an authority: a row whose key does not match
 * (a newer corpus, rows written before this migration, a NULL) is computed
 * on read exactly as before, and a background step fills the rows that
 * have none. `risk_version` names the build's key version, and its index
 * lets that step find the rows still to fill (NULL, or another build's
 * version) without reading every row, so a start after the fill reads
 * nothing.
 */
export const id = '018-eval-risk-estimate';
/*
 * The release that introduced it. An older writer leaves risk_version NULL,
 * which reads compute and the fill repairs, but 015 already holds the file
 * at 0.20.0.
 */
export const compatFloor = '0.20.0';

export function up(db: Driver): void {
  db.exec(`
    ALTER TABLE eval_results ADD COLUMN risk_estimate TEXT;
    ALTER TABLE eval_results ADD COLUMN risk_version TEXT;
    CREATE INDEX IF NOT EXISTS idx_eval_results_risk_version ON eval_results(risk_version);
  `);
}
