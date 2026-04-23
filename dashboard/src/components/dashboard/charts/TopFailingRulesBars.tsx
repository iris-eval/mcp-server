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
 */
import { useMemo } from 'react';
import { HorizontalBarChart } from './HorizontalBarChart';
import { drillToMoments } from '../../../utils/drillThrough';
import type {
  DecisionMoment,
  MomentSignificanceKind,
} from '../../../api/types';

/**
 * Heuristic: map a rule name to its likely significance kind so the
 * drill-through lands on a useful filter.
 *   PII / injection / blocklist / stub-output → safety-violation
 *   Anything cost-related                     → cost-spike
 *   Default                                   → normal-fail
 */
function ruleToKind(rule: string): MomentSignificanceKind {
  const r = rule.toLowerCase();
  if (r.includes('pii') || r.includes('injection') || r.includes('blocklist') || r.includes('stub')) {
    return 'safety-violation';
  }
  if (r.includes('cost') || r.includes('budget')) {
    return 'cost-spike';
  }
  return 'normal-fail';
}

export interface TopFailingRulesBarsProps {
  moments?: DecisionMoment[];
  periodStartIso: string;
  periodLabel: string;
}

export function TopFailingRulesBars({ moments, periodStartIso, periodLabel }: TopFailingRulesBarsProps) {
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
      href: drillToMoments({ kind: ruleToKind(rule), since: periodStartIso }),
    }));
  }, [moments, periodStartIso]);

  return (
    <HorizontalBarChart
      title="Top failing rules"
      hint={`by failure count · ${periodLabel}`}
      bars={bars}
      emptyMessage="No rule failures in this window — fleet's clean."
    />
  );
}
