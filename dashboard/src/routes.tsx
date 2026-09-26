/*
 * The dashboard's pages, each loaded on demand (#662).
 *
 * Until 0.20.0 every page's code shipped in one bundle that had to arrive
 * before the first page rendered. Each page is now its own chunk: the
 * first load carries the shell (sidebar, header, command palette, tour),
 * the router and the design system, and a page's code arrives when the
 * reader goes to it. After the first page has rendered, the rest are
 * fetched while the browser is idle, so moving between pages does not wait
 * on the network once the dashboard has settled.
 *
 * One list serves both the router and the prefetch, so a page cannot be
 * routed without being prefetched or prefetched without being routed.
 */
import { lazy, type ComponentType, type LazyExoticComponent } from 'react';
import { VIEW_LOADERS } from './components/dashboard/viewLoaders';

type Loader = () => Promise<{ default: ComponentType }>;

interface PageRoute {
  path: string;
  load: Loader;
  Page: LazyExoticComponent<ComponentType>;
}

/**
 * A page module's named export, as the default export `lazy` expects. The
 * router and the prefetch both call this; the browser's module map fetches
 * each chunk once however many times it is imported.
 */
function page<M>(load: () => Promise<M>, pick: (m: M) => ComponentType): Loader {
  return () => load().then((m) => ({ default: pick(m) }));
}

function route(path: string, load: Loader): PageRoute {
  return { path, load, Page: lazy(load) };
}

export const PAGE_ROUTES: readonly PageRoute[] = [
  route('/', page(() => import('./components/dashboard/DashboardPage'), (m) => m.DashboardPage)),
  route('/moments', page(() => import('./components/moments/MomentsTimelinePage'), (m) => m.MomentsTimelinePage)),
  route('/moments/:id', page(() => import('./components/moments/MomentDetailPage'), (m) => m.MomentDetailPage)),
  route('/rules', page(() => import('./components/rules/RulesPage'), (m) => m.RulesPage)),
  route('/audit', page(() => import('./components/audit/AuditPage'), (m) => m.AuditPage)),
  route('/traces', page(() => import('./components/traces/TraceListPage'), (m) => m.TraceListPage)),
  route('/traces/:id', page(() => import('./components/traces/TraceDetailPage'), (m) => m.TraceDetailPage)),
  route('/evals', page(() => import('./components/evals/EvalListPage'), (m) => m.EvalListPage)),
  route('/runs', page(() => import('./components/runs/RunsPage'), (m) => m.RunsPage)),
  route('/runs/:id', page(() => import('./components/runs/RunDetailPage'), (m) => m.RunDetailPage)),
  route('/cases/:key', page(() => import('./components/runs/CasePage'), (m) => m.CasePage)),
];

/** Every chunk the idle prefetch fetches: each page, then the dashboard's four views. */
export const PREFETCH: ReadonlyArray<() => Promise<unknown>> = [...PAGE_ROUTES.map((r) => r.load), ...VIEW_LOADERS];

/**
 * Fetch every page's code, one at a time, while the browser is idle.
 * Called once the first page has rendered; a failure is left for the
 * router to report if the reader goes to that page.
 */
export function prefetchPages(loaders: ReadonlyArray<() => Promise<unknown>> = PREFETCH): () => void {
  let cancelled = false;
  const idle: (cb: () => void) => void =
    typeof window !== 'undefined' && 'requestIdleCallback' in window
      ? (cb) => window.requestIdleCallback(cb, { timeout: 2000 })
      : (cb) => setTimeout(cb, 200);
  const queue = [...loaders];
  const next = (): void => {
    if (cancelled) return;
    const load = queue.shift();
    if (!load) return;
    load().then(
      () => idle(next),
      () => idle(next),
    );
  };
  idle(next);
  return () => {
    cancelled = true;
  };
}
