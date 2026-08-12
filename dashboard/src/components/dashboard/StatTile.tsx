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

/* Static styling lives in utilities.css (.stat-tile block). Only the
 * accent/delta colors stay inline — they're chosen from data. */

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
    <div className="iris-card stat-tile">
      <div className="stat-tile__header">
        {icon && <Icon as={icon} size={14} />}
        {label}
      </div>
      <div className="stat-tile__value-row">
        <span className="stat-tile__value" style={{ color: ACCENT_COLORS[accent] }}>{value}</span>
        {delta && (
          <span className="stat-tile__delta" style={{ color: DELTA_COLORS[deltaSemantic] }}>{delta}</span>
        )}
      </div>
      {sub && <span className="stat-tile__sub">{sub}</span>}
    </div>
  );
}
