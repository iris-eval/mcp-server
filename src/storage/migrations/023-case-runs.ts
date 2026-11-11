import type { Driver } from '../driver.js';

/*
 * What each run of a case did, kept small (src/eval/case-history.ts).
 *
 * The case-history rules read a run against the same agent's earlier runs
 * of its case, on every evaluation of a trace that has one. What they need
 * of an earlier run is short: the names of the tools it called. Read from
 * the trace itself that costs the whole row, because a trace's tool calls
 * carry every tool's output, and a column stored after them is reached only
 * by walking past them. Measured on a file-backed store: the twenty earlier
 * runs of a case whose thirty calls return 40 KB each took 79 ms to read,
 * against 9 ms for the evaluation they were read for; at twelve calls of
 * 4 KB, 2.5 ms against 1.7. So the names are written once, beside the
 * trace, when it is stored, and the read is twenty index entries and their
 * short rows whatever the traces hold.
 *
 * A row is derived from its trace and from nothing else, and a trace's
 * calls do not change after it is stored, so a row cannot go stale. It goes
 * when its trace goes (ON DELETE CASCADE). A trace stored before this
 * migration has no row and is never read as an earlier run: a case's
 * history starts with the first run stored after the upgrade.
 *
 * `tools` is the distinct names, each held to 128 characters, in the order
 * first called: `[]` for a run that made no call, NULL for one whose calls
 * were not recorded or cannot be listed whole (src/eval/case-history.ts,
 * caseRunOf), which is then not counted among the earlier runs.
 *
 * A history is one agent's: the same ask sent to two agents (an
 * orchestrator handing a user's words to each of its specialists) is one
 * case key and two histories, so `agent_name` is on the row and in the
 * index. An agent's runs of a case are read in the order they were stored,
 * which is the order of their rowids: the index on (tenant_id, case_key,
 * agent_name) holds them so.
 */
export const id = '023-case-runs';
/**
 * A release from the floor on can open this file and use it: a trace it
 * deletes takes its row with it whichever release deletes it, and nothing
 * it writes can make a row wrong. What it cannot do is write one, so a run
 * it stores is not counted among a case's earlier runs. That is a count
 * that reads low in a home where an older process still writes, on rules
 * that decide no verdict, and the alternative is to lock that process out
 * of the file; so the floor stays where 015 holds it.
 */
export const compatFloor = '0.20.0';

export function up(db: Driver): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS case_runs (
      trace_id   TEXT PRIMARY KEY REFERENCES traces(trace_id) ON DELETE CASCADE,
      tenant_id  TEXT NOT NULL DEFAULT 'local',
      case_key   TEXT NOT NULL,
      agent_name TEXT NOT NULL,
      tools      TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_case_runs_tenant_case_agent ON case_runs(tenant_id, case_key, agent_name);
  `);
}
