/*
 * HealthView — default Dashboard view (?view=health).
 *
 * Restored composition (founder feedback: prior pass stripped out the
 * gauge + verdict donut + KPI strip — the visuals that actually worked).
 *
 * The page now reads as a sectioned story BUT keeps the dense BI layout
 * the founder wanted:
 *
 *   §1 HEADLINE          4 scannable KPI tiles (pass rate, evals, cost,
 *                        agents) — at-a-glance summary with deltas.
 *
 *   §2 TRAJECTORY        PassRateGauge (semicircle meter, ~280px left) +
 *                        PassRateAreaChart with audit annotations
 *                        (fills remainder, right). Two complementary
 *                        lenses on the same number — gauge shows
 *                        threshold position, chart shows trend.
 *
 *   §3 FAILURE BREAKDOWN Verdict donut + Significance donut, side by
 *                        side. Verdict = "did it pass?" Significance =
 *                        "if it failed, what category?" Both are useful.
 *
 *   §4 ACTIONABLE        Top failing rules + Biggest movers, side by
 *                        side. The two "where do I act?" surfaces.
 *
 * Multiple visualizations of the same metric (KPI tile + gauge + chart)
 * are intentional — each is a different lens. Density is a feature
 * for BI dashboards, not a bug.
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
import { PassRateGauge } from './charts/PassRateGauge';
import { PassRateAreaChart } from './charts/PassRateAreaChart';
import { Donut } from './charts/Donut';
import type { DonutSlice } from './charts/Donut';
import { TopFailingRulesBars } from './charts/TopFailingRulesBars';
import { BiggestMoversTable } from './charts/BiggestMoversTable';
import {
  getVerdictVisual,
  getSignificanceVisual,
} from '../moments/significance';
import {
  CheckCircle2,
  AlertTriangle,
  DollarSign,
  Users,
} from 'lucide-react';
import type { MomentVerdict, MomentSignificanceKind } from '../../api/types';

const styles = {
  view: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  rowKpis4: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 'var(--space-3)',
  } as const,
  rowGaugePlusChart: {
    display: 'grid',
    gridTemplateColumns: 'minmax(280px, 1fr) minmax(0, 1.8fr)',
    gap: 'var(--space-3)',
    alignItems: 'stretch',
  } as const,
  rowSplit2: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 'var(--space-3)',
  } as const,
};

const VERDICTS_FOR_DONUT: MomentVerdict[] = ['pass', 'partial', 'fail', 'unevaluated'];

/* Failure-only significance kinds — drops normal-pass so the donut
 * shows the FAILURE PILE composition. normal-pass would dominate
 * visually (90% pass = giant slice) and crowd out actionable categories. */
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

  const kpis = useMemo(() => {
    if (!stats) return null;
    const prCurrent = stats.passRate;
    const prPrior =
      priorStats && priorStats.totalEvals > stats.totalEvals
        ? (priorStats.passRate * priorStats.totalEvals - stats.passRate * stats.totalEvals) /
          Math.max(1, priorStats.totalEvals - stats.totalEvals)
        : undefined;
    const passRateDelta = prPrior === undefined ? undefined : prCurrent - prPrior;

    const evalsCurrent = stats.totalEvals;
    const evalsPrior =
      priorStats && priorStats.totalEvals > stats.totalEvals
        ? priorStats.totalEvals - stats.totalEvals
        : undefined;
    const evalsDelta =
      evalsPrior !== undefined && evalsPrior > 0
        ? (evalsCurrent - evalsPrior) / evalsPrior
        : undefined;

    const costCurrent = stats.totalCost;
    const costPrior =
      priorStats && priorStats.totalCost > stats.totalCost
        ? priorStats.totalCost - stats.totalCost
        : undefined;
    const costDelta =
      costPrior !== undefined && costPrior > 0
        ? (costCurrent - costPrior) / costPrior
        : undefined;

    return {
      passRate: prCurrent,
      passRateDelta,
      totalEvals: evalsCurrent,
      evalsDelta,
      totalCost: costCurrent,
      costDelta,
      agentCount: stats.agentCount,
    };
  }, [stats, priorStats]);

  const verdictSlices: DonutSlice[] = useMemo(() => {
    const counts: Record<MomentVerdict, number> = {
      pass: 0,
      partial: 0,
      fail: 0,
      unevaluated: 0,
    };
    for (const m of currentMoments?.moments ?? []) counts[m.verdict] += 1;
    return VERDICTS_FOR_DONUT.map((v) => ({
      id: v,
      label: getVerdictVisual(v).label,
      value: counts[v],
      color: getVerdictVisual(v).color,
      href: counts[v] > 0 ? drillToMoments({ verdict: v, since: periodStartIso }) : undefined,
    }));
  }, [currentMoments, periodStartIso]);

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

  const fmtDelta = (d?: number): string => {
    if (d === undefined || Number.isNaN(d)) return '—';
    const pct = Math.round(d * 100);
    return `${pct >= 0 ? '+' : ''}${pct}%`;
  };

  return (
    <div style={styles.view} role="tabpanel" id="view-panel-health" aria-labelledby="health-tab">
      {/* §1 HEADLINE — scannable KPI strip */}
      <SectionHeader title="Headline" trailing={`window: ${period}`} />
      <div style={styles.rowKpis4}>
        <StatTile
          label="Pass rate"
          icon={CheckCircle2}
          value={kpis ? `${Math.round(kpis.passRate * 100)}%` : '—'}
          sub={`${fmtDelta(kpis?.passRateDelta)} vs prior ${period}`}
          accent={kpis && kpis.passRate >= 0.9 ? 'pass' : kpis && kpis.passRate >= 0.7 ? 'warn' : 'fail'}
        />
        <StatTile
          label="Total evals"
          icon={AlertTriangle}
          value={kpis ? kpis.totalEvals.toLocaleString() : '—'}
          sub={`${fmtDelta(kpis?.evalsDelta)} vs prior ${period}`}
          accent="iris"
        />
        <StatTile
          label="Total cost"
          icon={DollarSign}
          value={kpis ? formatCost(kpis.totalCost) : '—'}
          sub={`${fmtDelta(kpis?.costDelta)} vs prior ${period}`}
          accent="iris"
        />
        <StatTile
          label="Active agents"
          icon={Users}
          value={kpis ? kpis.agentCount.toLocaleString() : '—'}
          sub={`unique in ${period}`}
          accent="neutral"
        />
      </div>

      {/* §2 TRAJECTORY — gauge (threshold lens) + annotated trend (time lens) */}
      <SectionHeader title="Trajectory" question="Where is pass rate now and how did it get there?" />
      <div style={styles.rowGaugePlusChart}>
        <PassRateGauge
          value={kpis?.passRate}
          delta={kpis?.passRateDelta}
          totalEvals={kpis?.totalEvals}
          agentCount={kpis?.agentCount}
          periodLabel={period}
        />
        <PassRateAreaChart
          trend={trend ?? undefined}
          auditEntries={audit?.entries}
          periodLabel={period}
        />
      </div>

      {/* §3 FAILURE BREAKDOWN — verdict mix (overall) + significance mix (failure pile) */}
      <SectionHeader title="Failure breakdown" question="How are evals distributed and what categories are failing?" />
      <div style={styles.rowSplit2}>
        <Donut
          title="Verdict mix"
          slices={verdictSlices}
          centerLabel="evals"
          emptyMessage="No evals in this window — your fleet is idle."
        />
        <Donut
          title="Significance mix"
          slices={significanceSlices}
          centerLabel="failures"
          emptyMessage="No significant failures in this window — clean run."
        />
      </div>

      {/* §4 ACTIONABLE — what's broken + who's moving */}
      <SectionHeader title="Where to act" question="Which rules failed most and which agents shifted most?" />
      <div style={styles.rowSplit2}>
        <TopFailingRulesBars
          moments={currentMoments?.moments}
          periodStartIso={periodStartIso}
          periodLabel={period}
        />
        <BiggestMoversTable
          currentMoments={currentMoments?.moments}
          priorMoments={priorMoments?.moments}
          periodDays={days}
          periodLabel={period}
        />
      </div>
    </div>
  );
}

export function HealthViewToolbar() {
  return <PeriodSelector defaultPeriod="30d" />;
}
