import type { Driver } from './driver.js';

/*
 * The indexes the hot reads walk (#711; migration 019 lists what each is
 * for), built after the start rather than in it.
 *
 * On a store of 100,000 agent-loop traces written by 0.19.0, building them
 * in the migration held the first start for 1.7 to 1.9 s before the MCP
 * connection opened. So a store with traces gets them after the start
 * instead (sqlite-adapter.ts, buildReadPaths): each CREATE INDEX is one
 * statement on the checkpoint worker's connection, off the event loop,
 * and the store's own background steps wait for them. Until they exist, a
 * read that names one of them in INDEXED BY is issued without it (the
 * adapter's `pinned`), so SQLite plans it on the indexes the file already
 * has, as 0.19.0 did: the same answers, more slowly. A store with no traces
 * gets them at once, where there is nothing to read (migration 019).
 *
 * The three they replace are dropped once all four exist: a write updates
 * as many trace indexes as before, and until then the reads without a pin
 * have them.
 */
export const READ_PATH_INDEXES = [
  { name: 'idx_traces_tenant_agent_timestamp', sql: 'CREATE INDEX IF NOT EXISTS idx_traces_tenant_agent_timestamp ON traces(tenant_id, agent_name, timestamp, trace_id, cost_usd)' },
  { name: 'idx_traces_tenant_timestamp_cover', sql: 'CREATE INDEX IF NOT EXISTS idx_traces_tenant_timestamp_cover ON traces(tenant_id, timestamp, agent_name, latency_ms, cost_usd, cost_source, trace_id)' },
  { name: 'idx_traces_tenant_framework', sql: 'CREATE INDEX IF NOT EXISTS idx_traces_tenant_framework ON traces(tenant_id, framework)' },
  { name: 'idx_spans_tenant_error', sql: "CREATE INDEX IF NOT EXISTS idx_spans_tenant_error ON spans(tenant_id, trace_id, status_code) WHERE status_code = 'ERROR'" },
] as const;

export const READ_PATH_INDEX_NAMES: ReadonlySet<string> = new Set(READ_PATH_INDEXES.map((i) => i.name));

/** The indexes they replace, dropped once all four exist. */
export const DROP_REPLACED = `
  DROP INDEX IF EXISTS idx_traces_tenant_agent;
  DROP INDEX IF EXISTS idx_traces_tenant_timestamp;
  DROP INDEX IF EXISTS idx_traces_framework;
`;

/** The read-path indexes this file does not have yet. */
export function readPathsMissing(db: Driver): Array<(typeof READ_PATH_INDEXES)[number]> {
  const has = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map((r) => r.name));
  return READ_PATH_INDEXES.filter((i) => !has.has(i.name));
}

/** Build every missing one and drop what they replace, in the caller's connection: for a store with no traces, where it costs nothing. */
export function buildReadPathsNow(db: Driver): void {
  for (const { sql } of READ_PATH_INDEXES) db.exec(sql);
  db.exec(DROP_REPLACED);
}
