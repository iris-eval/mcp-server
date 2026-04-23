/*
 * HealthView — default Dashboard view (?view=health).
 *
 * Wireframed redesign — the page tells a 4-act story:
 *
 *   §1 HEADLINE          One headline stat fused with the trend that
 *                        produced it. Big number, delta, annotated chart.
 *                        Eye lock; the user's first read.
 *
 *   §2 WHAT'S WRONG      Significance breakdown donut + Top failing
 *                        rules bars — two angles on the failure pile.
 *                        The donut answers "what category", the bars
 *                        answer "what specifically."
 *
 *   §3 WHO'S MOVING      BiggestMovers table — per-agent drift sorted
 *                        by absolute change vs prior period.
 *
 *   §4 SECONDARY METRICS Cost + activity + spend efficiency, smaller
 *                        and beneath the fold. These don't deserve top
 *                        real estate; they're context, not headline.
 *
 * Wireframe principles:
 *   - The page reads top-to-bottom AS A NARRATIVE.
 *   - Each section ALSO stands alone for non-linear scanning.
 *   - Pass rate appears EXACTLY ONCE as the headline (no duplication
 *     across KPI tiles + gauge + chart axis labels).
 *   - SectionHeader gives real h2 hierarchy — eye knows where to land.
 *   - Verdict donut is GONE (verdict mix is implicit in significance
 *     mix; two donuts on the same dimension competed for the eye).
 *   - Standalone PassRateGauge is GONE from this view (it duplicated the
 *     headline number; the gauge primitive stays in the codebase).
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  useEvalStats,
  useEvalTrend,
  useMoments,
  useAuditLog,
} from '../../api/hooks';
import { formatCost } from '../../utils/formatters';
import { drillToMoments, isoDaysAgo } from '../../utils/drillThrough';
import { resolvePeriod, periodToDays, PeriodSelector } from './PeriodSelector';
import { SectionHeader } from './SectionHeader';
import { StatTile } from './StatTile';
import { HeadlineHero } from './charts/HeadlineHero';
import { Donut } from './charts/Donut';
import type { DonutSlice } from './charts/Donut';
import { TopFailingRulesBars } from './charts/TopFailingRulesBars';
import { BiggestMoversTable } from './charts/BiggestMoversTable';
import { getSignificanceVisual } from '../moments/significance';
import { DollarSign, Users, Activity } from 'lucide-react';
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
  rowKpis3: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 'var(--space-3)',
  } as const,
};

/* Failure-only significance kinds — drops normal-pass so the donut
 * shows the FAILURE PILE composition (the question this section asks).
 * normal-pass would dominate visually (90% pass = giant slice) and
 * crowd out the actionable categories. */
const FAILURE_KINDS: MomentSignificanceKind[] = [
  'safety-violation',
  'cost-spike',
  'rule-collision',
  'first-failure',
  'novel-pattern',
  'normal-fail',
];

export function HealthView() {
  const [searchParams] = useSearchParams();
  const period = resolvePeriod(searchParams, '30d');
  const days = periodToDays(period);
  const periodStartIso = isoDaysAgo(days);
  const priorPeriodStartIso = isoDaysAgo(days * 2);

  const { data: stats } = useEvalStats(period);
  const { data: trend } = useEvalTrend(period);
  const { data: audit } = useAuditLog({
    limit: '500',
    since: periodStartIso,
  });
  const { data: currentMoments } = useMoments({
    limit: '200',
    since: periodStartIso,
  });
  const { data: priorMoments } = useMoments({
    limit: '200',
    since: priorPeriodStartIso,
    until: periodStartIso,
  });
  const priorPeriodKey = `${days * 2}d`;
  const { data: priorStats } = useEvalStats(priorPeriodKey);

  const passRateDelta = useMemo(() => {
    if (!stats || !priorStats) return undefined;
    if (priorStats.totalEvals <= stats.totalEvals) return undefined;
    const priorOnlyEvals = priorStats.totalEvals - stats.totalEvals;
    const priorOnlyPass =
      priorStats.passRate * priorStats.totalEvals - stats.passRate * stats.totalEvals;
    return stats.passRate - priorOnlyPass / Math.max(1, priorOnlyEvals);
  }, [stats, priorStats]);

  // Significance donut — only failure categories (drops normal-pass to
  // keep the donut readable; passes dominate by count and would crush it).
  const significanceSlices: DonutSlice[] = useMemo(() => {
    const counts: Partial<Record<MomentSignificanceKind, number>> = {};
    for (const m of currentMoments?.moments ?? []) {
      counts[m.significance.kind] = (counts[m.significance.kind] ?? 0) + 1;
    }
    return FAILURE_KINDS.map((kind) => {
      const visual = getSignificanceVisual(kind);
      const value = counts[kind] ?? 0;
      return {
        id: kind,
        label: visual.name,
        value,
        color: visual.color,
        href: value > 0 ? drillToMoments({ kind, since: periodStartIso }) : undefined,
      };
    });
  }, [currentMoments, periodStartIso]);

  // Cost-per-eval — secondary metric; tells the spend efficiency story.
  const costPerEval = stats && stats.totalEvals > 0 ? stats.totalCost / stats.totalEvals : 0;

  return (
    <div style={styles.view} role="tabpanel" id="view-panel-health" aria-labelledby="health-tab">
      {/* §1 HEADLINE — the answer to "is the fleet healthy?" */}
      <SectionHeader
        title="Headline"
        question="How is the fleet performing right now?"
        trailing={`window: ${period}`}
      />
      <HeadlineHero
        passRate={stats?.passRate}
        delta={passRateDelta}
        totalEvals={stats?.totalEvals}
        agentCount={stats?.agentCount}
        trend={trend ?? undefined}
        auditEntries={audit?.entries}
        periodLabel={period}
      />

      {/* §2 WHAT'S WRONG — the failure pile, two angles */}
      <SectionHeader
        title="What's wrong"
        question="If something failed, what category was it and which rules fired?"
      />
      <div style={styles.rowSplit2}>
        <Donut
          title="Failure category mix"
          slices={significanceSlices}
          centerLabel="failures"
          emptyMessage="No significant failures in this window — clean run."
        />
        <TopFailingRulesBars
          moments={currentMoments?.moments}
          periodStartIso={periodStartIso}
          periodLabel={period}
        />
      </div>

      {/* §3 WHO'S MOVING — per-agent drift */}
      <SectionHeader
        title="Who's moving"
        question="Which agents shifted the most this period?"
      />
      <BiggestMoversTable
        currentMoments={currentMoments?.moments}
        priorMoments={priorMoments?.moments}
        periodDays={days}
        periodLabel={period}
      />

      {/* §4 SECONDARY METRICS — cost + activity (de-emphasized) */}
      <SectionHeader
        title="Cost & activity"
        question="What did this period cost and how busy was the fleet?"
      />
      <div style={styles.rowKpis3}>
        <StatTile
          label="Total cost"
          icon={DollarSign}
          value={stats ? formatCost(stats.totalCost) : '—'}
          sub={`across ${period}`}
          accent="iris"
        />
        <StatTile
          label="Cost / eval"
          icon={Activity}
          value={stats ? formatCost(costPerEval) : '—'}
          sub="spend efficiency"
          accent="neutral"
        />
        <StatTile
          label="Active agents"
          icon={Users}
          value={stats ? stats.agentCount.toLocaleString() : '—'}
          sub={`unique in ${period}`}
          accent="neutral"
        />
      </div>
    </div>
  );
}

export function HealthViewToolbar() {
  return <PeriodSelector defaultPeriod="30d" />;
}
