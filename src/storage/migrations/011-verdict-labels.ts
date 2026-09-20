import type Database from 'better-sqlite3';

/*
 * Labels on the user's own traffic (arc 7, D-8; plan §4.13).
 *
 * A label says whether a rule's FIRE on one evaluation was right or wrong,
 * in the reader's judgement. Labels on fires measure precision only — a
 * rule that stayed quiet on a bad output is not labelled here — which is
 * why the surface says "local precision", never "local accuracy". At
 * twenty labels a rule's published number on this deployment becomes the
 * deployment's own; the risk layer reads it; the prior is estimated from
 * it. `rule_name` is nullable by the approved schema so a whole-verdict
 * label can exist later; every label the product writes today names a
 * rule.
 */
export const id = '011-verdict-labels';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS verdict_labels (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      eval_id TEXT NOT NULL,
      rule_name TEXT,
      label TEXT NOT NULL CHECK (label IN ('right', 'wrong')),
      note TEXT,
      labelled_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_verdict_labels_tenant_rule ON verdict_labels(tenant_id, rule_name);
    CREATE INDEX IF NOT EXISTS idx_verdict_labels_tenant_eval ON verdict_labels(tenant_id, eval_id);
  `);
}
