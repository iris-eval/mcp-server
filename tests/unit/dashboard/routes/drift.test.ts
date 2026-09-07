/*
 * GET /eval-stats/drift — the numbers that turn a delta into a finding.
 *
 * The Drift view has always shown a raw delta: "pass rate down 6 points".
 * With eleven evaluations on one side that sentence is noise wearing the
 * clothes of a finding, and nothing on screen said which it was. This route
 * carries both denominators, the interval, and — when the interval cannot
 * exclude zero — the smallest change that much data could have detected.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../../../src/dashboard/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { createLogger } from '../../../../src/utils/logger.js';
import { EvalEngine } from '../../../../src/eval/engine.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';

interface DriftBody {
  current: { evaluated: number; passed: number; passRate: number | null };
  prior: { evaluated: number; passed: number; passRate: number | null };
  difference: { delta: number; lo: number; hi: number; significant: boolean } | null;
  enoughEvidence: boolean;
  minimumPerWindow: number;
  smallestDetectable: number | null;
}

describe('the drift comparison', () => {
  let storage: SqliteAdapter;
  let server: Server;
  let port = 0;

  const daysAgo = (n: number): string => new Date(Date.now() - n * 86_400_000).toISOString();

  /** Write one evaluated trace at a given age, passing or not. */
  const seed = async (id: string, ageDays: number, passed: boolean): Promise<void> => {
    const ts = daysAgo(ageDays);
    await storage.insertTrace(LOCAL_TENANT, {
      trace_id: id,
      agent_name: 'runner',
      input: 'ask',
      output: 'answer',
      timestamp: ts,
    });
    await storage.insertEvalResult(LOCAL_TENANT, {
      id: `e-${id}`,
      trace_id: id,
      eval_type: 'all',
      output_text: 'answer',
      score: passed ? 0.9 : 0.1,
      passed,
      rule_results: [],
      suggestions: [],
      created_at: ts,
    });
  };

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
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

  const drift = async (qs = ''): Promise<DriftBody> => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/eval-stats/drift${qs}`);
    expect(res.status).toBe(200);
    return (await res.json()) as DriftBody;
  };

  it('withholds a direction when either window is too small to mean anything', async () => {
    // Three vs three. The interval would correctly refuse to call this
    // significant, but "pass rate down 33 points" printed above a chart
    // lands as a finding no matter what the caveat beside it says.
    for (const i of [1, 2, 3]) await seed(`c${i}`, 2, i === 1);
    for (const i of [1, 2, 3]) await seed(`p${i}`, 9, true);

    const body = await drift('?period=7d');
    expect(body.enoughEvidence).toBe(false);
    expect(body.difference).toBeNull();
    // The reason is reported, so the view never has to guess why.
    expect(body.minimumPerWindow).toBeGreaterThan(3);
    expect(body.current.evaluated).toBe(3);
    expect(body.prior.evaluated).toBe(3);
  });

  it('reports both denominators, always', async () => {
    for (let i = 0; i < 12; i += 1) await seed(`c${i}`, 2, i < 6);
    for (let i = 0; i < 12; i += 1) await seed(`p${i}`, 9, true);

    const body = await drift('?period=7d');
    expect(body.current).toMatchObject({ evaluated: 12, passed: 6, passRate: 0.5 });
    expect(body.prior).toMatchObject({ evaluated: 12, passed: 12, passRate: 1 });
  });

  it('calls a real drop significant, with an interval that excludes zero', async () => {
    for (let i = 0; i < 20; i += 1) await seed(`c${i}`, 2, i < 4);   // 20% pass
    for (let i = 0; i < 20; i += 1) await seed(`p${i}`, 9, true);    // 100% pass

    const body = await drift('?period=7d');
    expect(body.enoughEvidence).toBe(true);
    expect(body.difference?.significant).toBe(true);
    expect(body.difference!.delta).toBeCloseTo(-0.8, 5);
    expect(body.difference!.hi).toBeLessThan(0);
    // Significant, so there is nothing to say about what was undetectable.
    expect(body.smallestDetectable).toBeNull();
  });

  it('says how much a tie could not have seen, rather than shrugging', async () => {
    for (let i = 0; i < 12; i += 1) await seed(`c${i}`, 2, i < 6);
    for (let i = 0; i < 12; i += 1) await seed(`p${i}`, 9, i < 6);

    const body = await drift('?period=7d');
    expect(body.enoughEvidence).toBe(true);
    expect(body.difference?.significant).toBe(false);
    expect(body.smallestDetectable).toBeGreaterThan(0);
  });

  it('reports an empty window as unknown, not as a rate of zero', async () => {
    const body = await drift('?period=24h');
    expect(body.current.evaluated).toBe(0);
    // "0 of 0" is unknown. A window reporting 0 would draw a cliff.
    expect(body.current.passRate).toBeNull();
    expect(body.difference).toBeNull();
  });

  it('narrows both windows to a run, never one of them', async () => {
    for (let i = 0; i < 12; i += 1) {
      const ts = daysAgo(2);
      await storage.insertTrace(LOCAL_TENANT, {
        trace_id: `r${i}`,
        agent_name: 'runner',
        input: 'ask',
        output: 'answer',
        timestamp: ts,
        run_id: 'nightly',
      });
      await storage.insertEvalResult(LOCAL_TENANT, {
        id: `er${i}`, trace_id: `r${i}`, eval_type: 'all', output_text: 'a',
        score: 0.9, passed: true, rule_results: [], suggestions: [], created_at: ts,
      });
    }
    for (let i = 0; i < 12; i += 1) await seed(`x${i}`, 2, false); // no run

    const all = await drift('?period=7d');
    const scoped = await drift('?period=7d&run=nightly');
    expect(all.current.evaluated).toBe(24);
    expect(scoped.current.evaluated).toBe(12);
    expect(scoped.current.passed).toBe(12);
  });

  it('rejects a period it does not know', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/eval-stats/drift?period=forever`);
    expect(res.status).toBe(400);
  });
});
