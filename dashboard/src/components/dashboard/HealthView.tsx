/*
 * HealthView — default Dashboard view (?view=health).
 *
 * Answers "is my agent fleet healthy?" in one screen. Composition reads
 * top-down by trust gradient:
 *
 *   ROW 1 — KPI deltas (4 tiles, current vs prior period delta)
 *   ROW 2 — PassRateGauge (semicircle hero) + PassRateAreaChart with
 *           audit annotations (2:3 split — gauge anchors left, story
 *           plays out right)
 *   ROW 3 — Verdict donut + Significance donut (1:1 split)
 *   ROW 4 — BiggestMoversTable (single full-width)
 *
 * Every chart is wired to drillThrough — clicking any element lands on
 * a pre-filtered Decision Moments view. The period selector at the top
 * drives every chart on this view (URL-bound, default 30d).
 *
 * Empty state philosophy: every chart designs its own. The page itself
 * doesn't gate on data — partial states (gauge has data, area chart
 * doesn't yet) are normal in early-life Iris and the visuals should
 * communicate that honestly.
 */
import { useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import {
  CheckCircle2,
  AlertTriangle,
  DollarSign,
  Users,
} from 'lucide-react';
import {
  useEvalStats,
  useEvalTrend,
  useMoments,
  useAuditLog,
} from '../../api/hooks';
import { formatCost } from '../../utils/formatters';
import { drillToMoments, isoDaysAgo } from '../../utils/drillThrough';
import { resolvePeriod, periodToDays, PeriodSelector } from './PeriodSelector';
import { StatTile } from './StatTile';
import { PassRateGauge } from './charts/PassRateGauge';
import { PassRateAreaChart } from './charts/PassRateAreaChart';
import { Donut } from './charts/Donut';
import type { DonutSlice } from './charts/Donut';
import { BiggestMoversTable } from './charts/BiggestMoversTable';
import {
  getVerdictVisual,
  getSignificanceVisual,
} from '../moments/significance';
import type { MomentVerdict, MomentSignificanceKind } from '../../api/types';

const styles = {
  view: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-4)',
  } as const,
  rowKpis: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 'var(--space-3)',
  } as const,
  rowGauge: {
    display: 'grid',
    gridTemplateColumns: '1fr 1.6fr',
    gap: 'var(--space-3)',
    alignItems: 'stretch',
  } as const,
  rowDonuts: {
    display: 'grid',
    gridTemplateColumns: '1fr 1fr',
    gap: 'var(--space-3)',
  } as const,
};

const VERDICTS_FOR_DONUT: MomentVerdict[] = ['pass', 'partial', 'fail', 'unevaluated'];
const SIGNIFICANCE_FOR_DONUT: MomentSignificanceKind[] = [
  'safety-violation',
  'cost-spike',
  'rule-collision',
  'first-failure',
  'novel-pattern',
  'normal-fail',
  'normal-pass',
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
  // Prior-period stats for KPI delta computation
  const priorPeriodKey = `${days * 2}d`;
  const { data: priorStats } = useEvalStats(priorPeriodKey);

  // Build delta-aware KPIs. priorStats is for 2× the period so we
  // approximate the prior window by subtracting current from total.
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

  // Verdict donut from current-period moments
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

  // Significance donut — distribution of significance kinds (excluding normal-pass for visual clarity? include all so the user sees true mix)
  const significanceSlices: DonutSlice[] = useMemo(() => {
    const counts: Partial<Record<MomentSignificanceKind, number>> = {};
    for (const m of currentMoments?.moments ?? []) {
      counts[m.significance.kind] = (counts[m.significance.kind] ?? 0) + 1;
    }
    return SIGNIFICANCE_FOR_DONUT.map((kind) => {
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

  return (
    <div style={styles.view} role="tabpanel" id="view-panel-health" aria-labelledby="health-tab">
      {/* ROW 1 — KPI tiles with deltas */}
      <div style={styles.rowKpis}>
        <StatTile
          label="Pass rate"
          icon={CheckCircle2}
          value={kpis ? `${Math.round(kpis.passRate * 100)}%` : '—'}
          sub={kpis ? `${kpis.totalEvals.toLocaleString()} evals` : 'awaiting first eval'}
          accent={kpis && kpis.passRate >= 0.9 ? 'pass' : kpis && kpis.passRate >= 0.7 ? 'warn' : 'fail'}
        />
        <StatTile
          label="Total evals"
          icon={AlertTriangle}
          value={kpis ? kpis.totalEvals.toLocaleString() : '—'}
          sub={kpis?.evalsDelta !== undefined
            ? `${kpis.evalsDelta >= 0 ? '+' : ''}${Math.round(kpis.evalsDelta * 100)}% vs prior`
            : 'no comparison yet'}
          accent="iris"
        />
        <StatTile
          label="Total cost"
          icon={DollarSign}
          value={kpis ? formatCost(kpis.totalCost) : '—'}
          sub={kpis?.costDelta !== undefined
            ? `${kpis.costDelta >= 0 ? '+' : ''}${Math.round(kpis.costDelta * 100)}% vs prior`
            : 'no comparison yet'}
          accent="iris"
        />
        <StatTile
          label="Active agents"
          icon={Users}
          value={kpis ? kpis.agentCount.toLocaleString() : '—'}
          sub={`in ${period}`}
          accent="neutral"
        />
      </div>

      {/* ROW 2 — Hero gauge + annotated trend area */}
      <div style={styles.rowGauge}>
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

      {/* ROW 3 — Two donuts: verdict mix + significance mix */}
      <div style={styles.rowDonuts}>
        <Donut
          title="Verdict mix"
          slices={verdictSlices}
          centerLabel="evals"
          emptyMessage="No evals in this window — your fleet is idle."
        />
        <Donut
          title="Significance mix"
          slices={significanceSlices}
          centerLabel="moments"
          emptyMessage="No Decision Moments yet — first agent run will populate this."
        />
      </div>

      {/* ROW 4 — Biggest movers (full width) */}
      <BiggestMoversTable
        currentMoments={currentMoments?.moments}
        priorMoments={priorMoments?.moments}
        periodDays={days}
        periodLabel={period}
      />
    </div>
  );
}

export function HealthViewToolbar() {
  return <PeriodSelector defaultPeriod="30d" />;
}
