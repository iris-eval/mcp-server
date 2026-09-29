import type { Driver } from '../driver.js';

/*
 * Where a trace's cost came from (#702).
 *
 * From 0.20.0 a trace that reports no cost but carries token counts and a
 * priced model is stored with a cost Iris estimated (src/cost/trace-cost.ts).
 * `cost_source` keeps the two apart for good: `reported` or `estimated`;
 * NULL on a row with no cost, and on a cost stored before this migration
 * (read as reported, below). `cost_estimate` is the JSON of how the
 * estimate was computed (the calls, tokens and prices), or why a trace has
 * no cost.
 *
 * Every cost stored before this migration was reported: no earlier version
 * estimated one. Those rows keep cost_source NULL and are READ as reported
 * (rowToTrace in sqlite-adapter.ts) rather than rewritten here: an UPDATE
 * of every costed row held the start for 2.3 s at 100,000 traces, half of
 * them costed, and the answer it would store is the one the read gives.
 * Rows with no cost are left without one — an estimate at the price table
 * of the day of the upgrade would be a number no producer sent and no
 * ingest computed, and it would move the cost totals of past periods.
 * Additive only: two nullable columns, nothing rewritten.
 */
export const id = '016-trace-cost-source';

/*
 * The oldest release that can use a database with these columns: 0.19.0,
 * one below the release that added them. 0.19.0 names its columns on every
 * insert and ignores the two new ones on read, so what it writes is a row
 * with cost_source NULL, which this release reads as reported when the row
 * has a cost and as no cost when it has none: the same as every row stored
 * before this migration. Its metadata patch, deletes and retention sweep
 * leave an estimated row's source and estimate as they were. Checked with
 * the released 0.19.0's own adapter (tests/upgrade/). 015 still holds the
 * file at 0.20.0, so this floor takes effect only once a later release
 * lowers that one.
 */
export const compatFloor = '0.19.0';

export function up(db: Driver): void {
  db.exec(`
    ALTER TABLE traces ADD COLUMN cost_source TEXT;
    ALTER TABLE traces ADD COLUMN cost_estimate TEXT;
  `);
}
