import type Database from 'better-sqlite3';

export const id = '007-eval-provenance';

/*
 * What an evaluation cannot reconstruct about itself after the fact: the
 * Iris version, the ruleset and configuration hashes and the threshold that
 * produced it (arc zero: "why did this pass on that day" was unanswerable
 * from Iris alone), the judge's spend (the tool description said it was
 * kept; the write path stored none of it), and the erasure stamp the
 * right-to-erasure fix sets when a trace is deleted. `writer_version` on the
 * migration ledger lets a downgraded binary refuse a database it cannot
 * read instead of reading half a schema.
 *
 * `verdict`, `coverage` and `critical_skipped` are NOT columns: every one of
 * them is derived on read from the stored rule_results plus the threshold
 * kept here, so rows written before this migration read back the same way
 * without a backfill.
 */
export function up(db: Database.Database): void {
  db.exec(`
    ALTER TABLE eval_results ADD COLUMN provenance TEXT;
    ALTER TABLE eval_results ADD COLUMN engine_version TEXT;
    ALTER TABLE eval_results ADD COLUMN ruleset_hash TEXT;
    ALTER TABLE eval_results ADD COLUMN config_hash TEXT;
    ALTER TABLE eval_results ADD COLUMN threshold REAL;
    ALTER TABLE eval_results ADD COLUMN eval_cost_usd REAL;
    ALTER TABLE eval_results ADD COLUMN eval_tokens INTEGER;
    ALTER TABLE eval_results ADD COLUMN erased_at TEXT;
    ALTER TABLE _iris_migrations ADD COLUMN writer_version TEXT;
    CREATE INDEX IF NOT EXISTS idx_eval_results_tenant_engine ON eval_results(tenant_id, engine_version, ruleset_hash);
  `);
}
