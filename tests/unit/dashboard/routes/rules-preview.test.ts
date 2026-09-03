/*
 * Rule-preview 422 regression test.
 *
 * The preview route promised "Rule definition rejected" (422) for
 * uncompilable definitions, but the guard checked `!probe.skipped` while
 * custom.ts routes EVERY compile/config failure through configError() —
 * which sets skipped:true. The 422 was unreachable: an invalid or
 * ReDoS-rejected pattern came back 200 with "wouldSkip: N", telling the
 * author their rule was fine and their traces were odd.
 *
 * The fix marks config failures with configInvalid, which the probe now
 * checks. These tests hit the REAL route with the REAL rule compiler —
 * only storage is stubbed.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { registerRuleRoutes } from '../../../../src/dashboard/routes/rules.js';
import { createTenantMiddleware } from '../../../../src/middleware/tenant.js';
import type { CustomRuleStore } from '../../../../src/custom-rule-store.js';
import type { EvalEngine } from '../../../../src/eval/engine.js';
import type { IStorageAdapter } from '../../../../src/types/query.js';
import type { Trace } from '../../../../src/types/trace.js';

const traces: Trace[] = [
  {
    trace_id: 't1',
    agent_name: 'agent-a',
    input: 'in',
    output: 'hello world',
    timestamp: new Date().toISOString(),
  },
  {
    trace_id: 't2',
    agent_name: 'agent-a',
    input: 'in',
    output: 'ERROR: something broke',
    timestamp: new Date().toISOString(),
  },
  {
    // No output — the preview must count this as a legitimate skip.
    trace_id: 't3',
    agent_name: 'agent-b',
    input: 'in',
    timestamp: new Date().toISOString(),
  },
];

// Preview never touches the store or engine; storage only needs queryTraces.
const stubStore = {} as unknown as CustomRuleStore;
const stubEngine = {} as unknown as EvalEngine;
const stubStorage = {
  queryTraces: async () => ({ traces, total: traces.length }),
} as unknown as IStorageAdapter;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(createTenantMiddleware());
  const router = express.Router();
  registerRuleRoutes(router, stubStorage, {
    customRuleStore: stubStore,
    evalEngine: stubEngine,
  });
  app.use('/api/v1', router);
  return app;
}

async function preview(
  definition: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = makeApp();
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}/api/v1/rules/custom/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition, ...extra }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

/*
 * deploy_rule's description has always said to use this endpoint "for
 * dry-run validation against sample output". The endpoint accepted
 * `sampleOutput` and ignored it (#373 item 2) — a caller got the
 * historical replay only, with no sign their sample was never read.
 */
describe('POST /rules/custom/preview — sampleOutput', () => {
  it('judges the sample and reports the verdict alongside the replay', async () => {
    const def = { name: 'find-errors', type: 'regex_match', config: { pattern: 'ERROR' } };
    const miss = await preview(def, { sampleOutput: 'all good here' });
    expect(miss.status).toBe(200);
    expect(miss.body.sample).toMatchObject({ passed: false, skipped: false });
    // The replay still ran — the sample is in addition to it, not instead.
    expect(miss.body.tracesEvaluated).toBe(3);

    const hit = await preview(def, { sampleOutput: 'ERROR: disk full' });
    expect(hit.body.sample).toMatchObject({ passed: true, skipped: false });
  });

  it('reports a skip (with the reason) when the sample cannot be judged', async () => {
    const res = await preview(
      { name: 'cap', type: 'cost_threshold', config: { max_cost: 0.5 } },
      { sampleOutput: 'no cost travels with a bare sample' },
    );
    expect(res.status).toBe(200);
    const sample = res.body.sample as { skipped: boolean; skipReason?: string };
    expect(sample.skipped).toBe(true);
    expect(sample.skipReason).toBeTruthy();
  });

  it('omits `sample` entirely when no sample was sent', async () => {
    const res = await preview({ name: 'find-errors', type: 'regex_match', config: { pattern: 'ERROR' } });
    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('sample');
  });

  it('rejects a misspelled key instead of silently ignoring it, listing the valid ones', async () => {
    const res = await preview(
      { name: 'find-errors', type: 'regex_match', config: { pattern: 'ERROR' } },
      { sampleOutpt: 'typo' },
    );
    expect(res.status).toBe(400);
    const details = JSON.stringify(res.body.details);
    expect(details).toContain('"sampleOutpt"');
    expect(details).toContain('sampleOutput');
  });

  it('rejects a misspelled key one level down, inside definition', async () => {
    const res = await preview({ name: 'x', type: 'min_length', config: { min_length: 5 }, wieght: 2 });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body.details)).toContain('"wieght"');
  });

  it('accepts a definition without a name — the server names it on deploy anyway', async () => {
    const res = await preview({ type: 'regex_match', config: { pattern: 'ERROR' } });
    expect(res.status).toBe(200);
    expect(res.body.wouldFail).toBe(1);
  });
});

