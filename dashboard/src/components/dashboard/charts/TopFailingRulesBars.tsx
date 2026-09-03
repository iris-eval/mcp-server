/*
 * TopFailingRulesBars — top 5 rules generating the most failures.
 *
 * Answers "what's actually broken?" — Health view's complement to the
 * Significance donut. The donut shows failure CATEGORIES (safety vs cost
 * vs first-failure). This shows the SPECIFIC RULES inside those failures.
 *
 * Together they triangulate the failure pile from two angles:
 *   Significance donut → "20% of moments are safety violations"
 *   This chart        → "...specifically, the PII rule failed 8 times"
 *
 * Bars are sorted descending by fail count. Each row drills through to
 * /moments?kind={k}&since={periodStart} (best approximation — no rule
 * filter on Moments yet, so we land on the closest significance kind).
 *
 * The rule → kind mapping comes from the rule's CATEGORY (server-derived
 * via useRuleCategoryMap, vendored fallback otherwise), never from name
 * substrings: the old `includes('pii') || includes('injection') …` test
 * did not know no_hallucination_markers had joined the safety bundle, so
 * its failures drilled to the wrong filter for a whole release.
 */
import { useMemo } from 'react';
import { HorizontalBarChart } from './HorizontalBarChart';
import { drillToMoments } from '../../../utils/drillThrough';
import {
  BUILT_IN_RULE_CATEGORY,
  ruleToSignificanceKind,
  type RuleCategory,
} from '../ruleCategories';
import type { DecisionMoment } from '../../../api/types';

export interface TopFailingRulesBarsProps {
  moments?: DecisionMoment[];
  periodStartIso: string;
  periodLabel: string;
  /** Rule → category, ideally from useRuleCategoryMap(). Defaults to the vendored table. */
  ruleCategories?: Record<string, RuleCategory>;
}

export function TopFailingRulesBars({
  moments,
  periodStartIso,
  periodLabel,
  ruleCategories = BUILT_IN_RULE_CATEGORY,
}: TopFailingRulesBarsProps) {
  const bars = useMemo(() => {
    const fails = new Map<string, number>();
    for (const m of moments ?? []) {
      for (const rule of m.ruleSnapshot.failed) {
        fails.set(rule, (fails.get(rule) ?? 0) + 1);
      }
    }
    return Array.from(fails.entries()).map(([rule, count]) => ({
      id: rule,
      label: rule,
      value: count,
      href: drillToMoments({ kind: ruleToSignificanceKind(rule, ruleCategories), since: periodStartIso }),
    }));
  }, [moments, periodStartIso, ruleCategories]);

  return (
    <HorizontalBarChart
      title="Top failing rules"
      hint={`by failure count · ${periodLabel}`}
      bars={bars}
      emptyMessage="No rule failures in this window — all clear."
    />
  );
}
