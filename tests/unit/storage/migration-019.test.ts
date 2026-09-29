/*
 * Migration 019 — the indexes the hot reads walk (#711).
 *
 * On a cold file and on a database written before it, the four indexes
 * exist and the three they replace are gone, applied once, with every row
 * where it was; on a SQLite without FTS5 too, since nothing here depends on
 * the search index. The count of known migrations belongs to the newest
 * migration's test, this one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempDb(): string {
  const dir = mkdtempSync(join(tmpdir(), 'iris-mig019-'));
  dirs.push(dir);
  return join(dir, 'iris.db');
}

const ADDED: Record<string, string> = {
  idx_traces_tenant_agent_timestamp: 'traces(tenant_id, agent_name, timestamp, trace_id, cost_usd)',
  idx_traces_tenant_timestamp_cover: 'traces(tenant_id, timestamp, agent_name, latency_ms, cost_usd, cost_source, trace_id)',
  idx_traces_tenant_framework: 'traces(tenant_id, framework)',
  idx_spans_tenant_error: "spans(tenant_id, trace_id, status_code) WHERE status_code = 'ERROR'",
};
const REPLACED = ['idx_traces_tenant_agent', 'idx_traces_tenant_timestamp', 'idx_traces_framework'];

function indexes(path: string): Map<string, string> {
  const db = new Database(path, { readonly: true });
  try {
    const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL").all() as Array<{ name: string; sql: string }>;
    return new Map(rows.map((r) => [r.name, r.sql.replace(/\s+/g, ' ')]));
  } finally {
    db.close();
  }
}

const trace = (id: string, agent: string, extra: Record<string, unknown> = {}) => ({
  trace_id: id,
  agent_name: agent,
  framework: 'langchain',
  input: `ask ${id}`,
  output: 'The answer, in full.',
  cost_usd: 0.01,
  latency_ms: 120,
  timestamp: '2026-09-21T12:00:00.000Z',
  ...extra,
});

describe('migration 019 — the read-path indexes', () => {
  it('is the last known migration, after 018', () => {
    expect(KNOWN_MIGRATION_IDS).toHaveLength(19);
    expect(KNOWN_MIGRATION_IDS[18]).toBe('019-read-paths');
    expect(KNOWN_MIGRATION_IDS[17]).toBe('018-eval-risk-estimate');
  });

  for (const fts5 of [true, false]) {
    it(`creates the four indexes and drops the three they replace on a cold file, once (${fts5 ? 'with' : 'without'} FTS5)`, async () => {
      const path = tempDb();
      const store = new SqliteAdapter(path, fts5 ? {} : { fts5: false });
      await store.initialize();
      await store.close();
      const again = new SqliteAdapter(path, fts5 ? {} : { fts5: false });
      await again.initialize();
      expect((await again.migrations()).pending).toEqual([]);
      await again.close();

      const found = indexes(path);
      for (const [name, on] of Object.entries(ADDED)) expect(found.get(name), name).toBe(`CREATE INDEX ${name} ON ${on}`);
      for (const name of REPLACED) expect(found.has(name), name).toBe(false);
      const db = new Database(path, { readonly: true });
      const applied = (db.prepare('SELECT id FROM _iris_migrations ORDER BY id').all() as Array<{ id: string }>).map((r) => r.id);
      db.close();
      expect(applied).toEqual([...KNOWN_MIGRATION_IDS]);
      expect(applied.filter((id) => id === '019-read-paths')).toHaveLength(1);
    });
  }

  it('a database written before 019 gains the indexes at its next start, and every row reads back the same', async () => {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.insertTraces(LOCAL_TENANT, [
      trace('t1', 'alpha', { spans: [{ span_id: 's1', trace_id: 't1', name: 'call', kind: 'LLM', status_code: 'ERROR', start_time: '2026-09-21T12:00:00.000Z' }] }),
      trace('t2', 'beta', { framework: 'autogen' }),
    ]);
    await store.insertEvalResult(LOCAL_TENANT, { id: 'e1', trace_id: 't1', eval_type: 'completeness', output_text: 'x', score: 0.4, passed: false, rule_results: [{ ruleName: 'min_output_length', passed: false, score: 0, message: '' }] });
    await store.close();

    // Put the file back the way a build before 019 left it.
    const raw = new Database(path);
    raw.exec(`
      CREATE INDEX idx_traces_tenant_agent ON traces(tenant_id, agent_name);
      CREATE INDEX idx_traces_tenant_timestamp ON traces(tenant_id, timestamp);
      CREATE INDEX idx_traces_framework ON traces(framework);
      ${Object.keys(ADDED).map((name) => `DROP INDEX ${name};`).join('\n')}
      DELETE FROM _iris_migrations WHERE id = '019-read-paths';
    `);
    raw.close();
    const before = indexes(path);
    for (const name of Object.keys(ADDED)) expect(before.has(name)).toBe(false);

    const upgraded = new SqliteAdapter(path);
    await upgraded.initialize();
    try {
      expect(await upgraded.migrations()).toEqual({ applied: KNOWN_MIGRATION_IDS.length, known: KNOWN_MIGRATION_IDS.length, pending: [] });
      const found = indexes(path);
      for (const name of Object.keys(ADDED)) expect(found.has(name), name).toBe(true);
      for (const name of REPLACED) expect(found.has(name), name).toBe(false);
      // Every read the indexes serve answers as before.
      expect(await upgraded.getDistinctValues(LOCAL_TENANT, 'agent_name')).toEqual(['alpha', 'beta']);
      expect(await upgraded.getDistinctValues(LOCAL_TENANT, 'framework')).toEqual(['autogen', 'langchain']);
      expect((await upgraded.getAgentFailureLog(LOCAL_TENANT, 'alpha')).map((e) => [e.traceId, e.failed, e.costUsd])).toEqual([['t1', ['min_output_length'], 0.01]]);
      expect((await upgraded.queryTraces(LOCAL_TENANT, { filter: { agent_name: 'beta' } })).traces.map((t) => t.trace_id)).toEqual(['t2']);
      const summary = await upgraded.getDashboardSummary(LOCAL_TENANT, 24 * 365 * 10);
      expect(summary.total_traces).toBe(2);
      expect(summary.error_rate).toBe(0.5);
    } finally {
      await upgraded.close();
    }
  });
});
