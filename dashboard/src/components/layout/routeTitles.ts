/*
 * routeTitles — single source of truth for page titles + meta.
 *
 * Used by Header to render the page title strip without per-page prop
 * drilling. Used by browser document.title via a hook (PageHeader sets
 * title on mount). Adding a new route requires adding an entry here.
 */

export interface RouteMeta {
  /** Path pattern as used in Routes (parameterized routes use ':' segments). */
  pattern: string;
  /** Display title shown in the header. */
  title: string;
  /** Optional subtitle / one-line context. */
  subtitle?: string;
  /** Whether the page title shows as a static label or a dynamic resource. */
  kind: 'static' | 'resource';
}

export const ROUTE_TITLES: RouteMeta[] = [
  { pattern: '/', title: 'Dashboard', subtitle: 'Output quality across all agents', kind: 'static' },
  {
    pattern: '/moments',
    title: 'Decision Moments',
    subtitle: 'Every trace, classified by significance',
    kind: 'static',
  },
  {
    pattern: '/moments/:id',
    title: 'Moment',
    subtitle: 'Single Decision Moment',
    kind: 'resource',
  },
  {
    pattern: '/rules',
    title: 'Custom Rules',
    subtitle: 'Deployed via Make-This-A-Rule',
    kind: 'static',
  },
  {
    pattern: '/audit',
    title: 'Audit Log',
    subtitle: 'Immutable record of rule changes',
    kind: 'static',
  },
  { pattern: '/traces', title: 'Traces', subtitle: 'Raw agent execution logs', kind: 'static' },
  { pattern: '/traces/:id', title: 'Trace', kind: 'resource' },
  { pattern: '/evals', title: 'Evaluations', subtitle: 'Per-rule eval results', kind: 'static' },
];

/**
 * Resolve a pathname (e.g. "/moments/abc123") to its RouteMeta.
 * Parameterized routes match by replacing :segments with regex.
 */
export function resolveRouteMeta(pathname: string): RouteMeta | undefined {
  // Exact match first
  const exact = ROUTE_TITLES.find((r) => r.pattern === pathname);
  if (exact) return exact;
  // Parameterized match
  for (const route of ROUTE_TITLES) {
    if (!route.pattern.includes(':')) continue;
    const regex = new RegExp(
      '^' + route.pattern.replace(/:[a-z]+/gi, '[^/]+') + '$',
    );
    if (regex.test(pathname)) return route;
  }
  return undefined;
}
