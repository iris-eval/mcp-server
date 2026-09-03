/*
 * useRuleCategoryMap — rule name → category, from the engine.
 *
 * Resolves GET /api/v1/rules/builtin (the server's own registry) into a
 * lookup the charts use to classify a failed rule's significance kind.
 * Until the request lands — and if it ever fails — the vendored table in
 * ruleCategories.ts stands in, so a chart never renders without a map.
 */
import { useMemo } from 'react';
import { useBuiltInRules } from '../api/hooks';
import { BUILT_IN_RULE_CATEGORY, type RuleCategory } from '../components/dashboard/ruleCategories';

export function useRuleCategoryMap(): Record<string, RuleCategory> {
  const { data } = useBuiltInRules();
  return useMemo(() => {
    if (!data || data.length === 0) return BUILT_IN_RULE_CATEGORY;
    const map: Record<string, RuleCategory> = {};
    for (const rule of data) map[rule.name] = rule.category;
    return map;
  }, [data]);
}
