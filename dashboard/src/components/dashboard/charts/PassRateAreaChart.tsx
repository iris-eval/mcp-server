/*
 * PassRateAreaChart — pass rate over time, annotated with audit-log events.
 *
 * The killer story for the Health view. Renders an area chart of pass rate
 * across the selected period, then overlays vertical-tick markers at each
 * `rule.deploy` / `rule.delete` audit event. When pass rate drops, the
 * user sees the marker right before — closing the loop on
 * Make-This-A-Rule (deploy a rule → see its impact → revert if needed).
 *
 * We deliberately do NOT claim causation. Markers are events, not arrows.
 * The visual makes correlation legible; interpretation is the user's.
 *
 * Data flow:
 *   useEvalTrend(period)              → bucket time series
 *   useAuditLog({since, action filter}) → event markers
 *   merged in this component, rendered via d3-shape area + linePath
 *
 * Cluster behavior: when more than 3 markers fall within ~5% of chart
 * width, we collapse them into a single count-badge marker that pops out
 * the full list on hover.
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { area as d3area, line as d3line, curveMonotoneX } from 'd3-shape';
import { scaleLinear, scaleTime } from 'd3-scale';
import { extent } from 'd3-array';
import { utcFormat } from 'd3-time-format';
import { TrendingDown, History } from 'lucide-react';
import { Icon } from '../../shared/Icon';
import { drillToAudit } from '../../../utils/drillThrough';
import type { AuditLogEntry, EvalTrendPoint } from '../../../api/types';

export interface PassRateAreaChartProps {
  /** Trend buckets — typically from useEvalTrend(period). */
  trend?: EvalTrendPoint[];
  /** Audit entries within the same window. Used as annotations. */
  auditEntries?: AuditLogEntry[];
  /** Period label shown in the empty state. */
  periodLabel: string;
  /** Optional title override. */
  title?: string;
  /** SVG height in pixels. */
  height?: number;
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
    minHeight: '280px',
  } as const,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    gap: 'var(--space-3)',
    flexWrap: 'wrap',
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
  legend: {
    display: 'inline-flex',
    gap: 'var(--space-3)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
  } as const,
  legendItem: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
  } as const,
  axisLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    fill: 'var(--text-muted)',
  } as const,
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 'var(--space-2)',
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
    minHeight: '180px',
  } as const,
  markerLink: {
    cursor: 'pointer',
    textDecoration: 'none',
  } as const,
  tooltipBox: {
    background: 'var(--bg-surface)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--space-2) var(--space-3)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-primary)',
    pointerEvents: 'none' as const,
    whiteSpace: 'nowrap' as const,
    boxShadow: 'var(--shadow-md)',
    position: 'absolute' as const,
    transform: 'translate(-50%, calc(-100% - 8px))',
    zIndex: 10,
  },
};

interface MergedMarker {
  /** Stable key. */
  id: string;
  /** Event timestamp. */
  ts: Date;
  /** Cluster: array of audit entries this marker represents. */
  entries: AuditLogEntry[];
}

function clusterMarkers(
  markers: AuditLogEntry[],
  scaleX: (d: Date) => number,
  width: number,
): MergedMarker[] {
  if (markers.length === 0) return [];
  // 5% of plot width = cluster threshold
  const threshold = width * 0.05;
  const sorted = [...markers].sort((a, b) => +new Date(a.ts) - +new Date(b.ts));
  const clusters: MergedMarker[] = [];
  let current: MergedMarker | null = null;
  for (const entry of sorted) {
    const ts = new Date(entry.ts);
    const x = scaleX(ts);
    if (current && Math.abs(x - scaleX(current.ts)) < threshold) {
      current.entries.push(entry);
    } else {
      current = {
        id: `m-${entry.ts}-${entry.ruleId}-${clusters.length}`,
        ts,
        entries: [entry],
      };
      clusters.push(current);
    }
  }
  return clusters;
}

const formatDayShort = utcFormat('%b %d');

