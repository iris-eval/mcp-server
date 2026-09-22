/*
 * A pinned baseline (arc 9, N-14): PATCH /api/v1/runs/:id pins one run per
 * tenant; the listing carries the flag; a comparison with `before` omitted
 * runs against it, and says how to pin one when none is; the comparison
 * answer lists its discordant cases.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../../../src/dashboard/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { createLogger } from '../../../../src/utils/logger.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';

describe('PATCH /api/v1/runs/:id — the baseline', () => {
  let storage: SqliteAdapter;
  let server: Server;
  let base = '';

  const json = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  beforeEach(async () => {
    storage = new SqliteAdapter(':memory:');
    await storage.initialize();
    const config = structuredClone(defaultConfig);
    config.dashboard.port = 0;
    config.dashboard.host = '127.0.0.1';
    config.logging.level = 'error';
    server = createDashboardServer(storage, config, createLogger(config), {}).start();
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1`;

    // Two runs over the same four cases: 'a' fails c3; 'b' fails c2 and c3.
    const outcomes: Record<string, boolean[]> = { a: [true, true, false, true], b: [true, false, false, true] };
    for (const [run, passes] of Object.entries(outcomes)) {
      for (let i = 0; i < passes.length; i++) {
        const traceId = `${run}-c${i + 1}`;
        await storage.insertTrace(LOCAL_TENANT, {
          trace_id: traceId,
          agent_name: 'support-bot',
          framework: 'mcp',
          input: `case ${i + 1}`,
          output: passes[i] ? 'A full answer with enough words to pass the length rule.' : 'short',
          run_id: run,
          case_key: `c${i + 1}`,
          timestamp: new Date(Date.UTC(2026, 8, 1, 0, i)).toISOString(),
        });
        await storage.insertEvalResult(LOCAL_TENANT, {
          id: `${run}-e${i + 1}`,
          trace_id: traceId,
          run_id: run,
          eval_type: 'completeness',
          output_text: passes[i] ? 'A full answer with enough words to pass the length rule.' : 'short',
          score: passes[i] ? 1 : 0,
          passed: passes[i],
          rule_results: [{ ruleName: 'min_output_length', passed: passes[i], score: passes[i] ? 1 : 0, message: passes[i] ? 'OK' : 'too short' }],
        });
      }
    }
  });

  afterEach(async () => {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
  });

  it('pins one run per tenant, the listing carries the flag, and pinning another unpins the first', async () => {
    expect(await json('PATCH', '/runs/a', { baseline: true })).toEqual({ status: 200, body: { run_id: 'a', baseline: true } });
    let runs = ((await json('GET', '/runs')).body.runs as Array<{ runId: string; baseline: boolean }>);
    expect(Object.fromEntries(runs.map((r) => [r.runId, r.baseline]))).toEqual({ a: true, b: false });
    expect((await json('GET', '/runs/a')).body.run).toMatchObject({ runId: 'a', baseline: true });

    expect((await json('PATCH', '/runs/b', { baseline: true })).status).toBe(200);
    runs = ((await json('GET', '/runs')).body.runs as Array<{ runId: string; baseline: boolean }>);
    expect(Object.fromEntries(runs.map((r) => [r.runId, r.baseline]))).toEqual({ a: false, b: true });
    expect(await storage.getBaselineRun(LOCAL_TENANT)).toBe('b');

    expect((await json('PATCH', '/runs/b', { baseline: false })).body).toEqual({ run_id: 'b', baseline: false });
    expect(await storage.getBaselineRun(LOCAL_TENANT)).toBeNull();
  });

  it('refuses an unknown run with 404 and a misspelled body with 400', async () => {
    expect((await json('PATCH', '/runs/nope', { baseline: true })).status).toBe(404);
    const bad = await json('PATCH', '/runs/a', { basline: true });
    expect(bad.status).toBe(400);
  });

  it('a comparison with before omitted runs against the pinned baseline, and says how to pin one when none is', async () => {
    const none = await json('POST', '/compare', { after: 'b' });
    expect(none.status).toBe(400);
    expect(String(none.body.error)).toMatch(/No run is pinned as the baseline/);
    expect(JSON.stringify(none.body.recovery)).toMatch(/PATCH \/api\/v1\/runs\/:id/);

    await json('PATCH', '/runs/a', { baseline: true });
    const cmp = await json('POST', '/compare', { after: 'b' });
    expect(cmp.status).toBe(200);
    expect((cmp.body.before as { run_id: string }).run_id).toBe('a');
    expect((cmp.body.after as { run_id: string }).run_id).toBe('b');
    expect(cmp.body.method).toBe('paired-mcnemar');
  });

  it('the answer lists the discordant cases with both evaluations and the rule that flipped', async () => {
    const cmp = await json('POST', '/compare', { before: 'a', after: 'b' });
    expect(cmp.status).toBe(200);
    expect(cmp.body.discordant_total).toBe(1);
    expect(cmp.body.discordant).toEqual([
      {
        case_key: 'c2',
        before: { eval_id: 'a-e2', trace_id: 'a-c2', passed: true },
        after: { eval_id: 'b-e2', trace_id: 'b-c2', passed: false },
        direction: 'regressed',
        rules: [{ rule: 'min_output_length', before: true, after: false }],
      },
    ]);
  });
});
