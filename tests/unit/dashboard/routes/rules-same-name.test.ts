/*
 * POST /rules/custom — same-name redeploy, mirrored from deploy_rule (#373).
 *
 * The MCP tool has refused a duplicate name (unless `replace: true`) since
 * the server-correctness batch; the dashboard's deploy route kept
 * accepting one, so two rules with one name could still be created — and
 * both fired, with indistinguishable rule_results — through the surface
 * the tool description sends people to. Both paths now go through the one
 * helper, and this drives the REAL route against a REAL store and a REAL
 * engine to prove the dashboard says and does the same thing the tool does.
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
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-rule-same-name-'));
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

async function deploy(
  app: express.Express,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}/api/v1/rules/custom`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, json: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
  } finally {
    server.close();
  }
}

const context = { output: 'A report sentence long enough to evaluate cleanly.' };
/** rule_results for the "policy" rule on the live engine — one per registered copy. */
const policyResults = async (engine: EvalEngine) =>
  (await engine.evaluate('completeness', context)).rule_results.filter((r) => r.ruleName === 'policy');

const reportRule = {
  name: 'policy',
  evalType: 'completeness',
  definition: { type: 'contains_keywords', config: { keywords: ['report'] } },
};
const zebraRule = {
  name: 'policy',
  evalType: 'completeness',
  definition: { type: 'contains_keywords', config: { keywords: ['zebra'] } },
};

describe('POST /rules/custom — a name that is already deployed', () => {
  it('is refused with 409, the existing rule named, and nothing deployed', async () => {
    const engine = new EvalEngine(0.7);
    const app = makeApp(engine);

    const first = await deploy(app, reportRule);
    expect(first.status).toBe(201);
    const firstId = (first.json as { rule: { id: string } }).rule.id;
    expect(await policyResults(engine)).toHaveLength(1);

    const dup = await deploy(app, zebraRule);
    expect(dup.status).toBe(409);
    // Same sentence the MCP tool throws — the two surfaces cannot drift.
    expect(dup.json.error).toContain(`A rule named "policy" is already deployed: ${firstId}`);
    expect(dup.json.error).toContain('replace: true');
    expect(dup.json.error).toContain('Nothing was deployed.');
    expect(dup.json.existing).toEqual([
      { id: firstId, evalType: 'completeness', severity: 'medium', enabled: true },
    ]);

    // Still exactly one rule, still the first one firing (and passing —
    // "report" is in the output; the zebra rule never registered).
    expect(store.list(LOCAL_TENANT).map((r) => r.id)).toEqual([firstId]);
    const results = await policyResults(engine);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe(firstId);
    expect(results[0].passed).toBe(true);
  });

  it('replace: true retires the earlier rule and deploys the new one under a fresh id', async () => {
    const engine = new EvalEngine(0.7);
    const app = makeApp(engine);

    const first = await deploy(app, reportRule);
    const firstId = (first.json as { rule: { id: string } }).rule.id;

    const replaced = await deploy(app, { ...zebraRule, replace: true });
    expect(replaced.status).toBe(201);
    const newId = (replaced.json as { rule: { id: string } }).rule.id;
    expect(newId).not.toBe(firstId);
    expect(replaced.json.replaced).toEqual([{ id: firstId, evalType: 'completeness', severity: 'medium' }]);
    expect(replaced.json.warning).toContain(firstId);
    expect(replaced.json.warning).toContain('no longer fire');

    // Exactly one rule named "policy" fires, and it is the new one — the
    // ruleId says which, and its verdict says the old rule is gone.
    expect(store.list(LOCAL_TENANT).map((r) => r.id)).toEqual([newId]);
    const results = await policyResults(engine);
    expect(results).toHaveLength(1);
    expect(results[0].ruleId).toBe(newId);
    expect(results[0].passed).toBe(false); // 'zebra' is not in the output
  });

  it('a free name deploys with no `replaced` block, and a non-boolean replace is a 400', async () => {
    const engine = new EvalEngine(0.7);
    const app = makeApp(engine);

    const fresh = await deploy(app, reportRule);
    expect(fresh.status).toBe(201);
    expect(fresh.json.replaced).toBeUndefined();
    expect(fresh.json.warning).toBeUndefined();

    const bad = await deploy(app, { ...zebraRule, replace: 'yes' });
    expect(bad.status).toBe(400);
    expect(bad.json.error).toBe('Invalid rule definition');
    expect(store.list(LOCAL_TENANT)).toHaveLength(1);
  });
});

describe('POST /rules/custom — definition.name', () => {
  it('is optional, and the server names the definition after the rule either way', async () => {
    const engine = new EvalEngine(0.7);
    const app = makeApp(engine);

    // Omitted: the route fills it in.
    const omitted = await deploy(app, reportRule);
    expect(omitted.status).toBe(201);
    expect((omitted.json as { rule: { definition: { name: string } } }).rule.definition.name).toBe('policy');

    // Given but different: overwritten with the top-level name, so the
    // rule reports under one name everywhere.
    const divergent = await deploy(app, {
      name: 'other-policy',
      evalType: 'completeness',
      definition: { name: 'inner-name', type: 'contains_keywords', config: { keywords: ['report'] } },
    });
    expect(divergent.status).toBe(201);
    expect((divergent.json as { rule: { definition: { name: string } } }).rule.definition.name).toBe('other-policy');
    expect((await engine.evaluate('completeness', context)).rule_results.map((r) => r.ruleName)).not.toContain('inner-name');
  });
});
