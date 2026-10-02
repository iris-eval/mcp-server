/*
 * One comparison, rendered: the verdict
 * word with its sentence, the two runs side by side with their Wilson
 * intervals, the difference with the interval the test read, the method,
 * the smallest change the runs would have detected, what each run was
 * judged on where that differs, the critical rules firing on new cases,
 * the equivalence finding when a margin was supplied, and the per-rule
 * movement with each rule's one-sided p and its corrected q. Everything
 * here is the compare_runs tool's own answer; nothing is recomputed on the
 * client.
 */
import type { CSSProperties } from 'react';
import { Link } from 'react-router';
import type { CompareRunsResult } from '../../api/types';
import { Tooltip } from '../shared/Tooltip';
import { DataTable, type Column } from '../shared/DataTable';
import {
  COVERAGE_TEXT,
  CRITICAL_TEXT,
  EQUIVALENCE_TEXT,
  METHOD_TEXT,
  PER_RULE_TEXT,
  VERDICT_TEXT,
  comparisonVerdict,
  fmtDifference,
  fmtEquivalence,
  fmtFailedOfJudged,
  fmtFell,
  fmtP,
  fmtQ,
  fmtRate,
  fmtSmallestDetectable,
  type ComparisonVerdict,
} from './compareText';

const TONE: Record<ComparisonVerdict, string> = {
  worse: 'var(--eval-fail)',
  better: 'var(--eval-pass)',
  withheld: 'var(--eval-warn)',
  equivalent: 'var(--eval-pass)',
  same: 'var(--eval-skipped)',
  incomparable: 'var(--eval-warn)',
};

const LABEL: Record<ComparisonVerdict, string> = {
  worse: 'WORSE',
  better: 'BETTER',
  withheld: 'JUDGED ON LESS',
  equivalent: 'EQUIVALENT',
  same: 'NOT DISTINGUISHABLE',
  incomparable: 'NOT COMPARED',
};

const styles = {
  panel: { display: 'flex', flexDirection: 'column', gap: 'var(--space-3)' } as CSSProperties,
  head: { display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', flexWrap: 'wrap' } as CSSProperties,
  verdict: { fontWeight: 700, fontSize: 'var(--text-body)', letterSpacing: '0.02em' } as CSSProperties,
  muted: { color: 'var(--text-muted)', fontSize: 'var(--text-caption)' } as CSSProperties,
  mono: { fontFamily: 'var(--font-mono)' } as CSSProperties,
  runs: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(16rem, 1fr))', gap: 'var(--space-3)' } as CSSProperties,
  run: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    padding: 'var(--space-3)',
    background: 'var(--bg-base)',
    borderRadius: 'var(--radius-sm)',
    fontSize: 'var(--text-body-sm)',
  } as CSSProperties,
  runName: { fontFamily: 'var(--font-mono)', fontWeight: 600 } as CSSProperties,
  reasons: { margin: 0, paddingLeft: '1.2em', color: 'var(--eval-warn)', fontSize: 'var(--text-caption)' } as CSSProperties,
  summary: { margin: 0, fontSize: 'var(--text-body-sm)', color: 'var(--text-secondary)' } as CSSProperties,
  h4: { margin: 0, fontSize: 'var(--text-caption)', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' } as CSSProperties,
  perRuleHead: { display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)', flexWrap: 'wrap', marginBottom: 'var(--space-2)' } as CSSProperties,
  worseMark: { color: 'var(--eval-fail)', fontWeight: 700, marginLeft: '0.4em' } as CSSProperties,
  notice: { margin: 0, paddingLeft: '1.2em', fontSize: 'var(--text-body-sm)' } as CSSProperties,
};

function RunCard({ label, s }: { label: string; s: CompareRunsResult['before'] }) {
  return (
    <div style={styles.run} data-compare-run={label}>
      <span style={styles.h4}>{label}</span>
      <Link to={`/runs/${encodeURIComponent(s.run_id)}`} style={styles.runName}>
        {s.run_id}
      </Link>
      <span>
        {s.passed} of {s.n} passed · <span style={styles.mono}>{fmtRate(s.rate, s.interval)}</span>
      </span>
      <span style={styles.muted}>
        {s.agent_names.join(', ') || 'no agent'} · engine {s.engine_versions.join(', ') || '—'}
        {s.superseded > 0 && ` · ${s.superseded} older evaluations collapsed`}
      </span>
    </div>
  );
}

