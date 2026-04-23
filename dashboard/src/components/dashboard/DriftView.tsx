/*
 * DriftView — what's changing this week and why (?view=drift).
 *
 * Comparison-shaped composition. Tactical reader; week-over-week mindset.
 *
 *   ROW 1 — StackedBarByDay (verdict mix per day for the period — anchor)
 *   ROW 2 — HorizontalBarChart cost-by-agent + HorizontalBarChart
 *           failures-by-significance-kind (1:1 split)
 *   ROW 3 — RuleListByCategory (the 13 built-ins with per-rule meters)
 *
 * Period selector is shown (default 7d).
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMoments } from '../../api/hooks';
import {
  resolvePeriod,
  periodToDays,
  PeriodSelector,
} from './PeriodSelector';
import { drillToMoments, isoDaysAgo } from '../../utils/drillThrough';
import { StackedBarByDay } from './charts/StackedBarByDay';
import { HorizontalBarChart } from './charts/HorizontalBarChart';
import { RuleListByCategory } from './RuleListByCategory';
import { formatCost } from '../../utils/formatters';
import { getSignificanceVisual } from '../moments/significance';
import type { MomentSignificanceKind } from '../../api/types';

const styles = {
  view: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-4)',
  } as const,
  rowSplit: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 'var(--space-3)',
  } as const,
};

const FAILURE_KINDS: MomentSignificanceKind[] = [
  'safety-violation',
  'cost-spike',
  'rule-collision',
  'normal-fail',
  'first-failure',
  'novel-pattern',
];

export function DriftView() {
  const [searchParams] = useSearchParams();
  const period = resolvePeriod(searchParams, '7d');
  const days = periodToDays(period);
  const periodStartIso = isoDaysAgo(days);

  const { data: currentMoments } = useMoments({
    limit: '200',
    since: periodStartIso,
  });

  // Cost-by-agent — sum trace cost per agent
  const costBars = useMemo(() => {
    const sums = new Map<string, number>();
    for (const m of currentMoments?.moments ?? []) {
      sums.set(m.agentName, (sums.get(m.agentName) ?? 0) + (m.costUsd ?? 0));
    }
    return Array.from(sums.entries()).map(([agent, total]) => ({
      id: agent,
      label: agent,
      value: total,
      href: drillToMoments({ agent, since: periodStartIso }),
    }));
  }, [currentMoments, periodStartIso]);

  // Failures-by-significance-kind — counts per significance category
  const failureBars = useMemo(() => {
    const counts: Partial<Record<MomentSignificanceKind, number>> = {};
    for (const m of currentMoments?.moments ?? []) {
      if (m.verdict === 'pass') continue;
      counts[m.significance.kind] = (counts[m.significance.kind] ?? 0) + 1;
    }
    return FAILURE_KINDS.filter((k) => (counts[k] ?? 0) > 0).map((k) => {
      const visual = getSignificanceVisual(k);
      return {
        id: k,
        label: visual.name,
        value: counts[k] ?? 0,
        color: visual.color,
        href: drillToMoments({ kind: k, since: periodStartIso }),
      };
    });
  }, [currentMoments, periodStartIso]);

  return (
    <div style={styles.view} role="tabpanel" id="view-panel-drift" aria-labelledby="drift-tab">
      <StackedBarByDay
        moments={currentMoments?.moments}
        days={days}
        periodLabel={period}
      />

      <div style={styles.rowSplit}>
        <HorizontalBarChart
          title="Cost by agent"
          hint={`top spenders · ${period}`}
          bars={costBars}
          formatValue={formatCost}
          emptyMessage="No agent spend yet — run an agent through Iris to see costs land here."
        />
        <HorizontalBarChart
          title="Failures by category"
          hint={`break down · ${period}`}
          bars={failureBars}
          emptyMessage="No failures in this window — everything's passing 🎉"
        />
      </div>

      <RuleListByCategory />
    </div>
  );
}

export function DriftViewToolbar() {
  return <PeriodSelector defaultPeriod="7d" />;
}
