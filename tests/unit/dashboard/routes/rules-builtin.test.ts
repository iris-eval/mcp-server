/*
 * GET /rules/builtin — the engine's own roster, served to the dashboard.
 *
 * Two dashboard charts classified "safety" by rule-name substring and
 * missed no_hallucination_markers for a whole release after v0.5.0 moved
 * it into the safety bundle. The route is derived from `rulesByType`, so
 * a rule added to a bundle reaches the dashboard categorised correctly
 * with no second edit.
 *
 * Since criticality became configurable the route also needs the ENGINE:
 * `critical` here must be the value that server will apply, not the value
 * the rule declares. A roster that reported the declaration while the
 * engine vetoed on an override would tell an operator the opposite of what
 * their own pipeline was doing.
 */
import { describe, it, expect } from 'vitest';
import express from 'express';
import { registerRuleRoutes, listBuiltInRules } from '../../../../src/dashboard/routes/rules.js';
import { createTenantMiddleware } from '../../../../src/middleware/tenant.js';
import { rulesByType } from '../../../../src/eval/rules/index.js';
import { EvalEngine } from '../../../../src/eval/engine.js';
import type { CustomRuleStore } from '../../../../src/custom-rule-store.js';
import type { IStorageAdapter } from '../../../../src/types/query.js';

interface RosterEntry {
  name: string;
  category: string;
  critical: boolean;
  criticalSource: string;
  description: string;
  weight: number;
}

/** Boots the route against a real engine and returns the roster it serves. */
async function roster(engine: EvalEngine): Promise<RosterEntry[]> {
  const app = express();
  app.use(createTenantMiddleware());
  const router = express.Router();
  registerRuleRoutes(router, {} as unknown as IStorageAdapter, {
    customRuleStore: {} as unknown as CustomRuleStore,
    evalEngine: engine,
  });
  app.use('/api/v1', router);
  const server = app.listen(0);
  const addr = server.address() as { port: number };
  try {
    const res = await fetch(`http://localhost:${addr.port}/api/v1/rules/builtin`);
    expect(res.status).toBe(200);
    return ((await res.json()) as { rules: RosterEntry[] }).rules;
  } finally {
    server.close();
  }
}

describe('GET /rules/builtin', () => {
  it('serves exactly the rules the engine registers, with their bundle as category', async () => {
    const rules = await roster(new EvalEngine());

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
  });

  it('reports the shipped criticality as coming from the default', async () => {
    const rules = await roster(new EvalEngine());
    expect(rules.every((r) => r.criticalSource === 'default')).toBe(true);
    // The three the rules themselves declare, and nothing else.
    expect(rules.filter((r) => r.critical).map((r) => r.name).sort()).toEqual([
      'no_blocklist_words',
      'no_injection_patterns',
      'no_pii',
    ]);
  });

  /*
   * The reason the route takes an engine at all. An operator who promoted a
   * rule must see the promotion HERE — a roster that showed the declaration
   * while the engine vetoed on the override would report the opposite of
   * what their pipeline is doing.
   */
  it('reports a config promotion and a config demotion as coming from config', async () => {
    const rules = await roster(
      new EvalEngine(0.7, undefined, {
        criticalRules: ['no_silent_tool_failure'],
        nonCriticalRules: ['no_pii'],
      }),
    );
    const promoted = rules.find((r) => r.name === 'no_silent_tool_failure');
    expect(promoted).toMatchObject({ critical: true, criticalSource: 'config' });
    const demoted = rules.find((r) => r.name === 'no_pii');
    expect(demoted).toMatchObject({ critical: false, criticalSource: 'config' });
    // Untouched rules still say default.
    expect(rules.find((r) => r.name === 'no_injection_patterns')).toMatchObject({
      critical: true,
      criticalSource: 'default',
    });
  });

  it('listBuiltInRules mirrors rulesByType one to one', () => {
    const total = Object.values(rulesByType).reduce((n, list) => n + list.length, 0);
    expect(listBuiltInRules()).toHaveLength(total);
  });
});
