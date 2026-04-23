/*
 * DashboardPage — root surface at `/`.
 *
 * 4-row composition per the Iris Dashboard Composition proposal
 * (strategy/proof/iris-dashboard-composition-proposal-2026-04-23.md):
 *
 *   ROW 1 — HEALTH AT A GLANCE: 4 stat tiles + inline 24h trend
 *   ROW 2 — NEEDS ATTENTION: top significant Decision Moments
 *   ROW 3 — RULES IN PLAY (left) + AGENTS (right)
 *   ROW 4 — RECENT AUDIT
 *
 * The page-level header is intentionally OMITTED — the app `<Header>`
 * (v2.B chrome) renders the route title + subtitle from routeTitles.ts.
 * This dashboard surfaces the system-design moves (Decision Moments,
 * Make-This-A-Rule, Audit) so a user landing on `/` immediately sees
 * what makes Iris different from a generic observability tool.
 */
import { useEvalStats, useEvalTrend, useMoments } from '../../api/hooks';
import { CheckCircle2, AlertTriangle, DollarSign, TrendingUp } from 'lucide-react';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { EmptyState } from '../shared/EmptyState';
import { TT } from '../shared/tooltipText';
import { formatCost } from '../../utils/formatters';
import { StatTile } from './StatTile';
import { Sparkline } from './Sparkline';
import { RecentMomentsRow } from './RecentMomentsRow';
import { RuleListByCategory } from './RuleListByCategory';
import { AgentList } from './AgentList';
import { RecentAuditRow } from './RecentAuditRow';

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-4)',
  } as const,
  rowHealth: {
    display: 'grid',
    gridTemplateColumns: 'repeat(4, 1fr)',
    gap: 'var(--space-3)',
  } as const,
  rowSplit: {
    display: 'grid',
    gridTemplateColumns: '1.1fr 0.9fr',
    gap: 'var(--space-3)',
    alignItems: 'start',
  } as const,
};

const PERIOD_DEFAULT = '7d';

export function DashboardPage() {
  const { data: stats, loading: statsLoading, error: statsError } = useEvalStats(PERIOD_DEFAULT);
  const { data: trend } = useEvalTrend(PERIOD_DEFAULT);
  const { data: significantMoments } = useMoments({ limit: '50', min_significance: '0.4' });

  if (statsLoading && !stats) return <LoadingSpinner />;
  if (statsError) return <EmptyState message={`Could not load dashboard stats: ${statsError}`} />;
  if (!stats) return <EmptyState />;

  // Pass-rate accent: pass / warn / fail thresholds match brand semantic colors
  const passAccent: 'pass' | 'warn' | 'fail' =
    stats.passRate >= 0.9 ? 'pass' : stats.passRate >= 0.7 ? 'warn' : 'fail';

  // Significant Moments tile counts from the filtered moments query
  // (excludes normal-pass; counts safety-violation/cost-spike/rule-collision/
  // first-failure/novel-pattern/normal-fail).
  const significantCount = significantMoments
    ? significantMoments.moments.filter((m) => m.significance.kind !== 'normal-pass').length
    : 0;
  const safetyCount = significantMoments
    ? significantMoments.moments.filter((m) => m.significance.kind === 'safety-violation').length
    : 0;
  const sigAccent: 'pass' | 'warn' | 'fail' =
    significantCount === 0 ? 'pass' : safetyCount > 0 ? 'fail' : 'warn';

  // Trend sparkline — use passRate per bucket
  const trendValues = (trend ?? []).map((p) => p.passRate);

  return (
    <div style={styles.page}>
      {/* ROW 1 — HEALTH AT A GLANCE */}
      <div style={styles.rowHealth}>
        <StatTile
          label="Pass rate"
          icon={CheckCircle2}
          value={`${Math.round(stats.passRate * 100)}%`}
          sub={`${stats.totalEvals} evals · ${stats.agentCount} agents`}
          accent={passAccent}
        />
        <StatTile
          label="Needs attention"
          icon={AlertTriangle}
          value={significantCount}
          sub={
            significantCount === 0
              ? 'No significant Decision Moments'
              : `${safetyCount} safety · ${significantCount - safetyCount} other`
          }
          accent={sigAccent}
        />
        <StatTile
          label="Total cost"
          icon={DollarSign}
          value={formatCost(stats.totalCost)}
          sub={TT.totalCost}
          accent="iris"
        />
        <StatTile
          label="Pass-rate trend"
          icon={TrendingUp}
          value={
            trendValues.length >= 2 ? (
              <span style={{ display: 'inline-flex', flexDirection: 'column', gap: '2px', width: '100%', color: 'var(--text-accent)' }}>
                <Sparkline values={trendValues} height={28} label="Pass-rate over period" />
              </span>
            ) : (
              '—'
            )
          }
          sub={`${PERIOD_DEFAULT} window`}
          accent="neutral"
        />
      </div>

      {/* ROW 2 — NEEDS ATTENTION */}
      <RecentMomentsRow />

      {/* ROW 3 — RULES + AGENTS */}
      <div style={styles.rowSplit}>
        <RuleListByCategory />
        <AgentList />
      </div>

      {/* ROW 4 — RECENT AUDIT */}
      <RecentAuditRow />
    </div>
  );
}
