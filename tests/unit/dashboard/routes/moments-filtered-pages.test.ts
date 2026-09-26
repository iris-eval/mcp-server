/*
 * GET /moments with a verdict or significance filter pages within a stated
 * window (#657).
 *
 * Until 0.20.0 the newest-first order applied those filters after reading
 * a page of traces, so a filtered page came back short, `offset` counted
 * traces rather than matching moments, and `total` counted traces. The
 * fixture is one agent's 240 traces a minute apart, with a failure every
 * twelfth: 20 failures, the newest at #231. `?verdict=fail&limit=10` used
 * to read the newest 10 traces and return the 1 failure among them.
 *
 * Everything runs through the real dashboard server, SQLite storage and
 * classifier.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../../../src/dashboard/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { createLogger } from '../../../../src/utils/logger.js';
import { EvalEngine } from '../../../../src/eval/engine.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';
import type { EvalRuleResult } from '../../../../src/types/eval.js';
import type { MomentQueryResult } from '../../../../src/types/decision-moment.js';

const N = 240;
const T0 = Date.parse('2026-09-01T00:00:00.000Z');
const ts = (i: number): string => new Date(T0 + i * 60_000).toISOString();
const id = (i: number): string => `t${String(i).padStart(3, '0')}`;
const fails = (i: number): boolean => i % 12 === 3;
const FAILS = Array.from({ length: N }, (_, i) => i).filter(fails);

const rule = (ruleName: string, passed: boolean): EvalRuleResult => ({ ruleName, passed, score: passed ? 1 : 0, message: passed ? 'ok' : 'failed' });

describe('filtered Decision Moments page within a window', () => {
  let storage: SqliteAdapter;
  let server: Server;
  let port = 0;

  async function seed(traceId: string, timestamp: string, passed: boolean): Promise<void> {
    await storage.insertTrace(LOCAL_TENANT, { trace_id: traceId, agent_name: 'support-bot', input: 'ask', output: 'answer', timestamp, cost_usd: 0.002 });
    await storage.insertEvalResult(LOCAL_TENANT, {
      id: `e-${traceId}`,
      trace_id: traceId,
      eval_type: 'completeness',
      output_text: 'answer',
      score: passed ? 1 : 0.5,
      passed,
      rule_results: [rule('min_output_length', passed)],
      created_at: timestamp,
    });
  }

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    for (let i = 0; i < N; i += 1) await seed(id(i), ts(i), !fails(i));
    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    const evalEngine = new EvalEngine(config.eval.defaultThreshold, config.eval.ruleThresholds, config.eval);
    server = createDashboardServer(storage, config, createLogger(config), { evalEngine }).start();
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    port = (server.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
  });

  const get = async (qs: string): Promise<{ status: number; body: MomentQueryResult }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/moments?${qs}`);
    return { status: res.status, body: (await res.json()) as MomentQueryResult };
  };
  const ids = (r: MomentQueryResult) => r.moments.map((m) => m.id);

  it('a filtered page is full, pages neither repeat nor skip, and total is exact', async () => {
    const first = (await get('verdict=fail&limit=10')).body;
    expect(ids(first)).toEqual(FAILS.slice(-10).reverse().map(id));
    expect(first.total).toBe(FAILS.length);
    expect(first.window).toEqual({ size: 500, scanned: N, tracesInRange: N, newest: ts(N - 1), oldest: ts(0) });

    const second = (await get('verdict=fail&limit=10&offset=10')).body;
    expect(ids(second)).toEqual(FAILS.slice(0, 10).reverse().map(id));
    const third = (await get('verdict=fail&limit=10&offset=20')).body;
    expect(third.moments).toEqual([]);
    expect(new Set([...ids(first), ...ids(second)]).size).toBe(FAILS.length);
  });

  it('the significance filters page the same way', async () => {
    const byKind = (await get('significance_kind=normal-fail&limit=7')).body;
    expect(byKind.moments).toHaveLength(7);
    expect(byKind.total).toBe(FAILS.length);
    const byScore = (await get('min_significance=0.4&limit=7&offset=14')).body;
    expect(ids(byScore)).toEqual(FAILS.slice(0, 6).reverse().map(id));
  });

  it('oldest first reads the oldest window and pages through it in order', async () => {
    const r = (await get('verdict=fail&sort_order=asc&window=100&limit=5')).body;
    expect(ids(r)).toEqual(FAILS.slice(0, 5).map(id));
    expect(r.window).toEqual({ size: 100, scanned: 100, tracesInRange: N, newest: ts(99), oldest: ts(0) });
    expect(r.total).toBe(FAILS.filter((i) => i < 100).length);
  });

  it('a smaller window reaches only the newest traces, and says so', async () => {
    const r = (await get('verdict=fail&window=24&limit=50')).body;
    expect(ids(r)).toEqual([231, 219].map(id));
    expect(r.total).toBe(2);
    expect(r.window).toMatchObject({ size: 24, scanned: 24, tracesInRange: N, oldest: ts(N - 24) });
  });

  it('pinning until to window.newest keeps later pages steady while failures arrive', async () => {
    const first = (await get('verdict=fail&limit=10')).body;
    await seed('late', ts(N + 5), false);
    const pinned = (await get(`verdict=fail&limit=10&offset=10&until=${encodeURIComponent(first.window!.newest!)}`)).body;
    expect([...ids(first), ...ids(pinned)]).toEqual([...FAILS].reverse().map(id));
    const live = (await get('verdict=fail&limit=1')).body;
    expect(ids(live)).toEqual(['late']);
  });

  it('unfiltered reads are unchanged: pages of traces, no window', async () => {
    const r = (await get('limit=5&offset=5')).body;
    expect(ids(r)).toEqual([234, 233, 232, 231, 230].map(id));
    expect(r.total).toBe(N);
    expect(r.window).toBeUndefined();
    expect((await get('sort_order=asc&limit=2')).body.moments.map((m) => m.id)).toEqual([id(0), id(1)]);
  });

  it('window is accepted with a filter and still refused without one', async () => {
    expect((await get('verdict=fail&window=50')).status).toBe(200);
    expect((await get('window=50')).status).toBe(400);
    expect((await get('verdict=fail&window=501')).status).toBe(400);
  });
});