describe('POST /rules/custom/preview — definition rejection', () => {
  it('422s an invalid regex instead of 200 "wouldSkip: N"', async () => {
    const res = await preview({ name: 'bad', type: 'regex_match', config: { pattern: '(' } });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Rule definition rejected');
    expect(res.body.message).toMatch(/^Invalid regex syntax/);
  });

  it('422s a ReDoS-rejected pattern', async () => {
    const res = await preview({ name: 'redos', type: 'regex_match', config: { pattern: '(a+)+$' } });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Rule definition rejected');
    expect(res.body.message).toMatch(/^Regex pattern rejected/);
  });

  it('422s a pattern over the length cap', async () => {
    const res = await preview({
      name: 'long',
      type: 'regex_match',
      config: { pattern: 'a'.repeat(1001) },
    });
    expect(res.status).toBe(422);
    expect(res.body.message).toMatch(/^Regex pattern too long/);
  });

  it('422s a non-regex config error (min_length without a minimum)', async () => {
    const res = await preview({ name: 'no-min', type: 'min_length', config: {} });
    expect(res.status).toBe(422);
    expect(res.body.error).toBe('Rule definition rejected');
  });

  it('still previews a valid rule, counting output-less traces as skips', async () => {
    const res = await preview({
      name: 'find-errors',
      type: 'regex_match',
      config: { pattern: 'ERROR' },
    });
    expect(res.status).toBe(200);
    expect(res.body.tracesEvaluated).toBe(3);
    expect(res.body.wouldPass).toBe(1);
    expect(res.body.wouldFail).toBe(1);
    // t3 has no output — a legitimate skip, NOT a definition rejection.
    expect(res.body.wouldSkip).toBe(1);
  });

  it('shares ONE regex budget across the whole preview — a defeated pattern cannot stall per trace', async () => {
    /*
     * The preview loop runs a caller-supplied pattern against up to 5000
     * seedable traces on the main thread. With a fresh budget per trace, a
     * sandbox-defeating pattern×output pair cost ~142ms EACH (~12 min at
     * the cap, one self-serve request). The loop must share one breaker:
     * at most 3 traces pay the budget, the rest skip instantly.
     */
    const hostileTraces: Trace[] = Array.from({ length: 12 }, (_, i) => ({
      trace_id: `h${i}`,
      agent_name: 'agent-h',
      input: 'in',
      output: 'a'.repeat(40) + 'b',
      timestamp: new Date().toISOString(),
    }));
    const app = express();
    app.use(express.json());
    app.use(createTenantMiddleware());
    const router = express.Router();
    registerRuleRoutes(
      router,
      { queryTraces: async () => ({ traces: hostileTraces, total: hostileTraces.length }) } as unknown as IStorageAdapter,
      { customRuleStore: stubStore, evalEngine: stubEngine },
    );
    app.use('/api/v1', router);
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const started = Date.now();
      const res = await fetch(`http://localhost:${addr.port}/api/v1/rules/custom/preview`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // lgtm[js/redos] — intentionally hostile test input
          definition: { name: 'hostile', type: 'regex_match', config: { pattern: '^(a|a)*$' } }, // codeql-suppress js/redos
        }),
      });
      const elapsed = Date.now() - started;
      const body = (await res.json()) as Record<string, unknown>;
      expect(res.status).toBe(200);
      // All 12 hostile traces report wouldSkip; only ~3 paid the budget.
      expect(body.wouldSkip).toBe(12);
      // Per-trace budgets would be ≥12 × ~140ms ≈ 1.7s minimum; the shared
      // breaker caps it at ~3 breaches. Generous bound for slow CI.
      expect(elapsed).toBeLessThan(1500);
    } finally {
      server.close();
    }
  });
});
