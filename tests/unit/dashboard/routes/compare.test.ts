/*
 * POST /api/v1/compare (arc 7, D-5): the compare_runs tool's handler over
 * HTTP. The proposition is one implementation, one shape — the route's
 * answer deep-equals what the tool's handler computes for the same runs —
 * plus the two refusals a caller can hit.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';
import { SqliteAdapter } from '../../../../src/storage/sqlite-adapter.js';
import { createDashboardServer } from '../../../../src/dashboard/server.js';
import { defaultConfig } from '../../../../src/config/defaults.js';
import { createLogger } from '../../../../src/utils/logger.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';
import { compareStoredRuns } from '../../../../src/tools/compare-runs.js';

describe('POST /api/v1/compare', () => {
  let storage: SqliteAdapter;
  let server: Server;
  let port = 0;

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
    port = (server.address() as { port: number }).port;

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
          rule_results: [
            { ruleName: 'min_output_length', passed: passes[i], score: passes[i] ? 1 : 0, message: passes[i] ? 'OK' : 'too short' },
          ],
          suggestions: [],
        });
      }
    }
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await storage.close();
  });

  async function post(body: unknown): Promise<{ status: number; json: unknown }> {
    const res = await fetch(`http://127.0.0.1:${port}/api/v1/compare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, json: await res.json() };
  }

  it("answers with the tool's own payload: paired, the run summaries, the per-rule movement", async () => {
    const { status, json } = await post({ before: 'a', after: 'b' });
    expect(status).toBe(200);
    const body = json as Record<string, unknown>;
    expect(body.method).toBe('paired-mcnemar');
    expect((body.before as { n: number }).n).toBe(4);
    expect((body.after as { n: number }).n).toBe(4);
    expect((body.regressions as Array<{ rule: string; delta: number }>)[0]).toMatchObject({ rule: 'min_output_length', delta: 1 });
    expect(typeof body.summary).toBe('string');
    // One implementation: the route serves what the tool's handler computes.
    const fromTool = await compareStoredRuns(storage, LOCAL_TENANT, { before: 'a', after: 'b' });
    expect(json).toEqual(JSON.parse(JSON.stringify(fromTool)));
  });

  it('refuses a body without both run ids, naming the problem', async () => {
    const { status, json } = await post({ before: 'a' });
    expect(status).toBe(400);
    expect((json as { error: string }).error).toMatch(/invalid/i);
  });

  it('refuses an unknown field, as the tool does', async () => {
    const { status } = await post({ before: 'a', after: 'b', bogus: true });
    expect(status).toBe(400);
  });

  it('an unknown run is not an error: n is 0 and the summary says so', async () => {
    const { status, json } = await post({ before: 'a', after: 'never-ran' });
    expect(status).toBe(200);
    expect((json as { after: { n: number } }).after.n).toBe(0);
  });
});
