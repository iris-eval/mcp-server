/*
 * Drift lock: the dashboard's vendored rule → category table must match
 * the engine's rule registry exactly.
 *
 * The live dashboard reads categories from GET /api/v1/rules/builtin; the
 * vendored table in dashboard/src/components/dashboard/ruleCategories.ts
 * is the fallback while that request is in flight (and what tests see).
 * A fallback that disagrees with the engine is how no_hallucination_markers
 * drilled to the wrong filter for a release: v0.5.0 moved it into the
 * safety bundle and nothing on the dashboard side noticed. This test
 * fails the root suite the moment a built-in rule is added, removed, or
 * moved between bundles without updating the table.
 */
import { describe, it, expect } from 'vitest';
import { rulesByType } from '../../../src/eval/rules/index.js';
import {
  BUILT_IN_RULES,
  BUILT_IN_RULE_CATEGORY,
} from '../../../dashboard/src/components/dashboard/ruleCategories.js';

describe('dashboard rule categories stay in lockstep with the engine', () => {
  const engineEntries = Object.entries(rulesByType).flatMap(([category, list]) =>
    list.map((rule) => [rule.name, category] as const),
  );
  const engineMap = Object.fromEntries(engineEntries);

  it('BUILT_IN_RULE_CATEGORY has exactly the engine\'s rules, each in its bundle', () => {
    expect(BUILT_IN_RULE_CATEGORY).toEqual(engineMap);
  });

  it('BUILT_IN_RULES (the display roster) names the same rules with the same categories', () => {
    const roster = Object.fromEntries(BUILT_IN_RULES.map((r) => [r.name, r.category]));
    expect(roster).toEqual(engineMap);
  });
});
