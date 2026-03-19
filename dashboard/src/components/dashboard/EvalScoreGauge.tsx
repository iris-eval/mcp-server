import { useEffect, useRef, useState } from 'react';

interface EvalScoreGaugeProps {
  /** Score between 0 and 1 */
  score: number;
  /** Previous score for trend delta */
  previousScore?: number;
  /** Label shown below the score */
  label?: string;
}

/* ── score → zone color ────────────────────────────── */

function zoneColor(score: number): string {
  if (score < 0.4) return '#ef4444'; // red
  if (score < 0.6) return '#f59e0b'; // amber
  if (score < 0.8) return '#0d9488'; // teal
  return '#22c55e';                  // green
}

/* ── constants ─────────────────────────────────────── */

const SIZE       = 200;
const STROKE     = 10;
const RADIUS     = (SIZE - STROKE) / 2;             // 95
const CX         = SIZE / 2;                         // 100
const CY         = SIZE / 2 + 10;                    // shifted down so arc sits centered
const ARC_LENGTH = Math.PI * RADIUS;                 // half-circle circumference

/* ── SVG arc path (180 degrees, left → right) ─────── */

function arcPath(cx: number, cy: number, r: number): string {
  // Start at the left endpoint, sweep 180 degrees clockwise to the right endpoint
  const startX = cx - r;
  const startY = cy;
  const endX   = cx + r;
  const endY   = cy;
  return `M ${startX} ${startY} A ${r} ${r} 0 0 1 ${endX} ${endY}`;
}

/* ── styles ────────────────────────────────────────── */

const containerStyle = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--border-radius-lg)',
  padding: 'var(--space-5)',
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: 'var(--space-1)',
} as const;

const scoreTextStyle = {
  fontFamily: 'var(--font-mono)',
  fontWeight: 700,
  fontSize: 'var(--font-size-3xl)',
  lineHeight: 1,
} as const;

const labelTextStyle = {
  fontSize: 'var(--font-size-xs)',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
} as const;

const trendStyle = {
  fontFamily: 'var(--font-mono)',
  fontSize: 'var(--font-size-sm)',
  fontWeight: 500,
} as const;

/* ── component ─────────────────────────────────────── */

export function EvalScoreGauge({
  score,
  previousScore,
  label = 'Eval Score',
}: EvalScoreGaugeProps) {
  const clampedScore = Math.max(0, Math.min(1, score));
  const [animatedOffset, setAnimatedOffset] = useState(ARC_LENGTH);
  const rafRef = useRef<number>(0);
  const startRef = useRef<number | null>(null);

  const targetOffset = ARC_LENGTH * (1 - clampedScore);
  const color = zoneColor(clampedScore);

  /* Animate arc fill on mount / score change */
  useEffect(() => {
    const DURATION = 800; // ms
    const fromOffset = ARC_LENGTH; // start empty

    startRef.current = null;

    function tick(timestamp: number) {
      if (startRef.current === null) startRef.current = timestamp;
      const elapsed = timestamp - startRef.current;
      const t = Math.min(elapsed / DURATION, 1);
      // ease-out cubic
      const eased = 1 - Math.pow(1 - t, 3);

      setAnimatedOffset(fromOffset + (targetOffset - fromOffset) * eased);

      if (t < 1) {
        rafRef.current = requestAnimationFrame(tick);
      }
    }

    rafRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(rafRef.current);
  }, [targetOffset]);

  /* Trend delta */
  const delta = previousScore !== undefined ? clampedScore - previousScore : undefined;
  const trendUp = delta !== undefined && delta >= 0;
  const trendSymbol = delta !== undefined ? (trendUp ? '\u25B2' : '\u25BC') : '';
  const trendColor = delta !== undefined
    ? (trendUp ? 'var(--accent-success)' : 'var(--accent-error)')
    : undefined;
  const trendText = delta !== undefined
    ? `${trendSymbol} ${trendUp ? '+' : ''}${delta.toFixed(2)}`
    : null;

  const d = arcPath(CX, CY, RADIUS);

  // Gradient ID unique per instance in case multiple gauges render
  const gradId = 'evalGaugeGrad';

  return (
    <div style={containerStyle}>
      <svg
        width={SIZE}
        height={CY + STROKE / 2 + 2}
        viewBox={`0 0 ${SIZE} ${CY + STROKE / 2 + 2}`}
        fill="none"
        aria-hidden="true"
        style={{ overflow: 'visible' }}
      >
        <defs>
          {/* Horizontal gradient mapped across the arc width */}
          <linearGradient id={gradId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%"   stopColor="#ef4444" />
            <stop offset="35%"  stopColor="#f59e0b" />
            <stop offset="65%"  stopColor="#0d9488" />
            <stop offset="100%" stopColor="#22c55e" />
          </linearGradient>
        </defs>

        {/* Background track */}
        <path
          d={d}
          stroke="var(--bg-tertiary)"
          strokeWidth={STROKE}
          strokeLinecap="round"
          fill="none"
        />

        {/* Filled arc */}
        <path
          d={d}
          stroke={`url(#${gradId})`}
          strokeWidth={STROKE}
          strokeLinecap="round"
          fill="none"
          strokeDasharray={ARC_LENGTH}
          strokeDashoffset={animatedOffset}
          style={{ filter: `drop-shadow(0 0 6px ${color}40)` }}
        />

        {/* Endpoint dot — gives the gauge a finished look */}
        {clampedScore > 0.01 && (() => {
          const angle = Math.PI - Math.PI * clampedScore;
          const dotX  = CX + RADIUS * Math.cos(angle);
          const dotY  = CY - RADIUS * Math.sin(angle);
          return (
            <circle
              cx={dotX}
              cy={dotY}
              r={STROKE / 2 + 2}
              fill={color}
              style={{
                opacity: animatedOffset <= targetOffset + 1 ? 1 : 0,
                transition: 'opacity 150ms ease',
              }}
            />
          );
        })()}
      </svg>

      {/* Score number positioned visually inside the arc */}
      <div style={{ marginTop: `calc(-1 * var(--space-10))`, textAlign: 'center' }}>
        <div style={{ ...scoreTextStyle, color }}>
          {clampedScore.toFixed(2)}
        </div>

        {/* Trend */}
        {trendText && (
          <span style={{ ...trendStyle, color: trendColor }}>
            {trendText}
          </span>
        )}
      </div>

      {/* Label */}
      <span style={labelTextStyle}>{label}</span>
    </div>
  );
}
