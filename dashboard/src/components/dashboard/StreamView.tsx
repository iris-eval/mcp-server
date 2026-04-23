/*
 * StreamView — live operations view (?view=stream).
 *
 * Wireframed redesign — three sections, all live (5s polling cadence
 * via the underlying hooks):
 *
 *   §1 LIVE NOW          A tighter live-strip of pulse KPIs (pass rate,
 *                        active agents, total moments) — the on-call
 *                        view's heartbeat.
 *
 *   §2 DECISION MOMENTS  The spine of Stream. Significant moments
 *                        sorted by recency, with full drill-through.
 *
 *   §3 RECENT AUDIT      Last 3 rule deploys/deletes — minimal, since
 *                        the full audit log lives at /audit.
 *
 * Drops from prior pass:
 *   - "Rules in play" full categorized list (it's reference data, not
 *     a live signal — lives at /rules)
 *   - Standalone "Agents" panel (per-agent breakdown is a Drift/Health
 *     concern, not a real-time concern)
 *
 * No period selector — Stream is always live. Cadence is implicit (5s
 * polling), surfaced via the chrome's status pill.
 */
import { useEvalStats, useMoments } from '../../api/hooks';
import { CheckCircle2, AlertTriangle, Users } from 'lucide-react';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { EmptyState } from '../shared/EmptyState';
import { StatTile } from './StatTile';
import { SectionHeader } from './SectionHeader';
import { RecentMomentsRow } from './RecentMomentsRow';
import { RecentAuditRow } from './RecentAuditRow';
import { LiveTraceTail } from './charts/LiveTraceTail';

const styles = {
  view: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  rowKpis3: {
    display: 'grid',
    gridTemplateColumns: 'repeat(3, 1fr)',
    gap: 'var(--space-3)',
  } as const,
};

const PERIOD_LIVE = '24h';

export function StreamView() {
  const { data: stats, loading: statsLoading, error: statsError } = useEvalStats(PERIOD_LIVE);
  const { data: significantMoments } = useMoments({ limit: '50', min_significance: '0.4' });

  if (statsLoading && !stats) return <LoadingSpinner />;
  if (statsError) return <EmptyState message={`Could not load live stats: ${statsError}`} />;
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

  return (
    <div style={styles.view} role="tabpanel" id="view-panel-stream" aria-labelledby="stream-tab">
      {/* §1 LIVE NOW — heartbeat */}
      <SectionHeader
        title="Live now"
        question="The fleet's pulse over the last 24 hours."
        trailing="auto-refresh 5s"
      />
      <div style={styles.rowKpis3}>
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
              ? 'No significant moments'
              : `${safetyCount} safety · ${significantCount - safetyCount} other`
          }
          accent={sigAccent}
        />
        <StatTile
          label="Active agents"
          icon={Users}
          value={stats.agentCount.toLocaleString()}
          sub={`unique in ${PERIOD_LIVE}`}
          accent="iris"
        />
      </div>

      {/* §2 LIVE TRACE TAIL — the genuine "live" surface, Stream's
       * differentiator from Health/Drift. Tail-f-style stream of recent
       * traces, refreshes 5s. The on-call view. */}
      <SectionHeader
        title="Live trace tail"
        question="What just got logged into Iris — last 12 traces, refreshes every 5 seconds."
      />
      <LiveTraceTail />

      {/* §3 DECISION MOMENTS — the spine */}
      <SectionHeader
        title="Significant Decision Moments"
        question="The traces that need attention right now."
      />
      <RecentMomentsRow />

      {/* §4 RECENT AUDIT — minimal */}
      <SectionHeader
        title="Recent rule changes"
        question="What was deployed, deleted, or toggled lately?"
      />
      <RecentAuditRow />
    </div>
  );
}
