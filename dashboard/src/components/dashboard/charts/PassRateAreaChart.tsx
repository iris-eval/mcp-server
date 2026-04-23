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
  annotationTip: {
    margin: 'var(--space-2) 0 0',
    padding: 'var(--space-2) var(--space-3)',
    background: 'var(--bg-surface)',
    border: '1px dashed var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
  } as const,
  annotationGlyphRow: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    flexShrink: 0,
  } as const,
  /*
   * Visually-hidden text alternatives surface the SVG's information
   * to screen-reader + keyboard users WITHOUT affecting the sighted
   * visual. Standard "sr-only" technique: zero-size offscreen absolutely
   * positioned element that is still reachable by AT.
   *
   * This is the a11y fallback path — the SVG markers stay decorative
   * for sighted users, the hidden list carries the Links for AT users.
   * That resolves the #4a nested-interactive waiver cleanly: no
   * interactive elements live inside the SVG anymore.
   */
  srOnly: {
    position: 'absolute' as const,
    width: '1px',
    height: '1px',
    padding: 0,
    margin: '-1px',
    overflow: 'hidden',
    clip: 'rect(0, 0, 0, 0)',
    whiteSpace: 'nowrap' as const,
    border: 0,
  },
  srOnlyListItem: {
    listStyle: 'none' as const,
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

  const { areaPath, linePath, scaleX, ticksX, ticksY, plotMarkers, totalEvalsAcrossPeriod, targetLineY, yFloor, chartSummary } = useMemo(() => {
    if (!hasData) {
      return {
        areaPath: '',
        linePath: '',
        scaleX: null as null | ((d: Date) => number),
        ticksX: [] as Array<{ x: number; label: string }>,
        ticksY: [] as Array<{ y: number; label: string }>,
        plotMarkers: [] as MergedMarker[],
        totalEvalsAcrossPeriod: 0,
        targetLineY: null as number | null,
        yFloor: 0,
        chartSummary: '',
      };
    }
    const points = trend!.map((p) => ({
      ts: new Date(p.timestamp),
      passRate: p.passRate,
      total: p.evalCount,
    }));
    const xExtent = extent(points, (p) => p.ts) as [Date, Date];
    const x = scaleTime().domain(xExtent).range([padL, padL + innerW]);

    /* Y-axis auto-scale.
     *
     * Default [0, 1] makes high-pass-rate fleets (the common case) hug the
     * top of the canvas with all the visual story compressed into the top
     * 10%. Auto-scale to a sensible floor so the line uses the canvas.
     *
     * Floor strategy: round down to the nearest 10% from (min - 5pp), but
     * never above 0.7 (we always want the 70% threshold visible) and never
     * below 0. The 90% target line should remain on-canvas.
     */
    const minPass = Math.min(...points.map((p) => p.passRate));
    const computedFloor = Math.floor((minPass - 0.05) * 10) / 10;
    const yFloorComputed = Math.max(0, Math.min(0.7, computedFloor));
    const y = scaleLinear().domain([yFloorComputed, 1]).range([padT + innerH, padT]);

    const areaGen = d3area<{ ts: Date; passRate: number }>()
      .x((p) => x(p.ts))
      .y0(padT + innerH)
      .y1((p) => y(p.passRate))
      .curve(curveMonotoneX);
    const lineGen = d3line<{ ts: Date; passRate: number }>()
      .x((p) => x(p.ts))
      .y((p) => y(p.passRate))
      .curve(curveMonotoneX);

    const tickXValues = x.ticks(5);
    const xTicks = tickXValues.map((d) => ({ x: x(d), label: formatDayShort(d) }));

    /* Y ticks: 4 evenly spaced including floor and 1.0, rounded to 5%. */
    const yTickCount = 4;
    const yTickStep = (1 - yFloorComputed) / (yTickCount - 1);
    const yTicks = Array.from({ length: yTickCount }, (_, i) => {
      const v = yFloorComputed + i * yTickStep;
      return { y: y(v), label: `${Math.round(v * 100)}%` };
    });

    const filteredAudit = (auditEntries ?? []).filter((e) => {
      const t = new Date(e.ts);
      return t >= xExtent[0] && t <= xExtent[1] && (e.action === 'rule.deploy' || e.action === 'rule.delete');
    });
    const clusters = clusterMarkers(filteredAudit, x, innerW);

    /* 90% reference line — on-canvas only when the floor is below 0.9. */
    const targetLine = yFloorComputed < 0.9 ? y(0.9) : null;

    /*
     * chartSummary feeds the SVG <desc> element — screen readers read
     * this when the user focuses/explores the chart. Concrete data
     * values ("pass rate moved from X% to Y%") beat a generic label
     * like "pass rate chart" for WCAG SC 1.1.1 (non-text content).
     */
    const firstPct = Math.round(points[0].passRate * 100);
    const lastPct = Math.round(points[points.length - 1].passRate * 100);
    const minPct = Math.round(Math.min(...points.map((p) => p.passRate)) * 100);
    const maxPct = Math.round(Math.max(...points.map((p) => p.passRate)) * 100);
    const totalEvals = points.reduce((acc, p) => acc + p.total, 0);
    const summary =
      `Pass rate over ${periodLabel}: started at ${firstPct}%, ended at ${lastPct}%, ` +
      `ranged ${minPct}%–${maxPct}% across ${points.length} buckets (${totalEvals} evals). ` +
      `${clusters.length} audit annotation${clusters.length === 1 ? '' : 's'} in this window.`;

    return {
      areaPath: areaGen(points) ?? '',
      linePath: lineGen(points) ?? '',
      scaleX: x,
      ticksX: xTicks,
      ticksY: yTicks,
      plotMarkers: clusters,
      totalEvalsAcrossPeriod: totalEvals,
      targetLineY: targetLine,
      yFloor: yFloorComputed,
      chartSummary: summary,
    };
  }, [trend, auditEntries, hasData, innerW, innerH, periodLabel]);

  if (!hasData) {
    /* Skeleton empty state: render the chart shape at low opacity so the
     * card communicates "this is where the trend will go" instead of
     * "broken / blank." A canned smooth wave + the standard 90% target
     * line preview the populated layout. The annotation tip below ALSO
     * surfaces the killer feature for fresh installs that haven't yet
     * deployed any rules — they see the affordance before they need it.
     *
     * Hardcoded skeleton path: a gentle wave centered around 88-94% to
     * preview "the kind of variation you'll see on a healthy fleet."
     */
    const skelArea =
      'M 36 60 C 100 70, 160 50, 230 56 C 300 62, 360 38, 430 44 C 500 50, 560 70, 630 60 C 680 54, 700 56, 704 58 L 704 192 L 36 192 Z';
    const skelLine =
      'M 36 60 C 100 70, 160 50, 230 56 C 300 62, 360 38, 430 44 C 500 50, 560 70, 630 60 C 680 54, 700 56, 704 58';
    return (
      <div style={styles.card} role="region" aria-label={title}>
        <div style={styles.header}>
          <h3 style={styles.title}>{title} · {periodLabel}</h3>
          <div style={styles.legend}>
            <span style={styles.legendItem}>
              <Icon as={TrendingDown} size={14} />
              awaiting trend data
            </span>
          </div>
        </div>
        <div style={{ position: 'relative', width: '100%' }}>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            style={{ width: '100%', height: 'auto', display: 'block', opacity: 0.32 }}
            aria-hidden="true"
          >
            <defs>
              <linearGradient id="paAreaSkel" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--text-muted)" stopOpacity="0.45" />
                <stop offset="100%" stopColor="var(--text-muted)" stopOpacity="0.04" />
              </linearGradient>
            </defs>
            <line
              x1={padL}
              y1={padT + innerH * 0.25}
              x2={padL + innerW}
              y2={padT + innerH * 0.25}
              stroke="var(--eval-pass)"
              strokeWidth={1}
              strokeDasharray="4 5"
              opacity={0.55}
            />
            <text
              x={padL + innerW - 4}
              y={padT + innerH * 0.25 - 4}
              textAnchor="end"
              style={{ ...styles.axisLabel, fill: 'var(--eval-pass)' }}
            >
              target 90%
            </text>
            <path d={skelArea} fill="url(#paAreaSkel)" />
            <path d={skelLine} fill="none" stroke="var(--text-muted)" strokeWidth={1.25} />
          </svg>
        </div>
        <p style={{
          margin: 'var(--space-2) 0 0',
          fontSize: 'var(--text-caption)',
          color: 'var(--text-muted)',
          textAlign: 'center',
        }}>
          Need at least two buckets in {periodLabel} to chart a real trend. Run a few more agents and the line lights up.
        </p>
        <p style={styles.annotationTip}>
          <span style={styles.annotationGlyphRow} aria-hidden="true">
            <svg width="10" height="10">
              <polygon points="5,1 9,9 1,9" fill="var(--eval-warn)" />
            </svg>
            <svg width="10" height="10">
              <polygon points="1,1 9,1 5,9" fill="var(--eval-fail)" />
            </svg>
          </span>
          When you deploy or delete a rule, it&rsquo;ll annotate this chart so you can spot the impact on pass rate.
        </p>
      </div>
    );
  }

  return (
    <div style={styles.card} role="region" aria-label={title}>
      <div style={styles.header}>
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
      </div>

      <div style={{ position: 'relative', width: '100%' }}>
        <svg
          viewBox={`0 0 ${W} ${H}`}
          style={{ width: '100%', height: 'auto', display: 'block' }}
          role="img"
          aria-label={`${title} ${periodLabel} area chart`}
        >
          {/* desc provides the text equivalent per WCAG SC 1.1.1 so
           * screen-reader users get the actual data values, not just
           * "area chart — image". Paired with the hidden ol of audit
           * markers below the SVG for drill-through access. */}
          <desc>{chartSummary}</desc>
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

          {/* 90% target reference — drawn beneath the data so the area
           * sits over it. Only renders when the auto-scaled floor is
           * below 0.9 (otherwise the line would sit at canvas top). */}
          {targetLineY !== null && (
            <g aria-hidden="true">
              <line
                x1={padL}
                y1={targetLineY}
                x2={padL + innerW}
                y2={targetLineY}
                stroke="var(--eval-pass)"
                strokeWidth={1}
                strokeDasharray="4 5"
                opacity={0.55}
              />
              <text
                x={padL + innerW - 4}
                y={targetLineY - 4}
                textAnchor="end"
                style={{ ...styles.axisLabel, fill: 'var(--eval-pass)', opacity: 0.75 }}
              >
                target 90%
              </text>
            </g>
          )}

          {/* Area + line */}
          <path d={areaPath} fill="url(#paArea)" />
          <path d={linePath} fill="none" stroke="var(--iris-400)" strokeWidth={1.75} />

          {/*
           * Audit annotations — vertical ticks + glyphs. DECORATIVE: the
           * SVG elements are aria-hidden; the keyboard/screen-reader path
           * is the sr-only <ol> rendered after the SVG below. Sighted
           * mouse users still see and hover the markers; the clickable
           * area is the per-marker <Link> in the hidden list (which mouse
           * users reach via the list if they ever tab into it, but
           * typically via the existing tooltip hover).
           *
           * This arrangement retires the #4a nested-interactive waiver:
           * no interactive elements live inside the SVG.
           */}
          {plotMarkers.map((marker) => {
            const x = scaleX!(marker.ts);
            const isCluster = marker.entries.length > 1;
            const dominantAction = marker.entries.find((e) => e.action === 'rule.delete')
              ? 'rule.delete'
              : 'rule.deploy';
            const color = dominantAction === 'rule.delete' ? 'var(--eval-fail)' : 'var(--eval-warn)';
            const isUp = dominantAction === 'rule.deploy';
            const glyph = isUp ? 'M -5 4 L 5 4 L 0 -5 Z' : 'M -5 -5 L 5 -5 L 0 4 Z';
            return (
              <g
                key={marker.id}
                aria-hidden="true"
                onMouseEnter={() => setHoverMarkerId(marker.id)}
                onMouseLeave={() => setHoverMarkerId(null)}
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
              </g>
            );
          })}
        </svg>

        {/*
         * Screen-reader / keyboard access path: a visually-hidden list
         * of every annotation in the chart window, as semantic Links.
         * Populated state only — the empty-state affordance tip below
         * covers the "no audit events yet" narrative for both paths.
         */}
        {plotMarkers.length > 0 && (
          <ol style={styles.srOnly as React.CSSProperties} aria-label="Audit events in view">
            {plotMarkers.map((marker) => {
              const isCluster = marker.entries.length > 1;
              const focusEntry = marker.entries[0];
              const href = drillToAudit({
                focus: `${focusEntry.ts}:${focusEntry.ruleId}`,
              });
              const label = isCluster
                ? `${marker.entries.length} audit events around ${formatDayShort(marker.ts)}`
                : `${focusEntry.action.replace('rule.', '')} ${focusEntry.ruleName ?? focusEntry.ruleId} at ${formatDayShort(marker.ts)}`;
              return (
                <li key={marker.id} style={styles.srOnlyListItem}>
                  <Link to={href}>{label}</Link>
                </li>
              );
            })}
          </ol>
        )}

        {/* Hover tooltip — DOM overlay so it can carry rich text */}
        {hoverMarkerId && (() => {
          const m = plotMarkers.find((p) => p.id === hoverMarkerId);
          if (!m) return null;
          const left = ((scaleX!(m.ts) / W) * 100).toFixed(2) + '%';
          /* Surface the Iris-specific provenance: when the audit entry's
           * details carry a sourceMomentId, the deploy came via
           * Make-This-A-Rule — closes the loop "observed moment →
           * deployed rule → impact on pass rate" visually in the tooltip.
           * (Server stores it in details payload, see custom-rule-store.) */
          const single = m.entries[0];
          const sourceMomentId = single.details?.sourceMomentId as string | undefined;
          const fromMoment = m.entries.length === 1 && sourceMomentId
            ? ` · via Make-This-A-Rule`
            : '';
          return (
            <div style={{ ...styles.tooltipBox, left, top: padT + 'px' }}>
              {m.entries.length === 1
                ? `${single.action.replace('rule.', '')} ${single.ruleName ?? single.ruleId} · ${formatDayShort(m.ts)}${fromMoment}`
                : `${m.entries.length} events · ${formatDayShort(m.ts)} (click to inspect)`}
              <Icon as={History} size={14} />
            </div>
          );
        })()}
      </div>

      {/* Annotation affordance — when no audit events fall in the chart
       * window, surface a one-line tip explaining the killer feature.
       * Without this, a fresh-install dashboard hides the
       * Make-This-A-Rule feedback loop entirely. */}
      {plotMarkers.length === 0 && (
        <p style={styles.annotationTip}>
          <span style={styles.annotationGlyphRow} aria-hidden="true">
            <svg width="10" height="10">
              <polygon points="5,1 9,9 1,9" fill="var(--eval-warn)" />
            </svg>
            <svg width="10" height="10">
              <polygon points="1,1 9,1 5,9" fill="var(--eval-fail)" />
            </svg>
          </span>
          When you deploy or delete a rule, it&rsquo;ll annotate this chart so you can spot the impact on pass rate.
        </p>
      )}
    </div>
  );
}
