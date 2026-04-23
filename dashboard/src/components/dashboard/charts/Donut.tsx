/*
 * Donut — categorical breakdown chart, drill-through wired.
 *
 * Used by Health view for verdict mix and significance mix. Built on
 * d3-shape's pie + arc generators (no React-bound chart lib — keeps the
 * markup ours, the bundle small, and React 19 happy).
 *
 * Visual:
 *   Concentric ring, 12px stroke. Slices use the brand semantic palette
 *   passed in by the caller. Center hole shows the total + label so the
 *   donut answers BOTH "what's the breakdown?" and "what's the total?"
 *   in one read.
 *
 * Interaction:
 *   Each slice is a Link (drill-through). Hover/focus brightens the slice
 *   and shows a side legend row with the matching color swatch + count.
 *
 * Empty state:
 *   When total === 0, renders a muted placeholder ring + "no data" copy.
 *   Caller can override `emptyMessage` to make it onboarding-shaped.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { pie as d3pie, arc as d3arc } from 'd3-shape';

export interface DonutSlice {
  /** Stable id used as React key + drill-through key. */
  id: string;
  /** Display label in the legend. */
  label: string;
  /** Numeric value (raw count or weight). */
  value: number;
  /** CSS color string — typically a `var(--…)` brand token. */
  color: string;
  /** Drill-through href (optional — if absent, slice is non-interactive). */
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
    alignItems: 'baseline',
    justifyContent: 'space-between',
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
  total: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
  } as const,
  body: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: 'var(--space-4)',
    alignItems: 'center',
  } as const,
  svg: {
    width: '160px',
    height: '160px',
    flexShrink: 0,
  } as const,
  centerValue: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-display-sm)',
    fontWeight: 700,
    fill: 'var(--text-primary)',
    letterSpacing: '-0.02em',
  } as const,
  centerLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    fill: 'var(--text-muted)',
    textTransform: 'uppercase',
    letterSpacing: '0.06em',
  } as const,
  legend: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1_5)',
    minWidth: 0,
  } as const,
  legendRow: {
    display: 'grid',
    gridTemplateColumns: '12px 1fr auto',
    gap: 'var(--space-2)',
    alignItems: 'center',
    padding: '4px 6px',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-primary)',
    textDecoration: 'none',
    transition: 'background-color var(--transition-fast)',
    cursor: 'pointer',
  } as const,
  legendRowStatic: {
    cursor: 'default',
  } as const,
  swatch: {
    width: '12px',
    height: '12px',
    borderRadius: '3px',
    border: '1px solid var(--border-subtle)',
  } as const,
  legendLabel: {
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  legendValue: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
  } as const,
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-2)',
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
    minHeight: '160px',
  } as const,
};

export interface DonutProps {
  title: string;
  slices: DonutSlice[];
  /** Single-word noun shown in the donut hole below the total (e.g., "evals"). */
  centerLabel?: string;
  /** Empty state copy when slices sum to zero. */
  emptyMessage?: string;
}

