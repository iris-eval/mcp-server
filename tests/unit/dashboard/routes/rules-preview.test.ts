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
): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = makeApp();
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}/api/v1/rules/custom/preview`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ definition }),
    });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  } finally {
    server.close();
  }
}

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
});
