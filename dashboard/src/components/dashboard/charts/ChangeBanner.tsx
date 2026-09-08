/*
 * ChangeBanner — Drift view's narrative summary.
 *
 * One-liner banner at the top of Drift that compresses the "what
 * changed" story into 3 deltas: pass rate, cost, failure-mix shift.
 * The page already shows the raw numbers; the banner gives the user
 * the headline they would have written themselves.
 *
 * Tone:
 *   - Neutral & factual ("Pass rate +3% · Cost +12% · 2 new failure
 *     categories")
 *   - No editorializing ("things look great!" — the user decides)
 *   - Color-coded per-delta so the eye picks up severity at a glance
 *
 * Empty / first-period state: shows a "no comparison yet" placeholder
 * banner — Drift is meaningless without a prior window to compare to.
 *
 * The pass-rate delta is TESTED, not eyeballed. It used to be a bare
 * subtraction between two windows, which reads as a finding at any sample
 * size: "pass rate down 33 points" over three traces is one trace. The
 * server now returns both denominators and a 95% interval on the difference
 * — from the same newcombeDifference the proof harness uses — and below a
 * minimum per window it returns no direction at all. This component renders
 * that answer and never computes its own.
 */
import { TrendingUp, TrendingDown, Minus, AlertTriangle, Sparkles } from 'lucide-react';
import { Icon } from '../../shared/Icon';
import type { DecisionMoment, DriftComparison } from '../../../api/types';
import { LOW_SIGNAL_KINDS } from '../../moments/significance';

const styles = {
  banner: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-3) var(--space-4)',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    flexWrap: 'wrap',
  } as const,
  icon: {
    color: 'var(--iris-400)',
    flexShrink: 0,
  } as const,
  prose: {
    fontSize: 'var(--text-body)',
    color: 'var(--text-primary)',
    margin: 0,
    flex: '1 1 auto',
  } as const,
  delta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '4px',
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-pill)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-body-sm)',
    fontWeight: 600,
    margin: '0 2px',
    verticalAlign: 'baseline',
  } as const,
  qualifier: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
    fontFamily: 'var(--font-mono)',
  } as const,
  empty: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
    margin: 0,
  } as const,
};

function presentDelta(delta?: number, asPct = true): {
  icon: typeof TrendingUp;
  label: string;
  fg: string;
  bg: string;
} {
  if (delta === undefined || Number.isNaN(delta)) {
    return { icon: Minus, label: '—', fg: 'var(--text-muted)', bg: 'var(--bg-surface)' };
  }
  const v = asPct ? Math.round(delta * 100) : Math.round(delta);
  if (v > 0) {
    return {
      icon: TrendingUp,
      label: `+${v}${asPct ? '%' : ''}`,
      fg: 'var(--eval-pass)',
      bg: 'rgba(34, 197, 94, 0.12)',
    };
  }
  if (v < 0) {
    return {
      icon: TrendingDown,
      label: `${v}${asPct ? '%' : ''}`,
      fg: 'var(--eval-fail)',
      bg: 'rgba(239, 68, 68, 0.12)',
    };
  }
  return { icon: Minus, label: `0${asPct ? '%' : ''}`, fg: 'var(--text-muted)', bg: 'var(--bg-surface)' };
}

/*
 * The local passRate() that used to live here is gone on purpose. It was a
 * second definition of a number the server now owns, and leaving it would
 * invite exactly the fallback this change exists to remove.
 */

function totalCost(moments: DecisionMoment[]): number {
  return moments.reduce((acc, m) => acc + (m.costUsd ?? 0), 0);
}

function failureCategoryCount(moments: DecisionMoment[]): number {
  const kinds = new Set<string>();
  for (const m of moments) {
    if (m.verdict !== 'pass' && !LOW_SIGNAL_KINDS.has(m.significance.kind)) {
      kinds.add(m.significance.kind);
    }
  }
  return kinds.size;
}

export interface ChangeBannerProps {
  currentMoments?: DecisionMoment[];
  priorMoments?: DecisionMoment[];
  periodLabel: string;
  /** The server's tested pass-rate comparison. Absent while loading. */
  drift?: DriftComparison;
}

export function ChangeBanner({ currentMoments, priorMoments, periodLabel, drift }: ChangeBannerProps) {
  const cur = currentMoments ?? [];
  const pri = priorMoments ?? [];

  if (cur.length === 0) {
    return (
      <div style={styles.banner} role="status">
        <Icon as={Sparkles} size={20} style={styles.icon} />
        <p style={styles.empty}>
          No activity in {periodLabel} yet — once Iris sees agent traffic, the change summary appears here.
        </p>
      </div>
    );
  }
  if (pri.length === 0) {
    return (
      <div style={styles.banner} role="status">
        <Icon as={AlertTriangle} size={20} style={styles.icon} />
        <p style={styles.empty}>
          No prior period to compare against yet. Drift comparisons appear once you have at least 2 × {periodLabel} of activity.
        </p>
      </div>
    );
  }

  const costDelta = pri.length > 0 && totalCost(pri) > 0 ? (totalCost(cur) - totalCost(pri)) / totalCost(pri) : undefined;
  const newCategories = failureCategoryCount(cur) - failureCategoryCount(pri);

  /*
   * The pass rate is the server's answer or nothing. Falling back to a
   * locally computed delta when the server withholds one would put the
   * untested number back on screen in exactly the situation the test exists
   * to catch — too little data — which is worse than showing none.
   */
  const passPres = drift?.difference ? presentDelta(drift.difference.delta, true) : undefined;
  const costPres = presentDelta(costDelta, true);
  const catPres = presentDelta(newCategories, false);
  const pct = (v: number): string => `${(v * 100).toFixed(1)}%`;

  return (
    <div style={styles.banner} role="status">
      <Icon as={Sparkles} size={20} style={styles.icon} />
      <p style={styles.prose}>
        Compared to the prior {periodLabel}: pass rate{' '}
        {passPres && drift?.difference ? (
          <>
            <span style={{ ...styles.delta, color: passPres.fg, background: passPres.bg }}>
              <Icon as={passPres.icon} size={14} />
              {passPres.label}
            </span>
            <span style={styles.qualifier}>
              {' '}
              (95% interval {pct(drift.difference.lo)} to {pct(drift.difference.hi)}, n={drift.current.evaluated} vs{' '}
              {drift.prior.evaluated}
              {drift.difference.significant
                ? ''
                : `; not enough to call — a change smaller than ${drift.smallestDetectable === null ? 'this' : pct(drift.smallestDetectable)} would not show`}
              )
            </span>
          </>
        ) : (
          <span style={styles.qualifier}>
            not compared — {drift ? `${drift.current.evaluated} and ${drift.prior.evaluated} evaluations, below the ${drift.minimumPerWindow} each side needs` : 'still loading'}
          </span>
        )}
        , cost{' '}
        <span style={{ ...styles.delta, color: costPres.fg, background: costPres.bg }}>
          <Icon as={costPres.icon} size={14} />
          {costPres.label}
        </span>
        , failure categories{' '}
        <span style={{ ...styles.delta, color: catPres.fg, background: catPres.bg }}>
          <Icon as={catPres.icon} size={14} />
          {catPres.label}
        </span>
        .
      </p>
    </div>
  );
}
