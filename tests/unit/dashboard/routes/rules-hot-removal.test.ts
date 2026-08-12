/*
 * Hot-removal regression test for DELETE /rules/custom/:id (#332).
 *
 * delete_rule's description promises the rule "stops firing immediately
 * on the live process", but the dashboard delete route used to only
 * rewrite the store file — the engine kept the registered rule until the
 * next restart. This test drives the REAL route against a REAL store and
 * a REAL engine: deploy via POST (which registers with the engine), prove
 * the rule fires, DELETE it, prove the very next evaluate no longer runs
 * it. No restart in between.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRuleRoutes } from '../../../../src/dashboard/routes/rules.js';
import { createTenantMiddleware } from '../../../../src/middleware/tenant.js';
import { createCustomRuleStore } from '../../../../src/custom-rule-store.js';
import { EvalEngine } from '../../../../src/eval/engine.js';
import type { IStorageAdapter } from '../../../../src/types/query.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-rule-hot-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp(evalEngine: EvalEngine) {
  const store = createCustomRuleStore({
    pathFor: () => join(tmpDir, 'custom-rules.json'),
    auditPath: join(tmpDir, 'audit.log'),
  });
  const app = express();
  app.use(express.json());
  app.use(createTenantMiddleware());
  const router = express.Router();
  registerRuleRoutes(router, {} as unknown as IStorageAdapter, {
    customRuleStore: store,
    evalEngine,
  });
  app.use('/api/v1', router);
  return app;
}

async function request(
  app: express.Express,
  method: 'POST' | 'DELETE',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : null };
  } finally {
    server.close();
  }
}

describe('DELETE /rules/custom/:id — engine hot-removal', () => {
  it('deleted rule stops firing on the live engine, no restart needed', async () => {
    const engine = new EvalEngine(0.7);
    const app = makeApp(engine);

    const deployed = await request(app, 'POST', '/api/v1/rules/custom', {
      name: 'hot-removal-canary',
      evalType: 'completeness',
      definition: {
        name: 'hot-removal-canary',
        type: 'contains_keywords',
        config: { keywords: ['canary'] },
      },
    });
    expect(deployed.status).toBe(201);
    const ruleId = (deployed.json as { rule: { id: string } }).rule.id;

    const context = { output: 'A canary sentence long enough to evaluate cleanly.' };
    const before = engine.evaluate('completeness', context);
    expect(
      before.rule_results.find((r) => r.ruleName === 'hot-removal-canary'),
    ).toBeDefined();

    const removed = await request(app, 'DELETE', `/api/v1/rules/custom/${ruleId}`);
    expect(removed.status).toBe(204);

    const after = engine.evaluate('completeness', context);
    expect(
      after.rule_results.find((r) => r.ruleName === 'hot-removal-canary'),
    ).toBeUndefined();
  });

  it('deleting an unknown id still 404s without touching the engine', async () => {
    const engine = new EvalEngine(0.7);
    const app = makeApp(engine);
    const res = await request(app, 'DELETE', '/api/v1/rules/custom/rule-doesnotexist');
    expect(res.status).toBe(404);
  });
});
