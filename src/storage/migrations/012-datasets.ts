import type Database from 'better-sqlite3';

/*
 * Datasets (arc 8, R-8; plan §8).
 *
 * A dataset is a named set of case keys — the questions a reader has
 * decided matter — so a comparison and a gate can be restricted to them.
 * Until now `compare_runs` paired whatever case keys two runs happened to
 * share, and `ingest --fail-on` gated every trace it evaluated; an org
 * reader had no way to say "these forty cases are the release gate" and
 * have both tools honour it. Promotion is by case key: a run's keys, or an
 * explicit list, become the dataset's cases.
 *
 * `expected_json` is carried, never read, by any statistic in this minor
 * (the row says "no new statistics"): it is the seam a later row fills
 * when a case can carry the answer the reader expects, so a dataset need
 * not be re-promoted to gain it. `version` counts additions so a comparison
 * can say which dataset version it ran against.
 */
export const id = '012-datasets';

export function up(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS datasets (
      id TEXT PRIMARY KEY,
      tenant_id TEXT NOT NULL,
      label TEXT NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_datasets_tenant_label ON datasets(tenant_id, label);
    CREATE TABLE IF NOT EXISTS dataset_cases (
      dataset_id TEXT NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
      case_key TEXT NOT NULL,
      expected_json TEXT,
      PRIMARY KEY (dataset_id, case_key)
    );
  `);
}
