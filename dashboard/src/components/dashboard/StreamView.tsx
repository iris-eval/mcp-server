/*
 * StreamView — the live operations view (?view=stream).
 *
 * Dense, real-time, row-shaped. The 4-row composition we shipped in
 * DC.1 lives here verbatim — this is the daily-user view, the on-call
 * view, the "what's happening RIGHT NOW" view.
 *
 *   ROW 1 — HEALTH AT A GLANCE: 4 stat tiles + inline 24h trend
 *   ROW 2 — NEEDS ATTENTION: top significant Decision Moments
 *   ROW 3 — RULES IN PLAY (left) + AGENTS (right)
 *   ROW 4 — RECENT AUDIT
 *
 * Note: this view ignores the period selector — it's always live (last
 * 24h of activity, polling every 5s via the underlying hooks). The
 * period selector hides itself when this view is active (DashboardPage
 * conditionally renders the toolbar).
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
  view: {
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

export function StreamView() {
  const { data: stats, loading: statsLoading, error: statsError } = useEvalStats(PERIOD_DEFAULT);
  const { data: trend } = useEvalTrend(PERIOD_DEFAULT);
  const { data: significantMoments } = useMoments({ limit: '50', min_significance: '0.4' });

  if (statsLoading && !stats) return <LoadingSpinner />;
  if (statsError) return <EmptyState message={`Could not load dashboard stats: ${statsError}`} />;
  if (!stats) return <EmptyState />;

  const passAccent: 'pass' | 'warn' | 'fail' =
    stats.passRate >= 0.9 ? 'pass' : stats.passRate >= 0.7 ? 'warn' : 'fail';

  const significantCount = significantMoments
    ? significantMoments.moments.filter((m) => m.significance.kind !== 'normal-pass').length
    : 0;
  const safetyCount = significantMoments
    ? significantMoments.moments.filter((m) => m.significance.kind === 'safety-violation').length
    : 0;
  const sigAccent: 'pass' | 'warn' | 'fail' =
    significantCount === 0 ? 'pass' : safetyCount > 0 ? 'fail' : 'warn';

  const trendValues = (trend ?? []).map((p) => p.passRate);

  return (
    <div style={styles.view} role="tabpanel" id="view-panel-stream" aria-labelledby="stream-tab">
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

      <RecentMomentsRow />

      <div style={styles.rowSplit}>
        <RuleListByCategory />
        <AgentList />
      </div>

      <RecentAuditRow />
    </div>
  );
}
