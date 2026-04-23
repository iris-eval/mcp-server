/*
 * HorizontalBarChart — generic categorical bars sorted descending.
 *
 * Used by Drift for cost-by-agent + failures-by-category. Each bar carries
 * a label, value, optional secondary value (e.g., "% of total"), and an
 * optional drill-through href.
 *
 * Pure SVG, brand-locked. Bars use the iris-500 accent by default but
 * accept a per-bar color override (e.g., to match verdict semantics).
 */
import { useMemo } from 'react';
import { Link } from 'react-router-dom';

export interface HorizontalBar {
  id: string;
  label: string;
  value: number;
  /** Optional secondary text shown after value (e.g., "12%"). */
  secondary?: string;
  /** Optional bar color override. Defaults to iris-500. */
  color?: string;
  /** Optional drill-through href. */
  href?: string;
}

const styles = {
  card: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-5)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
    minHeight: '260px',
  } as const,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 'var(--space-2)',
  } as const,
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-caption)',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    margin: 0,
  } as const,
  hint: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    color: 'var(--text-muted)',
  } as const,
  list: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1_5)',
  } as const,
  row: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: '4px',
    padding: '6px 8px',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-primary)',
    textDecoration: 'none',
    transition: 'background-color var(--transition-fast)',
  } as const,
  rowInteractive: {
    cursor: 'pointer',
  } as const,
  meta: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 'var(--space-2)',
  } as const,
  label: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-body-sm)',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  value: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
  } as const,
  track: {
    height: '6px',
    background: 'var(--bg-surface)',
    borderRadius: 'var(--radius-pill)',
    overflow: 'hidden',
  } as const,
  fill: {
    height: '100%',
    borderRadius: 'var(--radius-pill)',
    transition: 'width var(--transition-base)',
  } as const,
  empty: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
    textAlign: 'center',
    padding: 'var(--space-3) var(--space-3) var(--space-1)',
  } as const,
  /* Skeleton placeholders use ~30% opacity so they read as "the shape of
   * what's coming" rather than "fake data." Three rows is enough to
   * communicate the bar layout without crowding. */
  skeletonRow: {
    display: 'grid',
    gridTemplateColumns: '1fr',
    gap: '4px',
    padding: '6px 8px',
    opacity: 0.32,
  } as const,
  skeletonLabelRow: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 'var(--space-2)',
  } as const,
  skeletonLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-muted)',
  } as const,
};

export interface HorizontalBarChartProps {
  title: string;
  bars: HorizontalBar[];
  /** Subtitle, e.g. "by agent · last 7d". */
  hint?: string;
  /** Optional unit appended to each bar's value (e.g., "$"). */
  formatValue?: (n: number) => string;
  /** Empty state copy. */
  emptyMessage?: string;
}

export function HorizontalBarChart({
  title,
  bars,
  hint,
  formatValue = (n) => n.toLocaleString(),
  emptyMessage,
}: HorizontalBarChartProps) {
  const sorted = useMemo(() => [...bars].sort((a, b) => b.value - a.value).slice(0, 8), [bars]);
  const max = Math.max(1, ...sorted.map((b) => b.value));

  return (
    <div style={styles.card} role="region" aria-label={title}>
      <div style={styles.header}>
        <h3 style={styles.title}>{title}</h3>
        {hint && <span style={styles.hint}>{hint}</span>}
      </div>

      {sorted.length === 0 && (
        <>
          <div style={styles.list} aria-hidden="true">
            {[68, 44, 28].map((pct, i) => (
              <div key={i} style={styles.skeletonRow}>
                <div style={styles.skeletonLabelRow}>
                  <span style={styles.skeletonLabel}>—</span>
                  <span style={styles.skeletonLabel}>—</span>
                </div>
                <div style={styles.track}>
                  <div style={{ ...styles.fill, width: `${pct}%`, background: 'var(--text-muted)' }} />
                </div>
              </div>
            ))}
          </div>
          <div style={styles.empty}>{emptyMessage ?? 'No data in this window.'}</div>
        </>
      )}

      <div style={styles.list}>
        {sorted.map((bar) => {
          const pct = (bar.value / max) * 100;
          const color = bar.color ?? 'var(--iris-500)';
          const interactive = Boolean(bar.href);
          const Row: React.ElementType = interactive ? Link : 'div';
          const rowProps = interactive ? { to: bar.href! } : {};
          return (
            <Row
              key={bar.id}
              {...rowProps}
              style={{ ...styles.row, ...(interactive ? styles.rowInteractive : {}) }}
            >
              <div style={styles.meta}>
                <span style={styles.label} title={bar.label}>{bar.label}</span>
                <span style={styles.value}>
                  {formatValue(bar.value)}
                  {bar.secondary && <> · {bar.secondary}</>}
                </span>
              </div>
              <div style={styles.track} aria-hidden="true">
                <div style={{ ...styles.fill, width: `${pct}%`, background: color }} />
              </div>
            </Row>
          );
        })}
      </div>
    </div>
  );
}
