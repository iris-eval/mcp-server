/*
 * Sparkline — tiny inline area-chart for stat tiles. Pure SVG, no deps.
 *
 * Renders a smoothed line + faint area fill behind it. Auto-scales to
 * the data range. Currentcolor inheritance — stylize via parent.
 */

const styles = {
  svg: {
    display: 'block',
    width: '100%',
    height: '24px',
  } as const,
};

export interface SparklineProps {
  values: number[];
  /** Color override. Defaults to currentColor. */
  color?: string;
  /** Optional fixed min/max so multiple sparklines align. */
  min?: number;
  max?: number;
  /** Override height in pixels. Default 24. */
  height?: number;
  /** Optional aria-label for accessibility. */
  label?: string;
}

export function Sparkline({ values, color, min, max, height = 24, label }: SparklineProps) {
  if (values.length < 2) {
    return (
      <svg style={{ ...styles.svg, height: `${height}px` }} aria-label={label} role="img">
        <line x1="0" y1={height / 2} x2="100" y2={height / 2} stroke="currentColor" strokeWidth="1" opacity="0.2" />
      </svg>
    );
  }

  const lo = min ?? Math.min(...values);
  const hi = max ?? Math.max(...values);
  const range = hi - lo || 1;
  const w = 100;
  const h = height;
  const dx = w / (values.length - 1);

  const points = values.map((v, i) => {
    const x = i * dx;
    const y = h - 2 - ((v - lo) / range) * (h - 4);
    return [x, y] as const;
  });

  // Smoothed path using Catmull-Rom-ish midpoint segments
  let d = `M${points[0][0]} ${points[0][1]}`;
  for (let i = 1; i < points.length; i++) {
    const [px, py] = points[i - 1];
    const [cx, cy] = points[i];
    const mx = (px + cx) / 2;
    d += ` Q${px} ${py}, ${mx} ${(py + cy) / 2} T${cx} ${cy}`;
  }
  const fillD = `${d} L${w} ${h} L0 ${h} Z`;

  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      style={{ ...styles.svg, height: `${height}px`, color: color ?? 'currentColor' }}
      aria-label={label}
      role="img"
    >
      <path d={fillD} fill="currentColor" opacity="0.12" />
      <path d={d} fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
