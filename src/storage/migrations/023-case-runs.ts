import type { Driver } from '../driver.js';

/*
 * What each run of a case did, kept small (src/eval/case-history.ts).
 *
 * The case-history rules read a run against the earlier runs of its case,
 * on every evaluation of a trace that has one. What they need of an earlier
 * run is short: the names of the tools it called and the specifics its
 * answer carried, a few hundred bytes. Read from the trace itself that
 * costs the whole row, because a trace's tool calls carry every tool's
 * output, and a column stored after them is reached only by walking past
 * them. Measured on a file-backed store: the twenty earlier runs of a case
 * whose thirty calls return 40 KB each took 79 ms to read, against 9 ms for
 * the evaluation they were read for; at twelve calls of 4 KB, 2.5 ms
 * against 1.7. So the two short lists are written once, beside the trace,
 * when it is stored, and the read is twenty index entries and their rows
 * whatever the traces hold.
 *
 * A row is derived from its trace and from nothing else, and a trace's
 * calls and answer do not change after it is stored, so a row cannot go
 * stale. It goes when its trace goes (ON DELETE CASCADE), which is what
 * keeps the figures of a deleted answer out of the file. A trace stored
 * before this migration has no row and is never read as an earlier run: a
 * case's history starts with the first run stored after the upgrade.
 *
 * `tools` is NULL for a run whose calls were not recorded and `[]` for one
 * that made none; `specifics` is NULL for a run that stored no answer.
 * Rows of one case are read in the order they were stored, which is the
 * order of their rowids: the index on (tenant_id, case_key) holds them so.
 */
export const id = '023-case-runs';
/**
 * A release from the floor on that opens this file stores traces without a
 * row, which reads as runs that are not there, and a trace it deletes takes
 * its row with it whichever release deletes it. Nothing an older release
 * writes can make a row wrong, so the floor stays where 015 holds the file.
 */
export const compatFloor = '0.20.0';

export function up(db: Driver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_runs (
      trace_id  TEXT PRIMARY KEY REFERENCES traces(trace_id) ON DELETE CASCADE,
      tenant_id TEXT NOT NULL DEFAULT 'local',
      case_key  TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      tools     TEXT,
      specifics TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_case_runs_tenant_case ON case_runs(tenant_id, case_key);
  `);
}
