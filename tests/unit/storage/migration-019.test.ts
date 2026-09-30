/*
 * Migration 019 — the indexes the hot reads walk (#711).
 *
 * On a cold file the migration builds the four indexes and drops the three
 * they replace, once; on a SQLite without FTS5 too, since nothing here
 * depends on the search index. On a database written before it, with
 * traces, the start does not: they are built after it (read-paths.ts),
 * health says `building` until they are, and every read answers the same
 * before and after. The count of known migrations belongs to the newest
 * migration's test, this one.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { KNOWN_MIGRATION_IDS } from '../../../src/storage/migrations/index.js';
import { READ_PATH_INDEXES } from '../../../src/storage/read-paths.js';
import { buildHealth } from '../../../src/health.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

vi.setConfig({ testTimeout: 30_000 });

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
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

  /** Put the file back the way a build before 019 left it, with its traces. */
  async function writtenBefore019(): Promise<string> {
    const path = tempDb();
    const store = new SqliteAdapter(path);
    await store.initialize();
    await store.insertTraces(LOCAL_TENANT, [
      trace('t1', 'alpha', { spans: [{ span_id: 's1', trace_id: 't1', name: 'call', kind: 'LLM', status_code: 'ERROR', start_time: '2026-09-21T12:00:00.000Z' }] }),
      trace('t2', 'beta', { framework: 'autogen' }),
    ]);
    await store.insertEvalResult(LOCAL_TENANT, { id: 'e1', trace_id: 't1', eval_type: 'completeness', output_text: 'x', score: 0.4, passed: false, rule_results: [{ ruleName: 'min_output_length', passed: false, score: 0, message: '' }] });
    await store.close();
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
    return path;
  }

  /** Every read the indexes serve, as it answers. */
  const reads = async (s: SqliteAdapter) => ({
    agents: await s.getDistinctValues(LOCAL_TENANT, 'agent_name'),
    frameworks: await s.getDistinctValues(LOCAL_TENANT, 'framework'),
    failureLog: (await s.getAgentFailureLog(LOCAL_TENANT, 'alpha')).map((e) => [e.traceId, e.failed, e.costUsd]),
    oneAgent: (await s.queryTraces(LOCAL_TENANT, { filter: { agent_name: 'beta' } })).traces.map((t) => t.trace_id),
    summary: await s.getDashboardSummary(LOCAL_TENANT, 24 * 365 * 10).then((d) => [d.total_traces, d.error_rate]),
  });
  const EXPECTED = {
    agents: ['alpha', 'beta'],
    frameworks: ['autogen', 'langchain'],
    failureLog: [['t1', ['min_output_length'], 0.01]],
    oneAgent: ['t2'],
    summary: [2, 0.5],
  };

  it('a start that finds only some of them builds the rest, and a close during the build waits for it', async () => {
    const path = await writtenBefore019();
    const raw = new Database(path);
    raw.exec("INSERT INTO _iris_migrations (id) VALUES ('019-read-paths')");
    raw.exec(READ_PATH_INDEXES[0].sql);
    raw.close();
    const first = new SqliteAdapter(path);
    await first.initialize();
    expect(first.readIndexesState()).toBe('building');
    await first.close();
    // The close waited for the build: every index is there, and the replaced ones are gone.
    const found = indexes(path);
    for (const name of Object.keys(ADDED)) expect(found.has(name), name).toBe(true);
    for (const name of REPLACED) expect(found.has(name), name).toBe(false);
    const next = new SqliteAdapter(path);
    await next.initialize();
    try {
      expect(next.readIndexesState()).toBe('ready');
      expect(await reads(next)).toEqual(EXPECTED);
    } finally {
      await next.close();
    }
  });

  it('a database written before 019 answers at once, and gains the indexes after the start, reading back the same', async () => {
    const path = await writtenBefore019();
    const upgraded = new SqliteAdapter(path);
    await upgraded.initialize();
    try {
      expect(await upgraded.migrations()).toEqual({ applied: KNOWN_MIGRATION_IDS.length, known: KNOWN_MIGRATION_IDS.length, pending: [] });
      // The start did not build them: the reads answer without them, on the indexes the file had.
      expect(upgraded.readIndexesState()).toBe('building');
      expect((await buildHealth({ storage: upgraded, version: 'test' })).body.indexes).toBe('building');
      for (const name of Object.keys(ADDED)) expect(indexes(path).has(name), name).toBe(false);
      expect(await reads(upgraded)).toEqual(EXPECTED);
      await upgraded.whenIdle();
      expect(upgraded.readIndexesState()).toBe('ready');
      expect((await buildHealth({ storage: upgraded, version: 'test' })).body.indexes).toBe('ready');
      const found = indexes(path);
      for (const [name, on] of Object.entries(ADDED)) expect(found.get(name), name).toBe(`CREATE INDEX ${name} ON ${on}`);
      for (const name of REPLACED) expect(found.has(name), name).toBe(false);
      expect(await reads(upgraded)).toEqual(EXPECTED);
    } finally {
      await upgraded.close();
    }
  });
});
