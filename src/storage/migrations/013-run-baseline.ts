import type { Driver } from '../driver.js';

/*
 * A pinned baseline (arc 9, N-14).
 *
 * A comparison needs a `before`. Until now every caller chose it by hand on
 * every call — the dashboard's compare form, the compare_runs tool, a CI
 * job — and "compare this run against the release we shipped" was a run id
 * someone had to remember. A run can now be pinned as the tenant's
 * baseline: `PATCH /api/v1/runs/:id { baseline: true }`. The partial unique
 * index makes "at most one baseline per tenant" a fact of the schema rather
 * than a convention the writers keep; pinning another run unpins the old
 * one in the same transaction.
 */
export const id = '013-run-baseline';

export function up(db: Driver): void {
  db.exec(`
    ALTER TABLE runs ADD COLUMN baseline INTEGER NOT NULL DEFAULT 0;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_runs_baseline ON runs(tenant_id) WHERE baseline = 1;
  `);
}