export function PassRateAreaChart({
  trend,
  auditEntries,
  periodLabel,
  title = 'Pass rate trend',
  height = 220,
}: PassRateAreaChartProps) {
  const [hoverMarkerId, setHoverMarkerId] = useState<string | null>(null);

  const hasData = trend && trend.length >= 2;

  // Geometry
  const W = 720;
  const H = height;
  const padL = 36;
  const padR = 16;
  const padT = 16;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const { areaPath, linePath, scaleX, ticksX, ticksY, plotMarkers, totalEvalsAcrossPeriod } = useMemo(() => {
    if (!hasData) {
      return {
        areaPath: '',
        linePath: '',
        scaleX: null as null | ((d: Date) => number),
        ticksX: [] as Array<{ x: number; label: string }>,
        ticksY: [] as Array<{ y: number; label: string }>,
        plotMarkers: [] as MergedMarker[],
        totalEvalsAcrossPeriod: 0,
      };
    }
    const points = trend!.map((p) => ({
      ts: new Date(p.timestamp),
      passRate: p.passRate,
      total: p.evalCount,
    }));
    const xExtent = extent(points, (p) => p.ts) as [Date, Date];
    const x = scaleTime().domain(xExtent).range([padL, padL + innerW]);
    const y = scaleLinear().domain([0, 1]).range([padT + innerH, padT]);

    const areaGen = d3area<{ ts: Date; passRate: number }>()
      .x((p) => x(p.ts))
      .y0(padT + innerH)
      .y1((p) => y(p.passRate))
      .curve(curveMonotoneX);
    const lineGen = d3line<{ ts: Date; passRate: number }>()
      .x((p) => x(p.ts))
      .y((p) => y(p.passRate))
      .curve(curveMonotoneX);

    // Time ticks: 5 evenly spaced markers along the x axis.
    const tickXValues = x.ticks(5);
    const xTicks = tickXValues.map((d) => ({ x: x(d), label: formatDayShort(d) }));
    const yTicks = [0, 0.5, 1].map((v) => ({ y: y(v), label: `${Math.round(v * 100)}%` }));

    const filteredAudit = (auditEntries ?? []).filter((e) => {
      const t = new Date(e.ts);
      return t >= xExtent[0] && t <= xExtent[1] && (e.action === 'rule.deploy' || e.action === 'rule.delete');
    });
    const clusters = clusterMarkers(filteredAudit, x, innerW);

    return {
      areaPath: areaGen(points) ?? '',
      linePath: lineGen(points) ?? '',
      scaleX: x,
      ticksX: xTicks,
      ticksY: yTicks,
      plotMarkers: clusters,
      totalEvalsAcrossPeriod: points.reduce((acc, p) => acc + p.total, 0),
    };
  }, [trend, auditEntries, hasData, innerW, innerH]);

  if (!hasData) {
    return (
      <div style={styles.card} role="region" aria-label={title}>
        <header style={styles.header}>
          <h3 style={styles.title}>{title} · {periodLabel}</h3>
        </header>
        <div style={styles.empty}>
          <Icon as={TrendingDown} size={24} />
          <span>Not enough data yet — need at least two buckets in {periodLabel} to chart a trend.</span>
        </div>
      </div>
    );
  }

  return (
    <div style={styles.card} role="region" aria-label={title}>
      <header style={styles.header}>
        <h3 style={styles.title}>{title} · {periodLabel}</h3>
        <div style={styles.legend}>
          <span style={styles.legendItem}>
            <svg width="10" height="10" aria-hidden="true">
              <rect width="10" height="10" rx="2" fill="var(--iris-500)" opacity="0.4" />
            </svg>
            pass rate
          </span>
          <span style={styles.legendItem}>
            <svg width="10" height="10" aria-hidden="true">
              <polygon points="5,1 9,9 1,9" fill="var(--eval-warn)" />
            </svg>
            deploy
          </span>
          <span style={styles.legendItem}>
            <svg width="10" height="10" aria-hidden="true">
              <polygon points="1,1 9,1 5,9" fill="var(--eval-fail)" />
            </svg>
            delete
          </span>
          <span style={styles.legendItem}>{totalEvalsAcrossPeriod.toLocaleString()} evals</span>
        </div>
      </header>

      <div style={{ position: 'relative', width: '100%' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', height: 'auto', display: 'block' }}
          role="img"
          aria-label={`${title} ${periodLabel} area chart`}
        >
          <defs>
            <linearGradient id="paArea" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--iris-500)" stopOpacity="0.45" />
              <stop offset="100%" stopColor="var(--iris-500)" stopOpacity="0.04" />
            </linearGradient>
          </defs>

          {/* Y gridlines + labels */}
          {ticksY.map((t) => (
            <g key={`y-${t.label}`}>
              <line
                x1={padL}
                y1={t.y}
                x2={padL + innerW}
                y2={t.y}
                stroke="var(--border-subtle)"
                strokeDasharray="2 4"
                opacity="0.6"
              />
              <text x={padL - 6} y={t.y + 3} textAnchor="end" style={styles.axisLabel}>
                {t.label}
              </text>
            </g>
          ))}

          {/* X tick labels */}
          {ticksX.map((t) => (
            <text
              key={`x-${t.label}`}
              x={t.x}
              y={padT + innerH + 16}
              textAnchor="middle"
              style={styles.axisLabel}
            >
              {t.label}
            </text>
          ))}

          {/* Area + line */}
          <path d={areaPath} fill="url(#paArea)" />
          <path d={linePath} fill="none" stroke="var(--iris-400)" strokeWidth={1.75} />

          {/* Audit annotations — vertical ticks + glyphs */}
          {plotMarkers.map((marker) => {
            const x = scaleX!(marker.ts);
            const isCluster = marker.entries.length > 1;
            const dominantAction = marker.entries.find((e) => e.action === 'rule.delete')
              ? 'rule.delete'
              : 'rule.deploy';
            const color = dominantAction === 'rule.delete' ? 'var(--eval-fail)' : 'var(--eval-warn)';
            const isUp = dominantAction === 'rule.deploy';
            const glyph = isUp ? 'M -5 4 L 5 4 L 0 -5 Z' : 'M -5 -5 L 5 -5 L 0 4 Z';
            const focusEntry = marker.entries[0];
            const href = drillToAudit({
              focus: `${focusEntry.ts}:${focusEntry.ruleId}`,
            });
            const ariaLabel = isCluster
              ? `${marker.entries.length} audit events around ${formatDayShort(marker.ts)}`
              : `${focusEntry.action.replace('rule.', '')} ${focusEntry.ruleName ?? focusEntry.ruleId} at ${formatDayShort(marker.ts)}`;
            return (
              <Link
                key={marker.id}
                to={href}
                aria-label={ariaLabel}
                style={styles.markerLink}
                onMouseEnter={() => setHoverMarkerId(marker.id)}
                onMouseLeave={() => setHoverMarkerId(null)}
                onFocus={() => setHoverMarkerId(marker.id)}
                onBlur={() => setHoverMarkerId(null)}
              >
                <line
                  x1={x}
                  y1={padT}
                  x2={x}
                  y2={padT + innerH}
                  stroke={color}
                  strokeWidth={hoverMarkerId === marker.id ? 1.5 : 1}
                  strokeDasharray="3 3"
                  opacity={hoverMarkerId && hoverMarkerId !== marker.id ? 0.25 : 0.7}
                />
                <g transform={`translate(${x}, ${padT - 2})`}>
                  <path d={glyph} fill={color} stroke="var(--bg-card)" strokeWidth={1.5} />
                  {isCluster && (
                    <text
                      x={8}
                      y={3}
                      style={{ ...styles.axisLabel, fill: color, fontWeight: 700 }}
                    >
                      ×{marker.entries.length}
                    </text>
                  )}
                </g>
              </Link>
            );
          })}
        </svg>

        {/* Hover tooltip — DOM overlay so it can carry rich text */}
        {hoverMarkerId && (() => {
          const m = plotMarkers.find((p) => p.id === hoverMarkerId);
          if (!m) return null;
          const left = ((scaleX!(m.ts) / W) * 100).toFixed(2) + '%';
          return (
            <div style={{ ...styles.tooltipBox, left, top: padT + 'px' }}>
              {m.entries.length === 1
                ? `${m.entries[0].action.replace('rule.', '')} ${m.entries[0].ruleName ?? m.entries[0].ruleId} · ${formatDayShort(m.ts)}`
                : `${m.entries.length} events · ${formatDayShort(m.ts)} (click to inspect)`}
              <Icon as={History} size={14} />
            </div>
          );
        })()}
      </div>
    </div>
  );
}
