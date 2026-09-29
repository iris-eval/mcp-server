import type { Driver } from '../driver.js';
import { buildReadPathsNow } from '../read-paths.js';

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
 * On a store with no traces they are built here, which costs nothing. On
 * one with traces they are built after the start (read-paths.ts): at
 * 100,000 agent-loop traces written by 0.19.0, building them here held the
 * first start for 1.7 to 1.9 s before the MCP connection opened.
 *
 * Because the reads name these indexes once they exist, a later release
 * that drops or renames one of them, or a column one of them covers, sets
 * its compatFloor to its own release: this release would build the old
 * index again at its next start, or fail on the column. A test checks
 * every index a read names exists once the migrations and the build after
 * the start have run (tests/unit/storage/indexed-by.test.ts).
 */
export const id = '019-read-paths';
/** The release that introduced it, and the oldest that can use a database it has been applied to (migrations/index.ts). */
export const compatFloor = '0.20.0';

export function up(db: Driver): void {
  if (db.prepare('SELECT 1 FROM traces LIMIT 1').get() === undefined) buildReadPathsNow(db);
}
