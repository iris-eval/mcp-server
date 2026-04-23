/*
 * StatTile — compact stat tile for the dashboard's Row 1 (HEALTH AT A
 * GLANCE). Replaces v1's StatCards with a denser, role-aware variant
 * that fits 4-up at the dashboard's content width.
 *
 * Each tile shows label / value / sub-line / optional trend delta.
 * Optional `accent` switches the value color to one of the eval-semantic
 * tokens (pass / warn / fail / iris) for at-a-glance scanning.
 */
import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import { Icon } from '../shared/Icon';

const styles = {
  tile: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-4) var(--space-5)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
    minHeight: '110px',
    transition: 'border-color var(--transition-fast)',
  } as const,
  header: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    fontSize: 'var(--text-caption-xs)',
    fontWeight: 600,
    fontFamily: 'var(--font-body)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
    color: 'var(--text-muted)',
  } as const,
  valueRow: {
    display: 'flex',
    alignItems: 'baseline',
    gap: 'var(--space-2)',
  } as const,
  value: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-display-sm)',
    fontWeight: 700,
    lineHeight: 'var(--leading-display)',
    color: 'var(--text-primary)',
    letterSpacing: '-0.02em',
  } as const,
  delta: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    fontWeight: 500,
  } as const,
  sub: {
    fontSize: 'var(--text-caption)',
    color: 'var(--text-secondary)',
  } as const,
};

export interface StatTileProps {
  label: string;
  /** Pre-formatted value. */
  value: ReactNode;
  /** Sub-line under the value. Optional. */
  sub?: ReactNode;
  /** Optional small icon next to the label. */
  icon?: LucideIcon;
  /** Optional eval-semantic accent for the value color. */
  accent?: 'pass' | 'warn' | 'fail' | 'iris' | 'neutral';
  /** Optional trend delta string with sign (e.g., "▲ +1.3pp"). */
  delta?: string;
  /** Optional delta semantic — colors the delta string. */
  deltaSemantic?: 'pass' | 'fail' | 'neutral';
}

const ACCENT_COLORS: Record<NonNullable<StatTileProps['accent']>, string> = {
  pass: 'var(--eval-pass)',
  warn: 'var(--eval-warn)',
  fail: 'var(--eval-fail)',
  iris: 'var(--text-accent)',
  neutral: 'var(--text-primary)',
};

const DELTA_COLORS: Record<NonNullable<StatTileProps['deltaSemantic']>, string> = {
  pass: 'var(--eval-pass)',
  fail: 'var(--eval-fail)',
  neutral: 'var(--text-muted)',
};

export function StatTile({
  label,
  value,
  sub,
  icon,
  accent = 'neutral',
  delta,
  deltaSemantic = 'neutral',
}: StatTileProps) {
  return (
    <div style={styles.tile}>
      <div style={styles.header}>
        {icon && <Icon as={icon} size={14} />}
        {label}
      </div>
      <div style={styles.valueRow}>
        <span style={{ ...styles.value, color: ACCENT_COLORS[accent] }}>{value}</span>
        {delta && (
          <span style={{ ...styles.delta, color: DELTA_COLORS[deltaSemantic] }}>{delta}</span>
        )}
      </div>
      {sub && <span style={styles.sub}>{sub}</span>}
    </div>
  );
}
