/*
 * StackedBarByDay — verdict mix per day across the period.
 *
 * The Drift view's anchor chart. Each day is a vertical bar; segments
 * within the bar are the verdict mix for that day (pass / partial / fail
 * / unevaluated), bottom-up. Brushing across bars lets the user see
 * day-of-week patterns at a glance — Mondays bad? Weekends quiet?
 *
 * Drill-through: click any bar → /moments?since={dayStart}&until={dayEnd}.
 * Click a segment → also filters by verdict.
 */
import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { utcDay } from 'd3-time';
import { utcFormat } from 'd3-time-format';
import { drillToMoments } from '../../../utils/drillThrough';
import { getVerdictVisual } from '../../moments/significance';
import type { DecisionMoment, MomentVerdict } from '../../../api/types';

interface DayBucket {
  day: Date;
  pass: number;
  partial: number;
  fail: number;
  unevaluated: number;
  total: number;
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
  legend: {
    display: 'inline-flex',
    gap: 'var(--space-3)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
  } as const,
  legendDot: {
    display: 'inline-block',
    width: 8,
    height: 8,
    borderRadius: 2,
    marginRight: 4,
    verticalAlign: 'middle',
  } as const,
  axisLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    fill: 'var(--text-muted)',
  } as const,
  empty: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
    minHeight: '180px',
    textAlign: 'center',
    padding: 'var(--space-6)',
  } as const,
};

const VERDICT_ORDER: MomentVerdict[] = ['pass', 'partial', 'fail', 'unevaluated'];
const formatDayShort = utcFormat('%a %d');

function bucketByDay(moments: DecisionMoment[], days: number): DayBucket[] {
  const today = utcDay.floor(new Date());
  const buckets: DayBucket[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = utcDay.offset(today, -i);
    buckets.push({ day, pass: 0, partial: 0, fail: 0, unevaluated: 0, total: 0 });
  }
  const dayIndex = new Map<number, DayBucket>();
  for (const b of buckets) dayIndex.set(b.day.getTime(), b);

  for (const m of moments) {
    const day = utcDay.floor(new Date(m.timestamp)).getTime();
    const bucket = dayIndex.get(day);
    if (!bucket) continue;
    bucket[m.verdict] += 1;
    bucket.total += 1;
  }
  return buckets;
}

export interface StackedBarByDayProps {
  moments?: DecisionMoment[];
  /** Number of days the chart should span. */
  days: number;
  periodLabel: string;
}

export function StackedBarByDay({ moments, days, periodLabel }: StackedBarByDayProps) {
  const navigate = useNavigate();
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);

  const buckets = useMemo(() => bucketByDay(moments ?? [], days), [moments, days]);
  const maxTotal = Math.max(1, ...buckets.map((b) => b.total));

  const W = 720;
  const H = 240;
  const padL = 36;
  const padR = 12;
  const padT = 16;
  const padB = 28;
  const innerW = W - padL - padR;
  const innerH = H - padT - padB;
  const barWidth = (innerW / buckets.length) * 0.7;
  const slotWidth = innerW / Math.max(1, buckets.length);

  const totalAcrossPeriod = buckets.reduce((acc, b) => acc + b.total, 0);

  if (totalAcrossPeriod === 0) {
    return (
      <div style={styles.card} role="region" aria-label="Verdicts per day">
        <header style={styles.header}>
          <h3 style={styles.title}>Verdicts per day · {periodLabel}</h3>
        </header>
        <div style={styles.empty}>
          No Decision Moments yet in this window. Once agents run, daily verdict mix appears here.
        </div>
      </div>
    );
  }

  return (
    <div style={styles.card} role="region" aria-label="Verdicts per day">
      <header style={styles.header}>
        <h3 style={styles.title}>Verdicts per day · {periodLabel}</h3>
        <div style={styles.legend}>
          {VERDICT_ORDER.map((v) => (
            <span key={v}>
              <span style={{ ...styles.legendDot, background: getVerdictVisual(v).color }} />
              {getVerdictVisual(v).label.toLowerCase()}
            </span>
          ))}
        </div>
      </header>

      <svg
        viewBox={`0 0 ${W} ${H}`}
        style={{ width: '100%', height: 'auto', display: 'block' }}
        role="img"
        aria-label={`Verdicts per day for ${periodLabel}`}
      >
        {/* Y gridlines + labels — 0, half, max */}
        {[0, 0.5, 1].map((frac) => {
          const y = padT + innerH - frac * innerH;
          const label = Math.round(frac * maxTotal).toLocaleString();
          return (
            <g key={`grid-${frac}`}>
              <line
                x1={padL}
                y1={y}
                x2={padL + innerW}
                y2={y}
                stroke="var(--border-subtle)"
                strokeDasharray="2 4"
                opacity="0.6"
              />
              <text x={padL - 6} y={y + 3} textAnchor="end" style={styles.axisLabel}>
                {label}
              </text>
            </g>
          );
        })}

        {buckets.map((b, i) => {
          const x = padL + i * slotWidth + (slotWidth - barWidth) / 2;
          let yCursor = padT + innerH;
          // Stack bottom-up: pass first, then partial, then fail, then unevaluated.
          const segments = VERDICT_ORDER.map((verdict) => {
            const v = b[verdict];
            const h = (v / maxTotal) * innerH;
            yCursor -= h;
            return { verdict, count: v, y: yCursor, h, color: getVerdictVisual(verdict).color };
          });

          const isHover = hoverIdx === i;

          return (
            <g
              key={b.day.getTime()}
              onMouseEnter={() => setHoverIdx(i)}
              onMouseLeave={() => setHoverIdx(null)}
              style={{ cursor: 'pointer' }}
              role="button"
              tabIndex={0}
              aria-label={`${formatDayShort(b.day)}: ${b.total} moments — pass ${b.pass}, partial ${b.partial}, fail ${b.fail}, unevaluated ${b.unevaluated}`}
              onClick={() => {
                const dayStart = b.day.toISOString();
                const dayEnd = utcDay.offset(b.day, 1).toISOString();
                navigate(drillToMoments({ since: dayStart, until: dayEnd }));
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  const dayStart = b.day.toISOString();
                  const dayEnd = utcDay.offset(b.day, 1).toISOString();
                  navigate(drillToMoments({ since: dayStart, until: dayEnd }));
                }
              }}
            >
              {/* Slot background highlight on hover */}
              <rect
                x={padL + i * slotWidth}
                y={padT}
                width={slotWidth}
                height={innerH}
                fill={isHover ? 'var(--bg-surface)' : 'transparent'}
                opacity={0.5}
              />
              {segments.map((s) =>
                s.h > 0 ? (
                  <rect
                    key={s.verdict}
                    x={x}
                    y={s.y}
                    width={barWidth}
                    height={s.h}
                    fill={s.color}
                    opacity={hoverIdx !== null && !isHover ? 0.45 : 1}
                  />
                ) : null,
              )}
              <text
                x={x + barWidth / 2}
                y={padT + innerH + 16}
                textAnchor="middle"
                style={styles.axisLabel}
              >
                {formatDayShort(b.day)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