export function ComparisonView({ result }: { result: CompareRunsResult }) {
  const verdict = comparisonVerdict(result);
  const movement = [
    ...result.regressions.map((r) => ({ ...r, direction: 'worse' as const })),
    ...result.improvements.map((r) => ({ ...r, direction: 'better' as const })),
  ];
  const columns: Column<(typeof movement)[number]>[] = [
    {
      key: 'rule',
      header: 'Rule',
      render: (r) => (
        <span data-rule-row={r.rule} data-rule-worse={r.worse ? 'true' : 'false'}>
          <code>{r.rule}</code>
          {r.worse && (
            <Tooltip content={`Worse after the correction: q = ${r.q === null ? '—' : r.q.toFixed(3)} at the 0.05 level, in the regression direction.`}>
              <span style={styles.worseMark} tabIndex={0} aria-label="worse after correction">
                worse
              </span>
            </Tooltip>
          )}
        </span>
      ),
    },
    {
      key: 'failed_before',
      header: 'Failed before',
      width: '8rem',
      render: (r) => <span data-rule-judged-before={r.judged_before ?? ''}>{fmtFailedOfJudged(r.failed_before, r.judged_before)}</span>,
    },
    {
      key: 'failed_after',
      header: 'Failed after',
      width: '8rem',
      render: (r) => <span data-rule-judged-after={r.judged_after ?? ''}>{fmtFailedOfJudged(r.failed_after, r.judged_after)}</span>,
    },
    {
      key: 'delta',
      header: 'Change',
      width: '6rem',
      render: (r) => (
        <span style={{ color: r.direction === 'worse' ? 'var(--eval-fail)' : 'var(--eval-pass)', ...styles.mono }}>
          {r.delta > 0 ? '+' : ''}
          {r.delta}
        </span>
      ),
    },
    {
      key: 'p',
      header: 'p (one-sided)',
      width: '8rem',
      render: (r) => (
        <Tooltip
          content={
            r.test === 'mcnemar-exact'
              ? "McNemar exact on this rule's own discordant pairs, one-sided: the chance of at least this many pass→fail pairs when nothing changed."
              : r.test === 'newcombe-z'
                ? "This rule's Newcombe interval inverted, one-sided: the chance of a fall this large in its pass rate, over the cases it ran on, when nothing changed."
                : 'No test: the rule ran on no case in one of the runs, or on no case both runs share. That is a change in what was checked, not in how the agent did.'
          }
        >
          <span style={styles.mono} tabIndex={0} data-rule-p={r.p === null ? 'null' : r.p.toFixed(4)}>
            {r.p === null ? '—' : fmtP(r.p)}
          </span>
        </Tooltip>
      ),
    },
    {
      key: 'q',
      header: 'q (corrected)',
      width: '8rem',
      render: (r) => (
        <Tooltip content={`Benjamini–Hochberg over the ${result.rules_tested} rules tested in this comparison. Read this, not p: a rule is marked worse only at q ≤ 0.05.`}>
          <span style={{ ...styles.mono, ...(r.worse ? { color: 'var(--eval-fail)', fontWeight: 600 } : {}) }} tabIndex={0} data-rule-q={r.q === null ? 'null' : r.q.toFixed(4)}>
            {fmtQ(r.q)}
          </span>
        </Tooltip>
      ),
    },
  ];

  return (
    <section style={styles.panel} aria-label="Comparison" data-comparison={verdict}>
      <div style={styles.head}>
        <Tooltip content={VERDICT_TEXT[verdict]}>
          <span style={{ ...styles.verdict, color: TONE[verdict] }} tabIndex={0} data-comparison-verdict={verdict}>
            {LABEL[verdict]}
          </span>
        </Tooltip>
        <Tooltip content={METHOD_TEXT[result.method]}>
          <span style={{ ...styles.muted, ...styles.mono }} tabIndex={0} data-method={result.method}>
            {result.method}
          </span>
        </Tooltip>
        {result.difference && (
          <Tooltip
            content={
              result.paired
                ? 'The difference in pass rate on the matched cases, after minus before. Negative means more failures after. The interval the paired test reads is on which way the changed cases went, shown beside it.'
                : 'The difference in pass rate, after minus before, with its 90% interval: the two-sided interval a one-sided test at 5% reads, so it excludes zero exactly when the test finds a change. Negative means more failures after.'
            }
          >
            <span style={{ ...styles.muted, ...styles.mono }} tabIndex={0} data-difference={result.difference.delta.toFixed(3)}>
              {fmtDifference(result.difference, result.paired !== null)}
            </span>
          </Tooltip>
        )}
        {result.paired && (
          <Tooltip
            content={`McNemar exact on the ${result.paired.b + result.paired.c} cases that disagreed (${result.paired.b} passed then failed, ${result.paired.c} failed then passed) of ${result.paired.pairs} pairs; ${result.paired.concordant} agreed. The interval is the exact 90% one on the share that fell: above one half is a regression, and it excludes one half exactly when the one-sided test finds a change.`}
          >
            <span style={{ ...styles.muted, ...styles.mono }} tabIndex={0} data-paired-p={result.paired.p_value.toFixed(4)} data-paired-fell={result.paired.fell ? result.paired.fell.share.toFixed(3) : 'none'}>
              {result.paired.fell !== undefined ? fmtFell(result.paired) : fmtP(result.paired.p_value)}
            </span>
          </Tooltip>
        )}
        {result.smallest_detectable !== null && (
          <Tooltip content="The smallest change in pass rate these two runs would have detected four times in five. A smaller one is missed more often than that, so finding nothing is not evidence there was nothing.">
            <span style={{ ...styles.muted, ...styles.mono }} tabIndex={0} data-smallest-detectable={result.smallest_detectable.toFixed(3)}>
              detects ≥ {fmtSmallestDetectable(result.smallest_detectable)}
            </span>
          </Tooltip>
        )}
        {result.equivalent_within && (
          <Tooltip
            content={`${result.equivalent_within.holds ? EQUIVALENCE_TEXT.holds : EQUIVALENCE_TEXT.fails} The 90% interval is [${(result.equivalent_within.interval.lo * 100).toFixed(1)}, ${(result.equivalent_within.interval.hi * 100).toFixed(1)}] points.`}
          >
            <span
              style={{ ...styles.muted, ...styles.mono, ...(result.equivalent_within.holds ? { color: 'var(--eval-pass)' } : {}) }}
              tabIndex={0}
              data-equivalent-within={result.equivalent_within.holds ? 'true' : 'false'}
              data-equivalence-margin={result.equivalent_within.margin.toFixed(3)}
            >
              {fmtEquivalence(result.equivalent_within)}
            </span>
          </Tooltip>
        )}
        {result.forced && (
          <span style={{ ...styles.muted, color: 'var(--eval-warn)' }} data-forced="true">
            forced
          </span>
        )}
      </div>

      {result.incomparable_because.length > 0 && (
        <ul style={styles.reasons} aria-label="Why these runs are not comparable">
          {result.incomparable_because.map((why) => (
            <li key={why} data-incomparable-because="true">
              {why}
            </li>
          ))}
        </ul>
      )}

      <div style={styles.runs}>
        <RunCard label="before" s={result.before} />
        <RunCard label="after" s={result.after} />
      </div>

      {(result.coverage?.lost.length ?? 0) > 0 && (
        <div data-coverage-lost={result.coverage.lost.length}>
          <div style={styles.perRuleHead}>
            <h4 style={{ ...styles.h4, color: 'var(--eval-warn)' }}>Judged on less</h4>
            <Tooltip content={COVERAGE_TEXT}>
              <span style={styles.muted} tabIndex={0}>
                {result.coverage.lost.length} rule{result.coverage.lost.length === 1 ? '' : 's'} ran on fewer cases after
              </span>
            </Tooltip>
          </div>
          <ul style={styles.notice}>
            {result.coverage.lost.map((l) => (
              <li key={l.rule} data-coverage-lost-rule={l.rule}>
                <code>{l.rule}</code>: ran on {l.judged_before} of {l.of_before} cases before, {l.judged_after} of {l.of_after} after
              </li>
            ))}
          </ul>
        </div>
      )}

      {(result.critical_rises?.length ?? 0) > 0 && (
        <div data-critical-rises={result.critical_rises.length}>
          <div style={styles.perRuleHead}>
            <h4 style={{ ...styles.h4, color: 'var(--eval-fail)' }}>Critical, on new cases</h4>
            <Tooltip content={CRITICAL_TEXT}>
              <span style={styles.muted} tabIndex={0}>
                counted, not tested
              </span>
            </Tooltip>
          </div>
          <ul style={styles.notice}>
            {result.critical_rises.map((r) => (
              <li key={r.rule} data-critical-rise-rule={r.rule}>
                <code>{r.rule}</code>: fires on {r.after} case{r.after === 1 ? '' : 's'} after, {r.before} before
                {r.new_on.length > 0 && (
                  <>
                    {' '}
                    · new on{' '}
                    {r.new_on.slice(0, 8).map((key, i) => (
                      <span key={key}>
                        {i > 0 && ', '}
                        <Link to={`/cases/${encodeURIComponent(key)}`} style={styles.mono}>
                          {key}
                        </Link>
                      </span>
                    ))}
                    {r.new_on.length > 8 && `, and ${r.new_on.length - 8} more`}
                  </>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <p style={styles.summary} data-summary="true">
        {result.summary}
      </p>

      {movement.length > 0 && (
        <div>
          <div style={styles.perRuleHead}>
            <h4 style={styles.h4}>Per rule</h4>
            <Tooltip content={PER_RULE_TEXT}>
              <span style={styles.muted} tabIndex={0} data-rules-tested={result.rules_tested}>
                {result.rules_tested} tested · corrected together
              </span>
            </Tooltip>
          </div>
          <DataTable columns={columns} data={movement} emptyMessage="No rule moved" />
        </div>
      )}
      {result.discordant !== undefined && result.discordant.length > 0 && (
        <div style={{ marginTop: 'var(--space-4)' }} data-discordant-count={result.discordant_total ?? result.discordant.length}>
          <div style={styles.perRuleHead}>
            <h3 style={{ margin: 0, fontSize: 'var(--text-body)' }}>Cases that disagreed</h3>
            <Tooltip content="The paired cases whose verdict flipped between the runs — the b + c McNemar counts, named. Regressions first. Each row opens the evaluation it flipped to.">
              <span style={styles.muted} tabIndex={0}>
                {result.discordant_total ?? result.discordant.length} case{(result.discordant_total ?? result.discordant.length) === 1 ? '' : 's'}
                {(result.discordant_total ?? 0) > result.discordant.length ? ` · first ${result.discordant.length}` : ''}
              </span>
            </Tooltip>
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={{ textAlign: 'left' }}>Case</th>
                <th style={{ textAlign: 'left' }}>Went</th>
                <th style={{ textAlign: 'left' }}>Rules that flipped</th>
                <th style={{ textAlign: 'left' }}>Open</th>
              </tr>
            </thead>
            <tbody>
              {result.discordant.map((d) => {
                const target = d.after.trace_id ?? d.before.trace_id;
                return (
                  <tr key={d.case_key} data-discordant-row={d.case_key} data-discordant-direction={d.direction}>
                    <td>
                      <Link to={`/cases/${encodeURIComponent(d.case_key)}`} style={styles.mono}>
                        {d.case_key}
                      </Link>
                    </td>
                    <td style={{ color: d.direction === 'regressed' ? 'var(--eval-fail)' : 'var(--eval-pass)' }}>
                      {d.direction === 'regressed' ? 'pass → fail' : 'fail → pass'}
                    </td>
                    <td style={styles.mono}>
                      {d.rules.length === 0 ? <span style={styles.muted}>the verdict alone</span> : d.rules.map((r) => r.rule).join(', ')}
                      {(d.not_judged_after?.length ?? 0) > 0 && (
                        <span style={{ ...styles.muted, color: 'var(--eval-warn)' }} data-not-judged-after={d.not_judged_after!.length}>
                          {' '}
                          · not run after: {d.not_judged_after!.join(', ')}
                        </span>
                      )}
                    </td>
                    <td>
                      {target ? (
                        <Link to={`/traces/${encodeURIComponent(target)}`} data-discordant-open={d.case_key}>
                          the moment
                        </Link>
                      ) : (
                        <span style={styles.muted}>no trace</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