export function Donut({ title, slices, centerLabel = 'total', emptyMessage }: DonutProps) {
  const [hoverId, setHoverId] = useState<string | null>(null);
  const total = slices.reduce((acc, s) => acc + s.value, 0);

  const arcs = useMemo(() => {
    if (total === 0) return [];
    const generator = d3pie<DonutSlice>()
      .value((s) => s.value)
      .sort(null)
      .padAngle(0.012);
    const arcGen = d3arc<{
      startAngle: number;
      endAngle: number;
      data: DonutSlice;
    }>()
      .innerRadius(46)
      .outerRadius(72)
      .cornerRadius(2);
    return generator(slices).map((seg) => ({
      slice: seg.data,
      d: arcGen(seg) ?? '',
    }));
  }, [slices, total]);

  if (total === 0) {
    /* Skeleton: muted ring + placeholder legend rows that show the
     * layout the populated state will use. Slice colors come from the
     * caller so even the empty state previews the brand palette. */
    const skeletonSlices = slices.slice(0, 4);
    return (
      <div style={styles.card} role="region" aria-label={title}>
        <div style={styles.header}>
          <h3 style={styles.title}>{title}</h3>
          <span style={styles.total}>0 {centerLabel}</span>
        </div>
        <div style={styles.body}>
          <svg viewBox="-80 -80 160 160" style={styles.svg} aria-hidden="true">
            <circle cx="0" cy="0" r="59" fill="none" stroke="var(--bg-surface)" strokeWidth="26" />
            <text x={0} y={-2} textAnchor="middle" style={styles.centerValue} opacity={0.4}>
              0
            </text>
            <text x={0} y={14} textAnchor="middle" style={styles.centerLabel} opacity={0.4}>
              {centerLabel}
            </text>
          </svg>
          <ul style={styles.legend} aria-hidden="true">
            {skeletonSlices.map((s) => (
              <li
                key={s.id}
                style={{ ...styles.legendRow, ...styles.legendRowStatic, opacity: 0.32, listStyle: 'none' }}
              >
                <span style={{ ...styles.swatch, background: s.color }} />
                <span style={styles.legendLabel}>{s.label}</span>
                <span style={styles.legendValue}>—</span>
              </li>
            ))}
          </ul>
        </div>
        <p style={{
          margin: 0,
          fontSize: 'var(--text-caption)',
          color: 'var(--text-muted)',
          textAlign: 'center',
          padding: '0 var(--space-3) var(--space-2)',
        }}>
          {emptyMessage ?? 'No data in this period'}
        </p>
      </div>
    );
  }

  return (
    <div style={styles.card} role="region" aria-label={title}>
      <div style={styles.header}>
        <h3 style={styles.title}>{title}</h3>
        <span style={styles.total}>{total.toLocaleString()} {centerLabel}</span>
      </div>
      <div style={styles.body}>
        <svg viewBox="-80 -80 160 160" style={styles.svg} role="img" aria-label={`${title} donut chart`}>
          {/* desc gives the text equivalent for screen-reader users;
           * the visible legend ul provides keyboard drill-through Links
           * per slice. */}
          <desc>
            {title}: {total.toLocaleString()} {centerLabel}.{' '}
            {slices
              .filter((s) => s.value > 0)
              .map((s) => `${s.label} ${Math.round((s.value / total) * 100)}% (${s.value.toLocaleString()})`)
              .join(', ')}
            .
          </desc>
          {arcs.map(({ slice, d }) => {
            const isHover = hoverId === slice.id;
            return (
              <path
                key={slice.id}
                d={d}
                fill={slice.color}
                opacity={hoverId && !isHover ? 0.45 : 1}
                style={{ transition: 'opacity var(--transition-fast)' }}
              />
            );
          })}
          <text x={0} y={-2} textAnchor="middle" style={styles.centerValue}>
            {total.toLocaleString()}
          </text>
          <text x={0} y={14} textAnchor="middle" style={styles.centerLabel}>
            {centerLabel}
          </text>
        </svg>
        <ul style={styles.legend}>
          {slices
            .filter((s) => s.value > 0)
            .map((slice) => {
              const pct = Math.round((slice.value / total) * 100);
              const interactive = Boolean(slice.href);
              return (
                <li key={slice.id} style={{ listStyle: 'none' }}>
                  {interactive ? (
                    <Link
                      to={slice.href!}
                      aria-label={`${slice.label}: ${slice.value} (${pct}%) — drill into moments`}
                      style={{
                        ...styles.legendRow,
                        background: hoverId === slice.id ? 'var(--bg-surface)' : 'transparent',
                      }}
                      onMouseEnter={() => setHoverId(slice.id)}
                      onMouseLeave={() => setHoverId(null)}
                      onFocus={() => setHoverId(slice.id)}
                      onBlur={() => setHoverId(null)}
                    >
                      <span style={{ ...styles.swatch, background: slice.color }} aria-hidden="true" />
                      <span style={styles.legendLabel}>{slice.label}</span>
                      <span style={styles.legendValue}>
                        {slice.value.toLocaleString()} · {pct}%
                      </span>
                    </Link>
                  ) : (
                    <div
                      style={{
                        ...styles.legendRow,
                        ...styles.legendRowStatic,
                        background: hoverId === slice.id ? 'var(--bg-surface)' : 'transparent',
                      }}
                    >
                      <span style={{ ...styles.swatch, background: slice.color }} aria-hidden="true" />
                      <span style={styles.legendLabel}>{slice.label}</span>
                      <span style={styles.legendValue}>
                        {slice.value.toLocaleString()} · {pct}%
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
        </ul>
      </div>
    </div>
  );
}
