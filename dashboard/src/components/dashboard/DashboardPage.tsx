/*
 * DashboardPage — root surface at `/`.
 *
 * Hosts three BI views, switched via the ViewTabs strip:
 *
 *   Health  — fleet wellness in aggregate  (default, executive shape)
 *   Drift   — what's changing this week    (tactical / comparison shape)
 *   Stream  — live pulse + Decision Moments (operational / live shape)
 *
 * Each view owns its composition and its own period default. The page-
 * level chrome is just: ViewTabs (with trailing PeriodSelector slot for
 * views that use one) + the active view's body.
 *
 * The chrome `<Header>` (v2.B) carries the page identity ("Dashboard").
 * No inline page header — keeps a single h1 per route.
 */
import { useSearchParams } from 'react-router-dom';
import { ViewTabs, resolveView } from './ViewTabs';
import { HealthView, HealthViewToolbar } from './HealthView';
import { DriftView, DriftViewToolbar } from './DriftView';
import { StreamView } from './StreamView';

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
};

export function DashboardPage() {
  const [searchParams] = useSearchParams();
  const view = resolveView(searchParams);

  // Per-view trailing toolbar slot — the period selector lives here for
  // views that have one. Stream is always live, so no toolbar.
  const trailing =
    view === 'health' ? <HealthViewToolbar /> :
    view === 'drift' ? <DriftViewToolbar /> :
    null;

  return (
    <div style={styles.page}>
      <ViewTabs trailing={trailing} />
      {view === 'health' && <HealthView />}
      {view === 'drift' && <DriftView />}
      {view === 'stream' && <StreamView />}
    </div>
  );
}
