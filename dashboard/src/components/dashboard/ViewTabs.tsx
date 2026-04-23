/*
 * ViewTabs — segmented underline tab strip for switching dashboard views.
 *
 * Three views answer three different BI questions:
 *   Health  — fleet wellness in aggregate. Default.
 *   Drift   — what's changing this week and why.
 *   Stream  — live pulse + Decision Moments.
 *
 * View state is URL-encoded (?view=health|drift|stream) so every view is
 * shareable as a link. Returning users land on whichever view they last
 * shared. First-time landing on `/` falls through to Health.
 *
 * Visual treatment is underline-style (not pill, not segmented control)
 * because it matches the restrained chrome we already shipped — the
 * sidebar nav is a rail, the tabs are a thin underline. Two restrained
 * navigations don't fight each other.
 */
import type { ReactNode } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, Heart, Waves } from 'lucide-react';
import { Icon } from '../shared/Icon';

export type DashboardView = 'health' | 'drift' | 'stream';

export const VIEW_OPTIONS: Array<{
  id: DashboardView;
  label: string;
  icon: typeof Heart;
  description: string;
}> = [
  { id: 'health', label: 'Health', icon: Heart, description: 'Fleet wellness in aggregate' },
  { id: 'drift', label: 'Drift', icon: Activity, description: "What's changing and why" },
  { id: 'stream', label: 'Stream', icon: Waves, description: 'Live pulse + Decision Moments' },
];

export const DEFAULT_VIEW: DashboardView = 'health';

/** Resolve the active view from the current URL — defaults to Health. */
export function resolveView(searchParams: URLSearchParams): DashboardView {
  const raw = searchParams.get('view');
  if (raw === 'drift' || raw === 'stream' || raw === 'health') return raw;
  return DEFAULT_VIEW;
}

const styles = {
  strip: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    borderBottom: '1px solid var(--border-subtle)',
    marginBottom: 'var(--space-5)',
    paddingBottom: 0,
  } as const,
  tab: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    padding: 'var(--space-2) var(--space-3)',
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-body-sm)',
    fontWeight: 600,
    color: 'var(--text-muted)',
    textDecoration: 'none',
    borderBottom: '2px solid transparent',
    marginBottom: '-1px',
    transition: 'color var(--transition-fast), border-color var(--transition-fast)',
    cursor: 'pointer',
    letterSpacing: '-0.01em',
  } as const,
  tabActive: {
    color: 'var(--text-primary)',
    borderBottomColor: 'var(--iris-500)',
  } as const,
  tabHint: {
    fontSize: 'var(--text-caption-xs)',
    color: 'var(--text-muted)',
    marginLeft: 'auto',
    fontFamily: 'var(--font-mono)',
    paddingLeft: 'var(--space-3)',
  } as const,
};

export interface ViewTabsProps {
  /** Optional right-aligned slot — typically the period selector. */
  trailing?: ReactNode;
}

export function ViewTabs({ trailing }: ViewTabsProps) {
  const [searchParams] = useSearchParams();
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

  return (
    <div style={styles.strip} role="tablist" aria-label="Dashboard view">
      {VIEW_OPTIONS.map((opt) => {
        const isActive = opt.id === active;
        return (
          <Link
            key={opt.id}
            to={buildHref(opt.id)}
            role="tab"
            aria-selected={isActive}
            aria-controls={`view-panel-${opt.id}`}
            title={opt.description}
            style={{ ...styles.tab, ...(isActive ? styles.tabActive : {}) }}
          >
            <Icon as={opt.icon} size={16} />
            {opt.label}
          </Link>
        );
      })}
      {trailing && <div style={styles.tabHint}>{trailing}</div>}
    </div>
  );
}
