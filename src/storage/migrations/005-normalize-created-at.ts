import type Database from 'better-sqlite3';

export const id = '005-normalize-created-at';

/*
 * Normalize created_at to ISO-8601 UTC.
 *
 * The column's DEFAULT is `datetime('now')`, which SQLite renders as
 * "2026-08-09 15:00:00" — space separator, no milliseconds, no Z. Nothing
 * ever wrote the column explicitly, so every row carried that shape. But
 * every query compares it against a JS `toISOString()` value
 * ("2026-08-09T15:00:00.000Z") using plain string comparison.
 *
 * ' ' is 0x20 and 'T' is 0x54, so the stored value sorts BEFORE any
 * same-date boundary. Result: every eval whose calendar date equalled the
 * window boundary's date was silently dropped from the window. A 20-hour-old
 * eval vanished from "last 24h"; at 01:00 UTC the 24h view showed only what
 * had happened since midnight. Traces were unaffected — log-trace writes a
 * real ISO string — which is why this presented as "my evals are missing but
 * my traces aren't".
 *
 * Fix in two halves: the adapter now writes ISO explicitly (so the DEFAULT
 * never fires), and this migration rewrites the rows already on disk.
 * strftime with %f gives milliseconds; SQLite stores UTC, so the literal Z
 * is accurate. Rows already in ISO form are left alone — the LIKE guard
 * matches only the space-separated shape, which keeps this idempotent and
 * safe to run against a partially-migrated DB.
 */
export function up(db: Database.Database): void {
  for (const table of ['traces', 'eval_results']) {
    db.exec(`
      UPDATE ${table}
         SET created_at = strftime('%Y-%m-%dT%H:%M:%fZ', created_at)
       WHERE created_at LIKE '____-__-__ __:__:__%'
    `);
  }
}
