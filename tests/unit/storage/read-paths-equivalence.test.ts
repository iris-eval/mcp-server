/*
 * The rewritten hot reads answer exactly what the plain queries answer (#711).
 *
 * The failure log now chooses between two pinned queries and walks a
 * growing window of an agent's traces; the filter lists are a skip scan;
 * the summary's error rate reads an index of failed spans. Each is checked
 * against the plain SQL it replaced, on seeded random stores shaped to
 * reach every branch: agents with no evaluations, a few, most and all;
 * traces evaluated twice; timestamps tied four and more to a minute, so a
 * window's edge falls inside a tie; another tenant's rows; spans that
 * failed, several to a trace. Limits from 1 up make the window grow over
 * several steps. The run must take every branch at least once.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { SqliteAdapter, parseRuleResults } from '../../../src/storage/sqlite-adapter.js';
import { nodeSqliteAvailable, type Driver, type Statement } from '../../../src/storage/driver.js';
import { LOCAL_TENANT, asTenantId, type TenantId } from '../../../src/types/tenant.js';
import type { AgentFailureLogEntry } from '../../../src/types/query.js';
import type { Trace } from '../../../src/types/trace.js';

vi.setConfig({ testTimeout: 120_000 });

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

/** A small seeded generator (mulberry32), so a failure names the seed that reproduces it. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OTHER = asTenantId('other-tenant');
const BASE = Date.parse('2026-09-20T00:00:00.000Z');
const DENSITIES = [0, 0.02, 0.2, 0.7, 1];
const RULES = ['no_pii', 'min_output_length', 'answers_the_ask', 'cost_anomaly'];

async function seedRandom(store: SqliteAdapter, seed: number): Promise<{ agents: string[] }> {
  const r = rng(seed);
  const agents = Array.from({ length: 1 + Math.floor(r() * 4) }, (_, i) => `agent-${i}`);
  let evalClock = 0;
  for (const tenant of [LOCAL_TENANT, OTHER]) {
    const traces: Trace[] = [];
    const n = 30 + Math.floor(r() * 300);
    for (let i = 0; i < n; i++) {
      const agent = agents[Math.floor(r() * agents.length)];
      // Ties: a handful of distinct minutes over the whole store.
      const minute = Math.floor(r() * (n / 5));
      const spans = r() < 0.3 ? Array.from({ length: 1 + Math.floor(r() * 3) }, (_, k) => ({ span_id: `${tenant}-${seed}-${i}-${k}`, trace_id: `${tenant}-${i}`, name: 'call', kind: 'LLM', status_code: r() < 0.4 ? 'ERROR' : 'OK', start_time: new Date(BASE + minute * 60_000).toISOString() })) : undefined;
      traces.push({
        trace_id: `${tenant}-${i}`,
        agent_name: agent,
        framework: r() < 0.2 ? undefined : ['langchain', 'autogen', 'crewai'][Math.floor(r() * 3)],
        output: 'An answer.',
        latency_ms: Math.floor(r() * 1000),
        cost_usd: r() < 0.2 ? undefined : Math.round(r() * 1000) / 1e5,
        timestamp: new Date(BASE + minute * 60_000).toISOString(),
        ...(spans ? { spans } : {}),
      } as Trace);
    }
    await store.insertTraces(tenant, traces);
    const density = new Map(agents.map((a) => [a, DENSITIES[Math.floor(r() * DENSITIES.length)]]));
    for (const t of traces) {
      if (r() >= (density.get(t.agent_name) ?? 0)) continue;
      const times = r() < 0.15 ? 2 : 1;
      for (let k = 0; k < times; k++) {
        evalClock += 1;
        await store.insertEvalResult(tenant, {
          id: `${t.trace_id}-e${k}`,
          trace_id: t.trace_id,
          eval_type: 'completeness',
          output_text: 'x',
          score: r(),
          passed: r() < 0.5,
          rule_results: RULES.filter(() => r() < 0.6).map((ruleName) => ({ ruleName, passed: r() < 0.5, score: 0, message: '', ...(r() < 0.1 ? { skipped: true } : {}) })),
          created_at: new Date(BASE + evalClock * 1000).toISOString(),
          ...(r() < 0.2 ? { run_id: `run-${Math.floor(r() * 3)}` } : {}),
        });
      }
    }
  }
  return { agents: [...agents, 'nobody'] };
}

/** The failure log as the plain query read it before #711, collapsed the same way. */
function plainFailureLog(db: Driver, tenant: TenantId, agent: string, limit: number): AgentFailureLogEntry[] {
  const rows = db
    .prepare(
      `SELECT e.rule_results AS rule_results, e.run_id AS run_id, t.trace_id AS trace_id, t.timestamp AS timestamp, t.cost_usd AS cost_usd
         FROM eval_results e JOIN traces t ON t.trace_id = e.trace_id AND t.tenant_id = e.tenant_id
        WHERE e.tenant_id = ? AND t.agent_name = ?
        ORDER BY t.timestamp DESC, e.created_at DESC LIMIT ?`,
    )
    .all(tenant, agent, limit) as Array<{ rule_results: string | null; run_id: string | null; trace_id: string; timestamp: string; cost_usd: number | null }>;
  const seen = new Set<string>();
  const out: AgentFailureLogEntry[] = [];
  for (const row of rows) {
    if (seen.has(row.trace_id)) continue;
    seen.add(row.trace_id);
    const results = parseRuleResults<{ ruleName: string; passed: boolean; skipped?: boolean }>(row.rule_results);
    out.push({
      traceId: row.trace_id,
      timestamp: row.timestamp,
      failed: results.filter((x) => x.skipped !== true && x.passed === false).map((x) => x.ruleName).sort(),
      costUsd: typeof row.cost_usd === 'number' && Number.isFinite(row.cost_usd) ? row.cost_usd : null,
      judged: results.filter((x) => x.skipped !== true).map((x) => x.ruleName).sort(),
      runId: row.run_id ?? null,
    });
  }
  return out;
}

