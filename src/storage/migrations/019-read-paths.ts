import type { Driver } from '../driver.js';

/*
 * The indexes the hot reads walk (#711).
 *
 * Each read that runs on every evaluation or every dashboard render gets
 * an index it can answer from without reading a trace row, and its query
 * names that index (sqlite-adapter.ts), so the plan cannot change when the
 * data or the set of indexes does. Three replace an index whose leading
 * columns they repeat, so a write updates as many trace indexes as before:
 *
 *   idx_traces_tenant_agent_timestamp  (tenant, agent, timestamp, trace_id, cost)
 *       replaces (tenant, agent). An agent's history newest first — the
 *       failure log behind every evaluation's cost baseline, the moments
 *       and failures pages and webhooks — and get_traces for one agent.
 *   idx_traces_tenant_timestamp_cover  (tenant, timestamp, agent, latency, cost,
 *                                       cost source, trace_id)
 *       replaces (tenant, timestamp). The dashboard summary and the eval
 *       stats read a time window's counts, latency, cost (and how much of
 *       it was estimated, migration 016) and agents.
 *   idx_traces_tenant_framework        (tenant, framework)
 *       replaces (framework), which no tenant-scoped query could use.
 *       The dashboard's framework filter lists its values.
 *   idx_spans_tenant_error             (tenant, trace, status) WHERE status is ERROR
 *       new, and holds only the spans that failed: the summary's error
 *       rate asks which traces in the window have one.
 *
 * Built once, in the first start of the release that has them: at
 * 100,000 traces that start takes 1.0 s longer (measured 1.43 to 1.47 s
 * against 0.42 to 0.43 s), and 1.6 s longer with three spans a trace
 * (2.2 to 2.3 s against 0.6 to 0.7 s).
 *
 * Because the reads name these indexes, a release that drops or renames
 * one of them, or a column one of them covers, makes this release's reads
 * fail with "no such index": that later migration sets its compatFloor to
 * its own release. A test checks every INDEXED BY in src/ names an index
 * the migrations create (tests/unit/storage/indexed-by.test.ts).
 */
export const id = '019-read-paths';
/** The release that introduced it, and the oldest that can use a database it has been applied to (migrations/index.ts). */
export const compatFloor = '0.20.0';

export function up(db: Driver): void {
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_traces_tenant_agent_timestamp ON traces(tenant_id, agent_name, timestamp, trace_id, cost_usd);
    CREATE INDEX IF NOT EXISTS idx_traces_tenant_timestamp_cover ON traces(tenant_id, timestamp, agent_name, latency_ms, cost_usd, cost_source, trace_id);
    CREATE INDEX IF NOT EXISTS idx_traces_tenant_framework ON traces(tenant_id, framework);
    CREATE INDEX IF NOT EXISTS idx_spans_tenant_error ON spans(tenant_id, trace_id, status_code) WHERE status_code = 'ERROR';
    DROP INDEX IF EXISTS idx_traces_tenant_agent;
    DROP INDEX IF EXISTS idx_traces_tenant_timestamp;
    DROP INDEX IF EXISTS idx_traces_framework;
  `);
}
