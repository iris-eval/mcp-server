/*
 * GET /moments?sort_by=significance — Decision Moments ranked by what they
 * found, within a stated window (#409).
 *
 * Newest first, the only order before 0.20.0, puts a safety violation from
 * two hours ago behind every pass since. The fixture is one agent's 240
 * evaluated traces, a minute apart: a routine failure every twelfth trace,
 * and three moments a reader needs to see —
 *
 *   #30   a safety rule failed          (severity:  safety-violation 1.0)
 *   #90   ten times the agent's cost    (change:    cost-spike 0.9)
 *   #150  a rule failed for the first   (rarity:    first-failure 0.8)
 *         time on this agent
 *
 * Newest first shows them at positions 210, 150 and 90 of 240. Ranked by
 * significance they are 1, 2 and 3. Everything runs through the real
 * dashboard server, SQLite storage and classifier.
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

const SAFETY = 30;
const COST_SPIKE = 90;
const FIRST_FAILURE = 150;
const SIGNIFICANT = [SAFETY, COST_SPIKE, FIRST_FAILURE].map(id);
const routineFail = (i: number): boolean => i % 12 === 3;

const rule = (ruleName: string, passed: boolean): EvalRuleResult => ({ ruleName, passed, score: passed ? 1 : 0, message: passed ? 'ok' : 'failed' });

describe('Decision Moments ranked by significance', () => {
  let storage: SqliteAdapter;
  let server: Server;
  let port = 0;

  async function seed(i: number): Promise<void> {
    const rules = [rule('min_output_length', !routineFail(i)), rule('keyword_overlap', i !== FIRST_FAILURE)];
    if (i === SAFETY) rules.push(rule('no_pii', false));
    const passed = rules.every((r) => r.passed);
    await storage.insertTrace(LOCAL_TENANT, {
      trace_id: id(i),
      agent_name: 'support-bot',
      input: 'ask',
      output: 'answer',
      timestamp: ts(i),
      // A small spread so the cost baseline has a non-zero MAD.
      cost_usd: i === COST_SPIKE ? 0.05 : 0.002 + (i % 7) * 0.0001,
    });
    await storage.insertEvalResult(LOCAL_TENANT, {
      id: `e-${id(i)}`,
      trace_id: id(i),
      eval_type: i === SAFETY ? 'safety' : 'completeness',
      output_text: 'answer',
      score: passed ? 1 : 0.5,
      passed,
      rule_results: rules,
      created_at: ts(i),
    });
  }

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    for (let i = 0; i < N; i += 1) await seed(i);
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

  const get = async (qs: string): Promise<{ status: number; body: MomentQueryResult & { error?: string; details?: unknown } }> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/moments?${qs}`);
    return { status: res.status, body: (await res.json()) as MomentQueryResult & { error?: string } };
  };
  /** 1-based positions of the three significant moments in a full ordering. */
  const positions = (moments: MomentQueryResult['moments']): number[] =>
    SIGNIFICANT.map((sid) => moments.findIndex((m) => m.id === sid) + 1);

  it('the classifier labels the fixture as designed', async () => {
    const { body } = await get('sort_by=significance&limit=200&window=240');
    const kinds = Object.fromEntries(body.moments.map((m) => [m.id, m.significance.kind]));
    expect(kinds[id(SAFETY)]).toBe('safety-violation');
    expect(kinds[id(COST_SPIKE)]).toBe('cost-spike');
    expect(kinds[id(FIRST_FAILURE)]).toBe('first-failure');
    // Nothing else in the fixture is more than a routine fail or a pass.
    const others = body.moments.filter((m) => !SIGNIFICANT.includes(m.id)).map((m) => m.significance.kind);
    expect(new Set(others)).toEqual(new Set(['normal-fail', 'normal-pass']));
  });

  it('beats newest first: the three moments that matter are 1, 2 and 3 instead of 210, 150 and 90', async () => {
    const newest = [...(await get('limit=200')).body.moments, ...(await get('limit=200&offset=200')).body.moments];
    expect(newest).toHaveLength(N);
    expect(positions(newest)).toEqual([210, 150, 90]);
    // The first page a reader sees, newest first: none of them.
    expect(newest.slice(0, 10).filter((m) => SIGNIFICANT.includes(m.id))).toHaveLength(0);

    const ranked = await get('sort_by=significance&limit=10');
    expect(ranked.status).toBe(200);
    expect(ranked.body.moments.slice(0, 3).map((m) => m.id)).toEqual(SIGNIFICANT);
    expect(ranked.body.moments.slice(0, 3).map((m) => m.significance.score)).toEqual([1, 0.9, 0.8]);
    // Below them, routine failures newest first, before any pass.
    const rest = ranked.body.moments.slice(3);
    expect(rest.every((m) => m.significance.kind === 'normal-fail')).toBe(true);
    expect(rest.map((m) => m.timestamp)).toEqual([...rest.map((m) => m.timestamp)].sort().reverse());
  });

  it('states the window, and total is exact within it', async () => {
    const { body } = await get('sort_by=significance&limit=10');
    expect(body.sortBy).toBe('significance');
    expect(body.window).toEqual({ size: 500, scanned: N, tracesInRange: N, newest: ts(N - 1), oldest: ts(0) });
    expect(body.total).toBe(N);

    const kind = await get('sort_by=significance&significance_kind=normal-fail&limit=200');
    const expected = Array.from({ length: N }, (_, i) => i).filter((i) => routineFail(i) && i !== SAFETY).length;
    expect(kind.body.total).toBe(expected);
    expect(kind.body.moments).toHaveLength(expected);
  });

  it('a smaller window ranks only the newest traces, and says how far it reached', async () => {
    const { body } = await get('sort_by=significance&window=100&limit=5');
    expect(body.window).toEqual({ size: 100, scanned: 100, tracesInRange: N, newest: ts(N - 1), oldest: ts(N - 100) });
    expect(body.total).toBe(100);
    // #150 is inside the newest 100; #30 and #90 are not.
    expect(body.moments[0].id).toBe(id(FIRST_FAILURE));
    expect(body.moments.map((m) => m.id)).not.toContain(id(SAFETY));
  });

  it('pages consistently: page after page is one ranking, cut, with no repeats and no gaps', async () => {
    const whole = (await get('sort_by=significance&limit=200')).body.moments.map((m) => m.id);
    const paged: string[] = [];
    for (let offset = 0; offset < 200; offset += 25) {
      paged.push(...(await get(`sort_by=significance&limit=25&offset=${offset}`)).body.moments.map((m) => m.id));
    }
    expect(paged).toEqual(whole);
    expect(new Set(paged).size).toBe(200);
  });

  it('pinning until to window.newest keeps page two on the same ranking while new traces arrive', async () => {
    const first = (await get('sort_by=significance&limit=20')).body;
    // A newer safety violation lands between the two page reads.
    await storage.insertTrace(LOCAL_TENANT, { trace_id: 'late', agent_name: 'support-bot', input: 'ask', output: 'answer', timestamp: ts(N + 5), cost_usd: 0.002 });
    await storage.insertEvalResult(LOCAL_TENANT, {
      id: 'e-late', trace_id: 'late', eval_type: 'safety', output_text: 'answer', score: 0, passed: false,
      rule_results: [rule('no_pii', false)], created_at: ts(N + 5),
    });
    const pinned = (await get(`sort_by=significance&limit=20&offset=20&until=${encodeURIComponent(first.window!.newest!)}`)).body;
    const unpinnedWhole = (await get(`sort_by=significance&limit=40&until=${encodeURIComponent(first.window!.newest!)}`)).body;
    expect([...first.moments, ...pinned.moments].map((m) => m.id)).toEqual(unpinnedWhole.moments.map((m) => m.id));
    // Unpinned, the new violation moves to the top and shifts every page.
    const live = (await get('sort_by=significance&limit=1')).body;
    expect(live.moments[0].id).toBe('late');
  });

  it('newest first is unchanged: no sortBy, no window, total counts traces', async () => {
    const { body } = await get('limit=5');
    expect(body.sortBy).toBeUndefined();
    expect(body.window).toBeUndefined();
    expect(body.moments.map((m) => m.id)).toEqual([239, 238, 237, 236, 235].map(id));
    expect(body.total).toBe(N);
  });

  it('refuses parameters that would do nothing, and a window past the bound', async () => {
    expect((await get('window=100')).status).toBe(400);
    expect(JSON.stringify((await get('window=100')).body)).toContain('window applies only to sort_by=significance');
    expect((await get('sort_by=significance&sort_order=asc')).status).toBe(400);
    expect((await get('sort_by=significance&window=501')).status).toBe(400);
    expect((await get('sort_by=significance&window=0')).status).toBe(400);
    expect((await get('sort_by=newest')).status).toBe(400);
    // sort_order still works for the order it belongs to.
    const asc = (await get('sort_order=asc&limit=1')).body;
    expect(asc.moments[0].id).toBe(id(0));
  });
});
