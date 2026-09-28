/*
 * ViewTabs — segmented underline tab strip for switching dashboard views.
 *
 * Four views answer four different questions:
 *   Failures — what failed, worst-and-newest first. Default. Nothing in
 *              this category lands the user on the failure — every tool
 *              opens on a picker or an aggregate. We land on the failure;
 *              health/stats stay one click away on this strip.
 *   Health   — evals in aggregate.
 *   Drift    — what's changing this week and why.
 *   Stream   — live pulse + Decision Moments.
 *
 * View state is URL-encoded (?view=failures|health|drift|stream) so every
 * view is shareable as a link. Returning users land on whichever view they
 * last shared. First-time landing on `/` falls through to Failures.
 *
 * Visual treatment is underline-style (not pill, not segmented control)
 * because it matches the restrained chrome we already shipped — the
 * sidebar nav is a rail, the tabs are a thin underline. Two restrained
 * navigations don't fight each other.
 */
import type { KeyboardEvent, ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Activity, AlertTriangle, Heart, Waves } from 'lucide-react';
import { Icon } from '../shared/Icon';
import { onRovingKeyDown } from '../../utils/roving';

export type DashboardView = 'failures' | 'health' | 'drift' | 'stream';

export const VIEW_OPTIONS: Array<{
  id: DashboardView;
  label: string;
  icon: typeof Heart;
  description: string;
}> = [
  { id: 'failures', label: 'Failures', icon: AlertTriangle, description: 'What failed, worst and newest first' },
  { id: 'health', label: 'Health', icon: Heart, description: 'Evals in aggregate' },
  { id: 'drift', label: 'Drift', icon: Activity, description: "What's changing and why" },
  { id: 'stream', label: 'Stream', icon: Waves, description: 'Live pulse + Decision Moments' },
];

export const DEFAULT_VIEW: DashboardView = 'failures';

/** Resolve the active view from the current URL — defaults to Failures. */
export function resolveView(searchParams: URLSearchParams): DashboardView {
  const raw = searchParams.get('view');
  if (raw === 'failures' || raw === 'drift' || raw === 'stream' || raw === 'health') return raw;
  return DEFAULT_VIEW;
}

/*
 * Static styling lives in utilities.css (.view-tabs block). The active
 * state keys off aria-selected there, so the accessibility state IS the
 * visual state — the two can't drift.
 */

export interface ViewTabsProps {
  /** Optional right-aligned slot — typically the period selector. */
  trailing?: ReactNode;
}

/** The id of a view's tab; each view's panel names it in aria-labelledby. */
export const tabId = (view: DashboardView): string => `${view}-tab`;
/** The id of a view's panel. Only the active view's panel is rendered. */
export const panelId = (view: DashboardView): string => `view-panel-${view}`;

export function ViewTabs({ trailing }: ViewTabsProps) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const active = resolveView(searchParams);

  /**
   * Build the next URL for a tab click — preserve any other params (period,
   * filters) so switching views doesn't lose context.
   */
  const buildHref = (id: DashboardView): string => {
    const next = new URLSearchParams(searchParams);
    if (id === DEFAULT_VIEW) {
      next.delete('view');
    } else {
      next.set('view', id);
    }
    const qs = next.toString();
    return qs ? `/?${qs}` : '/';
  };

  /*
   * The ARIA tabs pattern (utils/roving.ts): one Tab stop for the strip,
   * the selected tab; Left, Right, Home and End move between tabs and
   * select the one they land on. The strip stays mounted across views, so
   * focus stays on that tab.
   */
  const ids = VIEW_OPTIONS.map((o) => o.id);
  const onKeyDown = (event: KeyboardEvent<HTMLAnchorElement>): void =>
    onRovingKeyDown(event, ids, active, 'horizontal', (view) => navigate(buildHref(view)));

  /*
   * The period selector sits beside the tablist, not inside it: a tablist
   * may own only tabs, and a radiogroup inside one hides the radios from
   * screen readers that walk the tablist.
   */
  return (
    <div className="view-tabs">
      <div className="view-tabs__list" role="tablist" aria-label="Dashboard view">
        {VIEW_OPTIONS.map((opt) => {
          const isActive = opt.id === active;
          return (
            <Link
              key={opt.id}
              id={tabId(opt.id)}
              to={buildHref(opt.id)}
              role="tab"
              aria-selected={isActive}
              // Only the active view's panel exists, so only its tab names one.
              aria-controls={isActive ? panelId(opt.id) : undefined}
              tabIndex={isActive ? 0 : -1}
              onKeyDown={onKeyDown}
              title={opt.description}
              className="view-tabs__tab"
            >
              <Icon as={opt.icon} size={16} />
              {opt.label}
            </Link>
          );
        })}
      </div>
      {trailing && <div className="view-tabs__hint">{trailing}</div>}
    </div>
  );
}