/** Which of the failure log's ways a call took, from the statements it ran. */
function branchesOf(db: Driver, call: () => Promise<unknown>): Promise<string[]> {
  const prepare = db.prepare;
  const taken: string[] = [];
  db.prepare = (sql: string): Statement => {
    const st = prepare.call(db, sql);
    const record =
      (method: keyof Statement) =>
      (...params: unknown[]) => {
        if (/FROM eval_results e INDEXED BY/.test(sql) && method === 'all') taken.push('by evaluation');
        if (/FROM traces t INDEXED BY idx_traces_tenant_agent_timestamp/.test(sql) && method === 'all') taken.push(params[2] === '' ? 'by trace, whole' : 'by trace, window');
        return st[method](...params);
      };
    return { run: record('run'), get: record('get'), all: record('all') } as Statement;
  };
  return call().then(
    () => {
      db.prepare = prepare;
      return taken;
    },
    (err) => {
      db.prepare = prepare;
      throw err;
    },
  );
}

const DRIVERS: Array<'native' | 'node'> = ['native', ...(nodeSqliteAvailable() ? (['node'] as const) : [])];
const SEEDS = Array.from({ length: 12 }, (_, i) => 7919 * (i + 1));
const LIMITS = [1, 2, 3, 7, 25, 500];

