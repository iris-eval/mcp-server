import type { Driver } from '../driver.js';

/*
 * The capture source's declaration on a trace (src/eval/evidence.ts): the
 * software that recorded it by watching the agent, and the evidence it
 * records in full, as JSON. NULL when no capture source declared itself,
 * which is every trace stored before this migration and every trace the
 * agent logged itself through the log_trace tool.
 *
 * A trace evaluated again later (evaluate_runs, the re-evaluate route,
 * evaluate_output with its trace_id) is judged on the same declaration it
 * was stored with: without the column, an empty list of tool calls that a
 * capture source recorded as "none were made" would read on the second
 * evaluation as the agent's own unverified "none".
 *
 * Additive only: one nullable column, nothing rewritten.
 */
export const id = '022-trace-capture';
/** The release that introduced it; an older writer leaves the column NULL, and 015 already holds the file at 0.20.0. */
export const compatFloor = '0.20.0';

export function up(db: Driver): void {
  db.exec(`
    ALTER TABLE traces ADD COLUMN capture TEXT;
  `);
}
