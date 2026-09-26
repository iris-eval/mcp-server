/*
 * DashboardPage — root surface at `/`.
 *
 * Hosts four views, switched via the ViewTabs strip:
 *
 *   Failures — ranked failure list          (default — land on the failure)
 *   Health   — evals in aggregate           (executive shape)
 *   Drift    — what's changing this week    (tactical / comparison shape)
 *   Stream   — live pulse + Decision Moments (operational / live shape)
 *
 * Each view owns its composition and its own period default. The page-
 * level chrome is just: ViewTabs (with trailing PeriodSelector slot for
 * views that use one) + the active view's body.
 *
 * The chrome `<Header>` (v2.B) carries the page identity ("Dashboard").
 * No inline page header — keeps a single h1 per route.
 *
 * Each view is its own chunk (#662): the tabs render at once, and a view's
 * code arrives when it is first shown. The toolbars live in their views'
 * modules, so they wait for the same chunk and show nothing until then.
 */
import { lazy, Suspense } from 'react';
import { useSearchParams } from 'react-router';
import { ViewTabs, resolveView } from './ViewTabs';
import { RouteLoading } from '../layout/RouteLoading';
import { loadDriftView, loadFailuresView, loadHealthView, loadStreamView } from './viewLoaders';

const FailuresView = lazy(() => loadFailuresView().then((m) => ({ default: m.FailuresView })));
const HealthView = lazy(() => loadHealthView().then((m) => ({ default: m.HealthView })));
const HealthViewToolbar = lazy(() => loadHealthView().then((m) => ({ default: m.HealthViewToolbar })));
const DriftView = lazy(() => loadDriftView().then((m) => ({ default: m.DriftView })));
const DriftViewToolbar = lazy(() => loadDriftView().then((m) => ({ default: m.DriftViewToolbar })));
const StreamView = lazy(() => loadStreamView().then((m) => ({ default: m.StreamView })));

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
  // views that have one. Failures is a ranked list and Stream is always
  // live, so neither has a toolbar.
  const trailing =
    view === 'health' ? <HealthViewToolbar /> :
    view === 'drift' ? <DriftViewToolbar /> :
    null;

  return (
    <div style={styles.page}>
      <ViewTabs trailing={trailing && <Suspense fallback={null}>{trailing}</Suspense>} />
      <Suspense fallback={<RouteLoading />}>
        {view === 'failures' && <FailuresView />}
        {view === 'health' && <HealthView />}
        {view === 'drift' && <DriftView />}
        {view === 'stream' && <StreamView />}
      </Suspense>
    </div>
  );
}
