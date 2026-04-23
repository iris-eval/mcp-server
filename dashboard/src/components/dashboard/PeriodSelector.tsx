/*
 * PeriodSelector — segmented period picker (24h / 7d / 30d / 90d).
 *
 * Drives every chart on the active view. Period state is URL-encoded
 * (?period=7d) so views are shareable. Per-view defaults differ:
 *   Health  → 30d (executive timeframe)
 *   Drift   → 7d  (week-over-week comparison)
 *   Stream  → 24h (live ops timeframe)
 *
 * The selector itself doesn't know which view is active — DashboardPage
 * resolves the right default per view and passes it in.
 */
import { useSearchParams } from 'react-router-dom';

export type Period = '24h' | '7d' | '30d' | '90d';

export const PERIOD_OPTIONS: Array<{ id: Period; label: string; days: number }> = [
  { id: '24h', label: '24h', days: 1 },
  { id: '7d', label: '7d', days: 7 },
  { id: '30d', label: '30d', days: 30 },
  { id: '90d', label: '90d', days: 90 },
];

export function periodToDays(p: Period): number {
  return PERIOD_OPTIONS.find((o) => o.id === p)?.days ?? 7;
}

/**
 * Resolve the active period from the URL, falling back to the supplied
 * per-view default.
 */
export function resolvePeriod(searchParams: URLSearchParams, fallback: Period): Period {
  const raw = searchParams.get('period');
  if (raw === '24h' || raw === '7d' || raw === '30d' || raw === '90d') return raw;
  return fallback;
}

const styles = {
  group: {
    display: 'inline-flex',
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    padding: '2px',
    gap: '2px',
  } as const,
  btn: {
    appearance: 'none',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    fontWeight: 600,
    padding: '4px var(--space-2)',
    borderRadius: 'calc(var(--radius-sm) - 2px)',
    cursor: 'pointer',
    transition: 'background-color var(--transition-fast), color var(--transition-fast)',
    minWidth: '36px',
  } as const,
  btnActive: {
    background: 'var(--bg-surface)',
    color: 'var(--text-primary)',
    boxShadow: 'inset 0 0 0 1px var(--border-default)',
  } as const,
};

export interface PeriodSelectorProps {
  /** Default period for the surrounding view; used when ?period is absent. */
  defaultPeriod: Period;
}

export function PeriodSelector({ defaultPeriod }: PeriodSelectorProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const active = resolvePeriod(searchParams, defaultPeriod);

  const onPick = (p: Period) => {
    const next = new URLSearchParams(searchParams);
    if (p === defaultPeriod) {
      next.delete('period');
    } else {
      next.set('period', p);
    }
    setSearchParams(next);
  };

  return (
    <div style={styles.group} role="radiogroup" aria-label="Time period">
      {PERIOD_OPTIONS.map((opt) => {
        const isActive = opt.id === active;
        return (
          <button
            key={opt.id}
            type="button"
            role="radio"
            aria-checked={isActive}
            onClick={() => onPick(opt.id)}
            style={{ ...styles.btn, ...(isActive ? styles.btnActive : {}) }}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
