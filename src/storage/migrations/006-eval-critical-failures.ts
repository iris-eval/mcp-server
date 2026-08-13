import type Database from 'better-sqlite3';

export const id = '006-eval-critical-failures';

/*
 * v0.5.0's headline feature — the critical-rule veto — was response-only.
 * `critical_failures` was returned to the caller and then dropped on the
 * floor: `insertEvalResult` never wrote it, so once an evaluation was
 * stored, a vetoed eval was indistinguishable from one that simply scored
 * below the threshold. Nothing downstream could filter, count or badge the
 * flagship behaviour, and the dashboard showed "safety · fail  score 0.92"
 * with no way to say WHY it failed.
 *
 * JSON text rather than a join table: it mirrors how rule_results and
 * suggestions are already stored, keeps the read path a single row, and the
 * array is small and read-only after write.
 *
 * NULL for every row written before this migration, which is honest — those
 * evaluations predate the veto, so "no recorded veto" is the truth rather
 * than an empty array asserting there was none.
 */
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE eval_results ADD COLUMN critical_failures TEXT;
  `);
}
