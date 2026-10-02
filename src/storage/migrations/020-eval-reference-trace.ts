import type { Driver } from '../driver.js';

/*
 * An evaluation made BESIDE a trace, as distinct from the trace's verdict.
 *
 * `eval_results.trace_id` says "this is a verdict on that trace", and every
 * reader that asks for a trace's verdict takes the newest row carrying it:
 * a run's results, a comparison, the reliability of a case, the score
 * filter on get_traces. Until this migration every evaluation a caller
 * linked to a trace carried it, whatever was judged. So an agent whose
 * trace failed on a leaked credential could call evaluate_output with that
 * trace's id and different text (or the same text and one bundle, or an
 * empty list of tool calls) and the trace read `pass` everywhere, with no
 * flag. A judge or citation row linked the same way replaced the verdict
 * too.
 *
 * The verdict of a trace is now only the server's own scoring of the trace
 * as stored: at ingest, by evaluate_runs, by the re-evaluate route, or by
 * evaluate_output when it passes nothing that differs from the record.
 * Anything else a caller links is stored with `trace_id` NULL and the trace
 * named here instead. No reader of a trace's verdict can pick such a row
 * up, because it does not carry the trace's id; the readers that LIST a
 * trace's evaluations ask for both columns. A reader written later that
 * forgets this column shows less, never a replaced verdict.
 *
 * Not a foreign key: deleting the trace keeps the row, as it keeps a
 * verdict (migration 001's ON DELETE SET NULL), and erases its text through
 * this column. The index holds only the rows that carry one.
 *
 * Rows written before this migration are left as they are: which of them
 * judged the stored record cannot be told from the row.
 */
export const id = '020-eval-reference-trace';
/** The release that introduced it; an older writer leaves the column NULL, and 015 already holds the file at 0.20.0. */
export const compatFloor = '0.20.0';

export function up(db: Driver): void {
  db.exec(`
    ALTER TABLE eval_results ADD COLUMN reference_trace_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_eval_results_tenant_reference ON eval_results(tenant_id, reference_trace_id) WHERE reference_trace_id IS NOT NULL;
  `);
}
