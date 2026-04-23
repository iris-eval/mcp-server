import type Database from 'better-sqlite3';

export const id = '004-tenant-id';

/*
 * Migration 004 — tenant scaffolding.
 *
 * Adds `tenant_id TEXT NOT NULL DEFAULT 'local'` to every data table.
 * Existing rows are backfilled to 'local' by the default. New rows
 * (v0.4+) MUST supply a tenant_id via the storage adapter — the default
 * only exists so the existing-row backfill is automatic.
 *
 * Design notes (threat model §5.1 + §5.2):
 *   - Not NULL. Never allow a row without a tenant.
 *   - DEFAULT 'local'. Backfill is automatic; existing OSS installs
 *     continue working with zero user action.
 *   - Composite indexes put tenant_id first so per-tenant queries use
 *     the leading index column. Existing single-column indexes stay
 *     for non-tenant lookups (e.g., trace_id by primary key is still
 *     fast).
 *
 * Forward compatibility: when Cloud goes live, the storage backend
 * swaps from SQLite to Postgres. The tenant_id column + index
 * conventions translate 1:1.
 */
export function up(db: Database.Database): void {
  db.exec(`
    -- traces
    ALTER TABLE traces ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_traces_tenant_timestamp ON traces(tenant_id, timestamp);
    CREATE INDEX IF NOT EXISTS idx_traces_tenant_agent ON traces(tenant_id, agent_name);

    -- spans
    ALTER TABLE spans ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_spans_tenant_trace ON spans(tenant_id, trace_id);

    -- eval_results
    ALTER TABLE eval_results ADD COLUMN tenant_id TEXT NOT NULL DEFAULT 'local';
    CREATE INDEX IF NOT EXISTS idx_eval_results_tenant_created ON eval_results(tenant_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_eval_results_tenant_trace ON eval_results(tenant_id, trace_id);
    CREATE INDEX IF NOT EXISTS idx_eval_results_tenant_type ON eval_results(tenant_id, eval_type);
  `);
}
