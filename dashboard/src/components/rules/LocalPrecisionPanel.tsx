/*
 * Your labels, and what they have made of each rule's number.
 *
 * Read once from /labels/stats. Per rule: how many of its fires you have
 * labelled right or wrong, the local precision with its Wilson interval,
 * whether that number is in force (twenty labels), the published precision
 * beside it, and how often the rule fires on your traffic. Above the
 * table: how often your labels imply each labelled rule's failure is
 * present, and which rule to label next.
 * Labels measure precision only, so nothing here says "local accuracy".
 */
import type { CSSProperties } from 'react';
import { useLabelStats } from '../../api/hooks';
import type { LabelStatsRow } from '../../api/types';
import { DataTable, type Column } from '../shared/DataTable';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { QueryError } from '../shared/QueryError';
import { Tooltip } from '../shared/Tooltip';
import { TT } from '../shared/tooltipText';
import { localPrecisionCell, pct } from '../evals/labelText';

const styles = {
  card: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius)',
    padding: 'var(--space-4)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as CSSProperties,
  head: { display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', flexWrap: 'wrap' } as CSSProperties,
  h2: { margin: 0, fontSize: 'var(--text-body)', fontWeight: 600 } as CSSProperties,
  muted: { color: 'var(--text-muted)', fontSize: 'var(--text-caption)' } as CSSProperties,
  mono: { fontFamily: 'var(--font-mono)' } as CSSProperties,
  inForce: { color: 'var(--eval-pass)', fontWeight: 600 } as CSSProperties,
  fact: { margin: 0, fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' } as CSSProperties,
};

export function LocalPrecisionPanel() {
  const stats = useLabelStats();

  if (stats.error) return <QueryError error={stats.error} what="your labels" onRetry={stats.refetch} />;
  if (stats.loading && !stats.data) return <LoadingSpinner />;
  const data = stats.data;
  if (!data) return null;

  // Rules you have labelled, or that fire on your traffic — the ones a label could change.
  const rows = data.rules
    .filter((r) => r.n > 0 || (r.fireRate ?? 0) > 0)
    .sort((a, b) => b.n - a.n || (b.fireRate ?? 0) - (a.fireRate ?? 0) || a.rule.localeCompare(b.rule));
  const labelled = data.rules.filter((r) => r.n > 0);
  const totalLabels = labelled.reduce((sum, r) => sum + r.n, 0);
  const inForce = labelled.filter((r) => r.local).length;

  const columns: Column<LabelStatsRow>[] = [
    { key: 'rule', header: 'Rule', render: (r) => <code data-label-rule={r.rule}>{r.rule}</code> },
    { key: 'kind', header: 'Kind', width: '7rem', render: (r) => <span style={styles.mono}>{r.kind ?? '—'}</span> },
    {
      key: 'labels',
      header: 'Your labels',
      width: '8rem',
      render: (r) => (
        <span style={styles.mono} data-label-count={r.rule}>
          {r.n === 0 ? '—' : `${r.right} right · ${r.wrong} wrong`}
        </span>
      ),
    },
    {
      key: 'precision',
      header: 'Local precision',
      width: '15rem',
      render: (r) => (
        <Tooltip content={TT.localPrecision}>
          <span tabIndex={0} style={styles.mono} data-local-precision={r.rule}>
            {localPrecisionCell(r)}
          </span>
        </Tooltip>
      ),
    },
    {
      key: 'local',
      header: 'In force',
      width: '9rem',
      render: (r) =>
        r.local ? (
          <Tooltip content={TT.localInForce}>
            <span tabIndex={0} style={styles.inForce} data-local-in-force={r.rule}>
              yes{r.entersRisk ? ' · in the risk' : ''}
            </span>
          </Tooltip>
        ) : (
          <span style={styles.muted}>{r.n === 0 ? `at ${data.min}` : `${Math.max(0, data.min - r.n)} more`}</span>
        ),
    },
    {
      key: 'published',
      header: 'Published',
      width: '6rem',
      render: (r) => <span style={styles.mono}>{r.publishedPrecision === null ? 'no family' : r.publishedPrecision.toFixed(2)}</span>,
    },
    {
      key: 'fireRate',
      header: 'Fires on',
      width: '6rem',
      render: (r) => <span style={styles.mono}>{r.fireRate === null ? '—' : pct(r.fireRate)}</span>,
    },
  ];

  return (
    <section style={styles.card} aria-label="Your labels" data-local-precision-panel="true">
      <div style={styles.head}>
        <h2 style={styles.h2}>Your labels</h2>
        <span style={styles.muted} data-label-summary="true">
          {totalLabels} label{totalLabels === 1 ? '' : 's'} on {labelled.length} rule{labelled.length === 1 ? '' : 's'} · in force on {inForce}
        </span>
      </div>
      <p style={styles.muted}>
        On any trace, a fired rule asks whether it was right to fire. Right ÷ (right + wrong) over your answers is the rule’s local precision on
        your traffic, and at {data.min} labels it replaces the published number on every verdict this deployment makes. Labels measure
        precision only: nothing here says what a quiet rule missed.
      </p>
      {data.prevalence.length > 0 && (
        <Tooltip content={TT.prevalence}>
          <p style={styles.fact} tabIndex={0} data-prevalence={data.prevalence.map((p) => p.ruleName).join(' ')}>
            Estimated from your labels:{' '}
            {data.prevalence.map((p, i) => (
              <span key={p.ruleName} data-prevalence-rule={p.ruleName}>
                {i > 0 ? '; ' : ''}the failure {p.ruleName} looks for is present on about {pct(p.pi)} of your traffic [{pct(p.lo)}, {pct(p.hi)}]
              </span>
            ))}
            . An estimate takes its rule to find the failure as often on your traffic as on the published corpus. It is information: no verdict is
            weighed by it.
          </p>
        </Tooltip>
      )}
      {data.suggestion && (
        <Tooltip content={TT.samplingSuggestion}>
          <p style={styles.fact} tabIndex={0} data-sampling-suggestion={data.suggestion.ruleName}>
            Next: {data.suggestion.sentence}.
          </p>
        </Tooltip>
      )}
      <DataTable columns={columns} data={rows} emptyMessage="No labels yet, and no rule has fired on your recent traffic." />
    </section>
  );
}
