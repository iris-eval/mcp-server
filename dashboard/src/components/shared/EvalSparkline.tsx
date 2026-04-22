/*
 * EvalSparkline — issue #12 (per-rule eval-score trend).
 *
 * Renders a small sparkline (Recharts <LineChart>) showing the score
 * trend for a single eval rule across a rolling time window. Designed
 * for embedding alongside aggregated score displays so drift becomes
 * visible at a glance.
 */
import { Line, LineChart, ResponsiveContainer, YAxis } from 'recharts';

const styles = {
  wrapper: {
    display: 'inline-block',
    width: '120px',
    height: '32px',
  } as const,
  empty: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '120px',
    height: '32px',
    color: 'var(--text-muted)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    border: '1px dashed var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
  } as const,
};

export interface EvalSparklinePoint {
  /** Time the score was recorded (ISO string or Date.toString()). Used for sort. */
  timestamp: string;
  /** Score in [0, 1]. */
  score: number;
}

export interface EvalSparklineProps {
  /** Rolling-window data points. Sorted ascending by timestamp inside the component. */
  data: EvalSparklinePoint[];
  /** Optional override for the line color. Defaults to teal accent. */
  color?: string;
  /** Optional aria label. Defaults to "Eval score trend". */
  ariaLabel?: string;
}

export function EvalSparkline({
  data,
  color = 'var(--accent-primary)',
  ariaLabel = 'Eval score trend',
}: EvalSparklineProps) {
  if (data.length === 0) {
    return (
      <span style={styles.empty} role="img" aria-label="No data yet">
        no data
      </span>
    );
  }

  const sorted = [...data].sort((a, b) => a.timestamp.localeCompare(b.timestamp));

  return (
    <div style={styles.wrapper} role="img" aria-label={ariaLabel}>
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={sorted} margin={{ top: 2, right: 2, left: 2, bottom: 2 }}>
          {/* YAxis hidden but constrained to [0, 1] so visual scale is stable */}
          <YAxis hide domain={[0, 1]} />
          <Line
            type="monotone"
            dataKey="score"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}