describe.each(DRIVERS)('on %s', (driver) => {
  it('the failure log is the plain query, on every store, agent and limit, through every branch', async () => {
    const branches = new Map<string, number>();
    for (const seed of SEEDS) {
      const dir = mkdtempSync(join(tmpdir(), 'iris-equiv-'));
      dirs.push(dir);
      const store = new SqliteAdapter(join(dir, 'iris.db'), { driver });
      await store.initialize();
      try {
        const { agents } = await seedRandom(store, seed);
        const db = (store as unknown as { db: Driver }).db;
        for (const tenant of [LOCAL_TENANT, OTHER]) {
          for (const agent of agents) {
            for (const limit of LIMITS) {
              let got: AgentFailureLogEntry[] = [];
              const taken = await branchesOf(db, async () => {
                got = await store.getAgentFailureLog(tenant, agent, limit);
              });
              for (const b of taken) branches.set(b, (branches.get(b) ?? 0) + 1);
              expect(got, `seed ${seed}, ${tenant}, ${agent}, limit ${limit}, via ${taken.join(' → ')}`).toEqual(plainFailureLog(db, tenant, agent, limit));
            }
          }
        }
      } finally {
        await store.close();
      }
    }
    expect([...branches.keys()].sort()).toEqual(['by evaluation', 'by trace, whole', 'by trace, window']);
  });

  it('the filter lists, the summary and the eval stats are the plain queries', async () => {
    for (const seed of SEEDS.slice(0, 6)) {
      const dir = mkdtempSync(join(tmpdir(), 'iris-equiv-'));
      dirs.push(dir);
      const store = new SqliteAdapter(join(dir, 'iris.db'), { driver });
      await store.initialize();
      try {
        await seedRandom(store, seed);
        const db = (store as unknown as { db: Driver }).db;
        for (const tenant of [LOCAL_TENANT, OTHER]) {
          for (const column of ['agent_name', 'framework'] as const) {
            const plain = (db.prepare(`SELECT DISTINCT ${column} AS v FROM traces WHERE tenant_id = ? AND ${column} IS NOT NULL ORDER BY ${column}`).all(tenant) as Array<{ v: string }>).map((x) => x.v);
            expect(await store.getDistinctValues(tenant, column), `seed ${seed}, ${column}`).toEqual(plain);
          }
          for (const hours of [1, 24 * 3, 24 * 365]) {
            const got = await store.getDashboardSummary(tenant, hours);
            const since = new Date(Date.now() - hours * 3600_000).toISOString();
            const stats = db.prepare('SELECT COUNT(*) AS n, COALESCE(AVG(latency_ms), 0) AS l, COALESCE(SUM(cost_usd), 0) AS c FROM traces WHERE tenant_id = ? AND timestamp >= ?').get(tenant, since) as { n: number; l: number; c: number };
            const errors = (db.prepare("SELECT COUNT(DISTINCT t.trace_id) AS n FROM traces t JOIN spans s ON s.tenant_id = t.tenant_id AND s.trace_id = t.trace_id WHERE t.tenant_id = ? AND t.timestamp >= ? AND s.status_code = 'ERROR'").get(tenant, since) as { n: number }).n;
            const perHour = db.prepare("SELECT strftime('%Y-%m-%dT%H:00:00', timestamp) AS hour, COUNT(*) AS count FROM traces WHERE tenant_id = ? AND timestamp >= ? GROUP BY hour ORDER BY hour").all(tenant, since);
            const agents = (db.prepare('SELECT agent_name, COUNT(*) AS count FROM traces WHERE tenant_id = ? AND timestamp >= ? GROUP BY agent_name').all(tenant, since) as Array<{ agent_name: string; count: number }>).sort((a, b) => b.count - a.count || a.agent_name.localeCompare(b.agent_name));
            const where = `seed ${seed}, ${tenant}, ${hours} h`;
            expect(got.total_traces, where).toBe(stats.n);
            expect(got.avg_latency_ms, where).toBe(Math.round(stats.l * 100) / 100);
            expect(got.total_cost_usd, where).toBe(Math.round(stats.c * 10000) / 10000);
            expect(got.error_rate, where).toBe(stats.n > 0 ? errors / stats.n : 0);
            expect(got.traces_per_hour, where).toEqual(perHour);
            // The top ten by count; ties at the tenth place may come in either order, so compare counts and the agents above the tie.
            expect(got.top_agents.map((a) => a.count), where).toEqual(agents.slice(0, 10).map((a) => a.count));
            expect(new Set(got.top_agents.map((a) => a.agent_name)).size, where).toBe(got.top_agents.length);
            for (const a of got.top_agents) expect(agents.find((x) => x.agent_name === a.agent_name)?.count, where).toBe(a.count);
          }
        }
      } finally {
        await store.close();
      }
    }
  });
});
