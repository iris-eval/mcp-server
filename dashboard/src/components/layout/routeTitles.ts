import { NAV_LABELS } from './navLabels';

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
  { pattern: '*', title: 'Not found', subtitle: 'No page at this address', kind: 'static' },
  { pattern: '/', title: NAV_LABELS.failures, subtitle: 'What failed, worst and newest first; health, drift and the live stream one tab over', kind: 'static' },
  {
    pattern: '/moments',
    title: NAV_LABELS.moments,
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
    title: NAV_LABELS.rules,
    subtitle: 'The built-in roster with its proof, and the rules you deployed',
    kind: 'static',
  },
  {
    pattern: '/audit',
    title: NAV_LABELS.audit,
    subtitle: 'Immutable record of rule changes',
    kind: 'static',
  },
  { pattern: '/traces', title: 'Traces', subtitle: 'Raw agent execution logs', kind: 'static' },
  { pattern: '/traces/:id', title: 'Trace', kind: 'resource' },
  { pattern: '/evals', title: 'Evaluations', subtitle: 'Per-rule eval results', kind: 'static' },
  { pattern: '/runs', title: NAV_LABELS.runs, subtitle: 'Named batches of traces, with their pass rates; compare two with an interval', kind: 'static' },
  { pattern: '/runs/:id', title: 'Run', kind: 'resource' },
  { pattern: '/cases/:key', title: 'Case', kind: 'resource' },
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
  // The wildcard (D-1): an address the router does not know still gets a title in the header.
  return ROUTE_TITLES.find((r) => r.pattern === '*');
}
