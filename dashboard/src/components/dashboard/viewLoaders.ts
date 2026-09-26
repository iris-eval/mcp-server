/*
 * The four views of `/` — Failures, Health, Drift, Stream — each loaded on
 * demand (#662). Failures is the default and the lightest; Health and
 * Drift carry the charts. The page and the idle prefetch read the same
 * loaders, so the browser fetches each view's chunk once.
 */
export const loadFailuresView = () => import('./FailuresView');
export const loadHealthView = () => import('./HealthView');
export const loadDriftView = () => import('./DriftView');
export const loadStreamView = () => import('./StreamView');

export const VIEW_LOADERS: ReadonlyArray<() => Promise<unknown>> = [
  loadFailuresView,
  loadHealthView,
  loadDriftView,
  loadStreamView,
];
