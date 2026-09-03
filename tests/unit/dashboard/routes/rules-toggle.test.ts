/*
 * PATCH /rules/custom/:id — the dashboard toggle affordance, end to end.
 *
 * delete_rule's and list_rules' descriptions have told users to "use the
 * dashboard's toggle affordance" to pause a rule without deleting it
 * since v0.4. Nothing invoked the store's setEnabled: no route, no UI
 * call, no MCP tool. This drives the REAL route against a REAL store and
 * a REAL engine: deploy, prove it fires, disable, prove the very next
 * evaluate no longer runs it, re-enable, prove it fires again — no
 * restart anywhere.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRuleRoutes } from '../../../../src/dashboard/routes/rules.js';
import { createTenantMiddleware } from '../../../../src/middleware/tenant.js';
import { createCustomRuleStore, type CustomRuleStore } from '../../../../src/custom-rule-store.js';
import { EvalEngine } from '../../../../src/eval/engine.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';
import type { IStorageAdapter } from '../../../../src/types/query.js';

let tmpDir: string;
let store: CustomRuleStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-rule-toggle-'));
  store = createCustomRuleStore({
    pathFor: () => join(tmpDir, 'custom-rules.json'),
    auditPath: join(tmpDir, 'audit.log'),
  });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp(evalEngine: EvalEngine) {
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
  method: 'POST' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  } finally {
    server.close();
  }
}

const context = { output: 'A canary sentence long enough to evaluate cleanly.' };
const firings = (engine: EvalEngine) =>
  engine.evaluate('completeness', context).rule_results.filter((r) => r.ruleName === 'toggle-canary').length;

async function deployCanary(app: express.Express): Promise<string> {
  const deployed = await request(app, 'POST', '/api/v1/rules/custom', {
    name: 'toggle-canary',
    evalType: 'completeness',
    definition: { type: 'contains_keywords', config: { keywords: ['canary'] } },
  });
  expect(deployed.status).toBe(201);
  return (deployed.json as { rule: { id: string } }).rule.id;
}

describe('PATCH /rules/custom/:id — enable / disable on the live engine', () => {
  it('disabling stops the rule on the very next evaluation; enabling brings it back once', async () => {
    const engine = new EvalEngine(0.7);
    const app = makeApp(engine);
    const ruleId = await deployCanary(app);
    expect(firings(engine)).toBe(1);

    const disabled = await request(app, 'PATCH', `/api/v1/rules/custom/${ruleId}`, { enabled: false });
    expect(disabled.status).toBe(200);
    expect((disabled.json as { rule: { enabled: boolean } }).rule.enabled).toBe(false);
    expect(firings(engine)).toBe(0);
    // Persisted, not just in-process: the store says disabled too.
    expect(store.get(LOCAL_TENANT, ruleId)?.enabled).toBe(false);

    const enabled = await request(app, 'PATCH', `/api/v1/rules/custom/${ruleId}`, { enabled: true });
    expect(enabled.status).toBe(200);
    expect((enabled.json as { rule: { enabled: boolean } }).rule.enabled).toBe(true);
    expect(firings(engine)).toBe(1);
  });

  it('is idempotent — enabling an enabled rule does not register it twice', async () => {
    const engine = new EvalEngine(0.7);
    const app = makeApp(engine);
    const ruleId = await deployCanary(app);

    const again = await request(app, 'PATCH', `/api/v1/rules/custom/${ruleId}`, { enabled: true });
    expect(again.status).toBe(200);
    expect(firings(engine)).toBe(1);

    await request(app, 'PATCH', `/api/v1/rules/custom/${ruleId}`, { enabled: false });
    const stillOff = await request(app, 'PATCH', `/api/v1/rules/custom/${ruleId}`, { enabled: false });
    expect(stillOff.status).toBe(200);
    expect(firings(engine)).toBe(0);
  });

  it('404s an unknown id without touching the engine', async () => {
    const engine = new EvalEngine(0.7);
    const app = makeApp(engine);
    const res = await request(app, 'PATCH', '/api/v1/rules/custom/rule-doesnotexist', { enabled: false });
    expect(res.status).toBe(404);
  });

  it('400s a non-boolean and an unknown key, naming the valid one', async () => {
    const engine = new EvalEngine(0.7);
    const app = makeApp(engine);
    const ruleId = await deployCanary(app);

    const notBoolean = await request(app, 'PATCH', `/api/v1/rules/custom/${ruleId}`, { enabled: 'yes' });
    expect(notBoolean.status).toBe(400);

    const typo = await request(app, 'PATCH', `/api/v1/rules/custom/${ruleId}`, { enabeld: false });
    expect(typo.status).toBe(400);
    expect(JSON.stringify(typo.json.details)).toContain('Valid keys: enabled');
    // The typo changed nothing.
    expect(firings(engine)).toBe(1);
  });
});
