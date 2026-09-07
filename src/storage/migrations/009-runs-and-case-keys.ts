import type Database from 'better-sqlite3';

export const id = '009-runs-and-case-keys';

/*
 * The two things a comparison needs, and Iris has never stored either.
 *
 * "Did my change make it worse?" is the question every competitor answers
 * from a test suite you wrote — which means the answer only covers what you
 * thought to write down. Iris can answer it from the traces it already
 * holds, and the only reason it cannot today is that nothing groups them.
 *
 * A RUN is a batch of executions you want to speak about as one thing: a CI
 * job, a nightly sweep, an afternoon of manual pokes. It is the caller's
 * label, not ours — we never infer one from timestamps, because two
 * deployments' notions of "a run" differ and a guessed grouping produces a
 * number nobody can act on.
 *
 * A CASE KEY is what makes two traces the SAME QUESTION asked twice. It is
 * what turns two independent samples into a PAIRED comparison, and pairing
 * is worth a great deal: McNemar on matched pairs sees a regression that an
 * unpaired test of the same data cannot, because it removes the variance
 * between cases and leaves only the variance from the change. Six matched
 * pairs can say something that six unmatched ones cannot.
 *
 * WHY BOTH ARE NULLABLE, and why that is not a hedge. Every trace already in
 * every user's database predates this migration and belongs to no run. A
 * NOT NULL column would either refuse those rows or invent a grouping for
 * them, and an invented run is worse than none: it would report a
 * comparison between two things that were never a batch.
 *
 * WHY `case_key` IS STORED RATHER THAN DERIVED ON READ. It can be derived —
 * a hash of the normalised input — and for a caller that sends nothing, it
 * is. But a caller who KNOWS its case identity (a CI job with a fixture
 * name) has better information than any hash of the prompt: two runs may
 * legitimately reword a prompt while asking the same question. Storing the
 * column lets the caller's answer win, and the derived one fill in. A
 * derived-on-read column could only ever have the weaker answer.
 *
 * The two indexes are the two access paths a comparison takes: everything in
 * a run, and every occurrence of one case. Both are tenant-scoped first,
 * because every query in this store is.
 */
export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS runs (
      run_id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      label TEXT,
      agent_name TEXT,
      engine_version TEXT,
      ruleset_hash TEXT,
      config_hash TEXT,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      /*
       * Set when this run was produced by re-evaluating another one rather
       * than by fresh execution. A comparison that silently mixed a
       * re-evaluation with a real run would attribute a change in the RULES
       * to a change in the AGENT, which is the one confusion this whole arc
       * exists to prevent.
       */
      reevaluation_of TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_runs_tenant_started ON runs(tenant_id, started_at);
    CREATE INDEX IF NOT EXISTS idx_runs_tenant_agent ON runs(tenant_id, agent_name);

    ALTER TABLE traces ADD COLUMN run_id TEXT;
    ALTER TABLE traces ADD COLUMN case_key TEXT;
    ALTER TABLE eval_results ADD COLUMN run_id TEXT;

    CREATE INDEX IF NOT EXISTS idx_traces_tenant_case ON traces(tenant_id, case_key);
    CREATE INDEX IF NOT EXISTS idx_traces_tenant_run ON traces(tenant_id, run_id);
    CREATE INDEX IF NOT EXISTS idx_eval_results_tenant_run ON eval_results(tenant_id, run_id);
  `);
}
