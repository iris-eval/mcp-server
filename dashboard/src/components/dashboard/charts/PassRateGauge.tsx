/*
 * PassRateGauge — semicircle meter for fleet pass rate.
 *
 * The Executive view's hero element — answers "is my fleet healthy?" in
 * one glance. Pure SVG (no chart lib, ~100 LOC) so it stays light, brand-
 * locked, and predictable across themes.
 *
 * Visual:
 *   Track (background semicircle) — bg-surface
 *   Fill   (foreground arc)        — accent colored by threshold
 *   Center value (huge)            — current pass rate %
 *   Sublabel                       — total evals + agent count
 *   Delta indicator                — arrow + delta vs prior period
 *
 * Threshold colors mirror StatTile semantics:
 *   ≥ 90% pass → eval-pass (green)
 *   ≥ 70% pass → eval-warn (amber)
 *   < 70% pass → eval-fail (red)
 *
 * Empty state (no evals in period) renders a CTA prompting the user to
 * run their first agent — empty in Iris is almost always an onboarding
 * moment, not an error.
 */
import type { LucideIcon } from 'lucide-react';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Icon } from '../../shared/Icon';

const styles = {
  card: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-5)',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 'var(--space-3)',
    minHeight: '260px',
    justifyContent: 'center',
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
  svg: {
    width: '100%',
    maxWidth: '280px',
    height: 'auto',
    display: 'block',
  } as const,
  centerValue: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-display-lg)',
    fontWeight: 700,
    fill: 'var(--text-primary)',
    letterSpacing: '-0.03em',
  } as const,
  centerSub: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    fill: 'var(--text-muted)',
  } as const,
  metaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
  } as const,
  delta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-pill)',
    fontWeight: 600,
  } as const,
  emptyCmd: {
    margin: 0,
    padding: 'var(--space-2) var(--space-3)',
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-secondary)',
  } as const,
  emptyTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-heading-sm)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: 0,
  } as const,
  emptyBody: {
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-secondary)',
    margin: 0,
    textAlign: 'center',
    maxWidth: '300px',
  } as const,
};

function thresholdAccent(rate: number): {
  color: string;
  label: 'pass' | 'warn' | 'fail';
} {
  if (rate >= 0.9) return { color: 'var(--eval-pass)', label: 'pass' };
  if (rate >= 0.7) return { color: 'var(--eval-warn)', label: 'warn' };
  return { color: 'var(--eval-fail)', label: 'fail' };
}

function deltaPresentation(delta?: number): {
  icon: LucideIcon;
  bg: string;
  fg: string;
  label: string;
} {
  if (delta === undefined || Number.isNaN(delta)) {
    return { icon: Minus, bg: 'var(--bg-surface)', fg: 'var(--text-muted)', label: '—' };
  }
  const pct = Math.round(delta * 100);
  if (pct > 0) {
    return {
      icon: TrendingUp,
      bg: 'rgba(34, 197, 94, 0.12)',
      fg: 'var(--eval-pass)',
      label: `+${pct}%`,
    };
  }
  if (pct < 0) {
    return {
      icon: TrendingDown,
      bg: 'rgba(239, 68, 68, 0.12)',
      fg: 'var(--eval-fail)',
      label: `${pct}%`,
    };
  }
  return { icon: Minus, bg: 'var(--bg-surface)', fg: 'var(--text-muted)', label: '0%' };
}

export interface PassRateGaugeProps {
  /** Current pass rate in [0, 1]. */
  value?: number;
  /** Delta vs prior period in absolute pass-rate points (-0.05 = down 5%). */
  delta?: number;
  /** Total evals in the period — drives the sublabel. */
  totalEvals?: number;
  /** Active agents in the period. */
  agentCount?: number;
  /** Period label (e.g. "30d"). */
  periodLabel: string;
}

export function PassRateGauge({
  value,
  delta,
  totalEvals,
  agentCount,
  periodLabel,
}: PassRateGaugeProps) {
  // Empty state — prompt the user to run their first agent.
  if (value === undefined || totalEvals === 0) {
    return (
      <div style={styles.card} role="region" aria-label="Pass rate gauge">
        <h2 style={styles.title}>Pass rate</h2>
        <h3 style={styles.emptyTitle}>No evals yet in {periodLabel}</h3>
        <p style={styles.emptyBody}>
          Run any MCP-compatible agent against Iris and your first eval lands here within seconds.
        </p>
        <code style={styles.emptyCmd}>npx @iris-eval/mcp-server</code>
      </div>
    );
  }

  const accent = thresholdAccent(value);
  const delta_ = deltaPresentation(delta);
  const pct = Math.round(value * 100);

  // Geometry — semicircle 200x110, 16px stroke.
  const W = 200;
  const H = 120;
  const cx = W / 2;
  const cy = H - 8;
  const r = 84;
  const strokeWidth = 16;

  // Polar → cartesian for arc endpoints. Start at left (180°), end at right (0°).
  const polar = (deg: number) => {
    const rad = ((180 - deg) * Math.PI) / 180;
    return { x: cx + r * Math.cos(rad), y: cy - r * Math.sin(rad) };
  };

  const trackStart = polar(0);
  const trackEnd = polar(180);
  // Clamp value to [0, 1] for arc rendering safety.
  const safe = Math.max(0, Math.min(1, value));
  const fillEnd = polar(safe * 180);

  const trackPath = `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 0 1 ${trackEnd.x} ${trackEnd.y}`;
  // Large-arc-flag stays 0 because we never sweep past 180°.
  const fillPath = `M ${trackStart.x} ${trackStart.y} A ${r} ${r} 0 0 1 ${fillEnd.x} ${fillEnd.y}`;

  return (
    <div style={styles.card} role="region" aria-label="Pass rate gauge">
      <h2 style={styles.title}>Pass rate · {periodLabel}</h2>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={styles.svg}
        role="img"
        aria-label={`Pass rate ${pct} percent, threshold ${accent.label}`}
      >
        <path
          d={trackPath}
          fill="none"
          stroke="var(--bg-surface)"
          strokeWidth={strokeWidth}
          strokeLinecap="round"
        />
        <path
          d={fillPath}
          fill="none"
          stroke={accent.color}
          strokeWidth={strokeWidth}
          strokeLinecap="round"
          style={{ transition: 'stroke-dasharray 600ms ease-out' }}
        />
        <text
          x={cx}
          y={cy - 18}
          textAnchor="middle"
          style={styles.centerValue}
        >
          {pct}%
        </text>
        <text
          x={cx}
          y={cy}
          textAnchor="middle"
          style={styles.centerSub}
        >
          {totalEvals?.toLocaleString() ?? 0} evals
        </text>
      </svg>
      <div style={styles.metaRow}>
        <span style={{ ...styles.delta, background: delta_.bg, color: delta_.fg }}>
          <Icon as={delta_.icon} size={14} />
          {delta_.label}
        </span>
        <span>vs prior {periodLabel}</span>
        {agentCount !== undefined && <span>· {agentCount} agents</span>}
      </div>
    </div>
  );
}
