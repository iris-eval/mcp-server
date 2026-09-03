/*
 * GET /rules/builtin — the engine's own roster, served to the dashboard.
 *
 * Two dashboard charts classified "safety" by rule-name substring and
 * missed no_hallucination_markers for a whole release after v0.5.0 moved
 * it into the safety bundle. The route is derived from `rulesByType`, so
 * a rule added to a bundle reaches the dashboard categorised correctly
 * with no second edit.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { registerRuleRoutes, listBuiltInRules } from '../../../../src/dashboard/routes/rules.js';
import { createTenantMiddleware } from '../../../../src/middleware/tenant.js';
import { rulesByType } from '../../../../src/eval/rules/index.js';
import type { CustomRuleStore } from '../../../../src/custom-rule-store.js';
import type { EvalEngine } from '../../../../src/eval/engine.js';
import type { IStorageAdapter } from '../../../../src/types/query.js';

describe('GET /rules/builtin', () => {
  it('serves exactly the rules the engine registers, with their bundle as category', async () => {
    const app = express();
    app.use(createTenantMiddleware());
    const router = express.Router();
    registerRuleRoutes(router, {} as unknown as IStorageAdapter, {
      customRuleStore: {} as unknown as CustomRuleStore,
      evalEngine: {} as unknown as EvalEngine,
    });
    app.use('/api/v1', router);
    const server = app.listen(0);
    const addr = server.address() as { port: number };
    try {
      const res = await fetch(`http://localhost:${addr.port}/api/v1/rules/builtin`);
      expect(res.status).toBe(200);
      const { rules } = (await res.json()) as {
        rules: Array<{ name: string; category: string; critical: boolean; description: string; weight: number }>;
      };

      const expected = Object.entries(rulesByType).flatMap(([category, list]) =>
        list.map((r) => ({ name: r.name, category })),
      );
      expect(rules.map((r) => ({ name: r.name, category: r.category }))).toEqual(expected);

      const hallucination = rules.find((r) => r.name === 'no_hallucination_markers');
      expect(hallucination?.category).toBe('safety');
      expect(rules.find((r) => r.name === 'no_pii')?.critical).toBe(true);
      for (const r of rules) {
        expect(r.description.length).toBeGreaterThan(0);
        expect(r.weight).toBeGreaterThan(0);
      }
    } finally {
      server.close();
    }
  });

  it('listBuiltInRules mirrors rulesByType one to one', () => {
    const total = Object.values(rulesByType).reduce((n, list) => n + list.length, 0);
    expect(listBuiltInRules()).toHaveLength(total);
  });
});
