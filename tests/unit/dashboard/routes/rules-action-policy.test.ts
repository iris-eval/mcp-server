/*
 * Every rule type the tool deploys, the REST route deploys (arc 9, N-8).
 *
 * The 0.15.0 stranger's gate phase found `POST /api/v1/rules/custom`
 * refusing an `action_policy` that `deploy_rule` accepted: the route's own
 * copy of the type enum stopped at eight. The list is now one exported
 * constant (`RULE_TYPE_VALUES`) that the store, the tool and the route all
 * build from — two surfaces, one constant — and this test deploys one rule
 * of every type over HTTP, with a valid config for each, and reads them
 * back from the store.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { registerRuleRoutes } from '../../../../src/dashboard/routes/rules.js';
import { createTenantMiddleware } from '../../../../src/middleware/tenant.js';
import { createCustomRuleStore, RULE_TYPE_VALUES, type CustomRuleStore } from '../../../../src/custom-rule-store.js';
import { EvalEngine } from '../../../../src/eval/engine.js';
import { LOCAL_TENANT } from '../../../../src/types/tenant.js';
import type { IStorageAdapter } from '../../../../src/types/query.js';

let tmpDir: string;
let store: CustomRuleStore;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'iris-rule-types-'));
  store = createCustomRuleStore({ pathFor: () => join(tmpDir, 'custom-rules.json'), auditPath: join(tmpDir, 'audit.log') });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

function makeApp(evalEngine: EvalEngine) {
  const app = express();
  app.use(express.json());
  app.use(createTenantMiddleware());
  const router = express.Router();
  registerRuleRoutes(router, {} as unknown as IStorageAdapter, { customRuleStore: store, evalEngine });
  app.use('/api/v1', router);
  return app;
}

async function deploy(app: express.Express, body: unknown): Promise<{ status: number; json: Record<string, unknown> }> {
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

/** A valid config per type — what the store's per-type validation requires. */
const CONFIG_FOR: Record<(typeof RULE_TYPE_VALUES)[number], Record<string, unknown>> = {
  regex_match: { pattern: 'SUP-\\d+' },
  regex_no_match: { pattern: 'password' },
  min_length: { min_length: 20 },
  max_length: { max_length: 2000 },
  contains_keywords: { keywords: ['ticket'] },
  excludes_keywords: { keywords: ['CompetitorCorp'] },
  json_schema: {},
  cost_threshold: { max_cost: 0.5 },
  action_policy: { deny: [{ tool: 'delete_*' }] },
};

describe('POST /api/v1/rules/custom accepts every rule type the tool accepts', () => {
  it('the constant carries action_policy, and the route deploys one of every type', async () => {
    expect(RULE_TYPE_VALUES).toContain('action_policy');
    const app = makeApp(new EvalEngine());
    for (const type of RULE_TYPE_VALUES) {
      const r = await deploy(app, {
        name: `type_${type}`,
        description: `a ${type} rule`,
        evalType: 'custom',
        severity: type === 'action_policy' ? 'high' : 'low',
        definition: { type, config: CONFIG_FOR[type] },
      });
      expect(r.status, `${type}: ${JSON.stringify(r.json).slice(0, 200)}`).toBe(201);
    }
    const deployed = store.list(LOCAL_TENANT).map((r) => r.definition.type).sort();
    expect(deployed).toEqual([...RULE_TYPE_VALUES].sort());
  });

  it('the action_policy deployed over HTTP fires on the trajectory it forbids', async () => {
    const engine = new EvalEngine();
    const app = makeApp(engine);
    const r = await deploy(app, {
      name: 'no_delete_tools',
      description: 'no tool named delete_* may be called',
      evalType: 'custom',
      severity: 'high',
      definition: { type: 'action_policy', config: { deny: [{ tool: 'delete_*' }] } },
    });
    expect(r.status).toBe(201);
    const result = await engine.evaluate('custom', {
      output: 'Removed the stale rows as asked.',
      toolCalls: [{ tool_name: 'delete_rows', input: { table: 'users' }, output: { deleted: 12 } }],
    });
    const row = result.rule_results.find((x) => x.ruleName === 'no_delete_tools');
    expect(row?.passed).toBe(false);
    expect(result.verdict?.basis).toBe('policy_gate');
    expect(result.verdict?.by).toEqual(['no_delete_tools']);
  });
});
