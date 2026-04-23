/*
 * DriftView — what's changing this week and why (?view=drift).
 *
 * Wireframed redesign:
 *
 *   §1 WHAT CHANGED        ChangeBanner — one-line narrative summary of
 *                          the 3 most important deltas vs prior period.
 *
 *   §2 PATTERN OVER TIME   StackedBarByDay — verdict mix per day, the
 *                          anchor visualization for the comparison story.
 *
 *   §3 SLICED TWO WAYS     Cost-by-agent + Failures-by-category bars.
 *                          Same data, different cuts.
 *
 *   §4 PER-RULE PERFORMANCE PerRuleMeterGrid — meter + sparkline + drift
 *                          arrow per built-in rule, grouped by category.
 *
 * Every section asks one question. Every section drills through to a
 * pre-filtered Decision Moments view.
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
import { SectionHeader } from './SectionHeader';
import { ChangeBanner } from './charts/ChangeBanner';
import { StackedBarByDay } from './charts/StackedBarByDay';
import { HorizontalBarChart } from './charts/HorizontalBarChart';
import { PerRuleMeterGrid } from './charts/PerRuleMeterGrid';
import { formatCost } from '../../utils/formatters';
import { getSignificanceVisual } from '../moments/significance';
import type { MomentSignificanceKind } from '../../api/types';

const styles = {
  view: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  rowSplit2: {
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
  const priorPeriodStartIso = isoDaysAgo(days * 2);

  const { data: currentMoments } = useMoments({
    limit: '200',
    since: periodStartIso,
  });
  const { data: priorMoments } = useMoments({
    limit: '200',
    since: priorPeriodStartIso,
    until: periodStartIso,
  });

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
      {/* §1 WHAT CHANGED — narrative summary */}
      <SectionHeader
        title="What changed"
        question="The headline delta vs the prior equivalent window."
        trailing={`vs prior ${period}`}
      />
      <ChangeBanner
        currentMoments={currentMoments?.moments}
        priorMoments={priorMoments?.moments}
        periodLabel={period}
      />

      {/* §2 PATTERN OVER TIME */}
      <SectionHeader
        title="Pattern over time"
        question="Which days carried the load and which days carried the failures?"
      />
      <StackedBarByDay
        moments={currentMoments?.moments}
        days={days}
        periodLabel={period}
      />

      {/* §3 SLICED TWO WAYS */}
      <SectionHeader
        title="Sliced two ways"
        question="Where did the spend land, and which failure categories grew?"
      />
      <div style={styles.rowSplit2}>
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
          emptyMessage="No failures in this window — everything's passing."
        />
      </div>

      {/* §4 PER-RULE PERFORMANCE */}
      <SectionHeader
        title="Per-rule performance"
        question="How is each of the 13 built-in rules performing, and which moved?"
      />
      <PerRuleMeterGrid
        currentMoments={currentMoments?.moments}
        priorMoments={priorMoments?.moments}
        periodStartIso={periodStartIso}
        periodLabel={period}
      />
    </div>
  );
}

export function DriftViewToolbar() {
  return <PeriodSelector defaultPeriod="7d" />;
}
