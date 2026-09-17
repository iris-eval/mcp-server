/*
 * Drift by run (arc 7, D-6): one panel per cohort with what the server
 * says about it — n and the Wilson interval on each window, the tested
 * difference with its interval, or "not compared" with the smallest change
 * the windows could have seen — and that cohort's own trend line. Nothing
 * is recomputed here; the intervals come from the same stats module the
 * proof harness uses.
 */
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import { useDrift, useEvalTrend } from '../../api/hooks';
import type { DriftWindowSummary, EvalTrendPoint } from '../../api/types';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { QueryError } from '../shared/QueryError';
import { Tooltip } from '../shared/Tooltip';
import { PassRateAreaChart } from './charts/PassRateAreaChart';
import type { Period } from './PeriodSelector';

/** How many cohorts to draw; the rest are named, not drawn. */
export const MAX_COHORT_PANELS = 8;

const styles = {
  grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(22rem, 1fr))', gap: 'var(--space-3)' } as CSSProperties,
  panel: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius)',
    padding: 'var(--space-3)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
  } as CSSProperties,
  head: { display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap' } as CSSProperties,
  run: { fontFamily: 'var(--font-mono)', fontWeight: 600 } as CSSProperties,
  mono: { fontFamily: 'var(--font-mono)' } as CSSProperties,
  muted: { color: 'var(--text-muted)', fontSize: 'var(--text-caption)' } as CSSProperties,
  windows: { margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px var(--space-3)', fontSize: 'var(--text-body-sm)' } as CSSProperties,
  dt: { color: 'var(--text-muted)' } as CSSProperties,
  dd: { margin: 0 } as CSSProperties,
  worse: { color: 'var(--eval-fail)', fontWeight: 600 } as CSSProperties,
  better: { color: 'var(--eval-pass)', fontWeight: 600 } as CSSProperties,
  same: { color: 'var(--eval-skipped)', fontWeight: 600 } as CSSProperties,
  note: { color: 'var(--text-muted)', fontSize: 'var(--text-caption)', margin: 0 } as CSSProperties,
};

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;

export function fmtWindow(w: DriftWindowSummary): string {
  if (w.evaluated === 0) return 'no evaluations';
  const rate = w.passRate === null ? '' : pct(w.passRate);
  const interval = w.interval ? ` [${pct(w.interval.lo)}, ${pct(w.interval.hi)}]` : '';
  return `${w.passed} of ${w.evaluated} passed · ${rate}${interval}`;
}

/** The cohorts present in a split trend, largest first, capped. */
export function cohortsOf(trend: EvalTrendPoint[] | null | undefined): { drawn: string[]; named: string[] } {
  const totals = new Map<string, number>();
  for (const b of trend ?? []) {
    if (!b.cohort) continue;
    totals.set(b.cohort, (totals.get(b.cohort) ?? 0) + b.evalCount);
  }
  const sorted = [...totals.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([id]) => id);
  return { drawn: sorted.slice(0, MAX_COHORT_PANELS), named: sorted.slice(MAX_COHORT_PANELS) };
}

function CohortPanel({ run, period, trend }: { run: string; period: Period; trend: EvalTrendPoint[] }) {
  const { data, loading, error, refetch } = useDrift({ period, run });
  const verdict = !data ? null : !data.enoughEvidence || !data.difference ? 'same' : data.difference.significant ? (data.difference.delta < 0 ? 'worse' : 'better') : 'same';
  return (
    <section style={styles.panel} aria-label={`Run ${run}`} data-cohort={run}>
      <div style={styles.head}>
        <Link to={`/runs/${encodeURIComponent(run)}`} style={styles.run}>
          {run}
        </Link>
        {data && (
          <span style={{ ...styles.muted, ...styles.mono }} data-cohort-n={data.current.evaluated}>
            n = {data.current.evaluated} this {period}
          </span>
        )}
        {verdict && (
          <Tooltip
            content={
              verdict === 'same'
                ? data!.enoughEvidence
                  ? `The interval on the difference includes zero: not distinguishable. A change smaller than ${data!.smallestDetectable === null ? 'this' : pct(data!.smallestDetectable)} would not show at these sizes.`
                  : `Below ${data!.minimumPerWindow} evaluations on a side, no direction is offered.`
                : verdict === 'worse'
                  ? 'The pass rate fell, and the 95% interval on the difference excludes zero.'
                  : 'The pass rate rose, and the 95% interval on the difference excludes zero.'
            }
          >
            <span style={verdict === 'worse' ? styles.worse : verdict === 'better' ? styles.better : styles.same} tabIndex={0} data-cohort-verdict={verdict}>
              {verdict === 'worse' ? 'WORSE' : verdict === 'better' ? 'BETTER' : data!.enoughEvidence ? 'NOT DISTINGUISHABLE' : 'NOT COMPARED'}
            </span>
          </Tooltip>
        )}
      </div>
      {error && <QueryError error={error} what={`run ${run}`} onRetry={refetch} />}
      {loading && !data && <LoadingSpinner />}
      {data && (
        <dl style={styles.windows}>
          <dt style={styles.dt}>this {period}</dt>
          <dd style={{ ...styles.dd, ...styles.mono }} data-cohort-current="true">
            {fmtWindow(data.current)}
          </dd>
          <dt style={styles.dt}>prior {period}</dt>
          <dd style={{ ...styles.dd, ...styles.mono }} data-cohort-prior="true">
            {fmtWindow(data.prior)}
          </dd>
          {data.difference && (
            <>
              <dt style={styles.dt}>difference</dt>
              <dd style={{ ...styles.dd, ...styles.mono }} data-cohort-difference="true">
                {data.difference.delta > 0 ? '+' : ''}
                {(data.difference.delta * 100).toFixed(1)} pts [{(data.difference.lo * 100).toFixed(1)}, {(data.difference.hi * 100).toFixed(1)}]
              </dd>
            </>
          )}
        </dl>
      )}
      <PassRateAreaChart trend={trend} periodLabel={period} title={`Pass rate · ${run}`} height={120} />
    </section>
  );
}

export function CohortPanels({ period }: { period: Period }) {
  const trend = useEvalTrend(period, 'run');
  if (trend.error) return <QueryError error={trend.error} what="the trend by run" onRetry={trend.refetch} />;
  if (trend.loading && !trend.data) return <LoadingSpinner />;
  const { drawn, named } = cohortsOf(trend.data);
  if (drawn.length === 0) {
    return (
      <p style={styles.note} data-cohort-empty="true">
        No run in this window. Pass <code>run</code> on <code>log_trace</code> or <code>POST /api/v1/traces</code> and each run gets its own line here.
      </p>
    );
  }
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
      <div style={styles.grid}>
        {drawn.map((run) => (
          <CohortPanel key={run} run={run} period={period} trend={(trend.data ?? []).filter((b) => b.cohort === run)} />
        ))}
      </div>
      {named.length > 0 && (
        <p style={styles.note} data-cohort-named={named.length}>
          {named.length} more {named.length === 1 ? 'run' : 'runs'} in this window, not drawn: {named.join(', ')}. Open a run from the Runs page to see it alone.
        </p>
      )}
    </div>
  );
}
