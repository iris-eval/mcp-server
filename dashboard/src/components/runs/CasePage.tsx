/*
 * One case across runs: every attempt, deliberately not
 * collapsed — here the repetition is the measurement. Says whether the
 * case is flaky (passed some attempts and failed others).
 */
import type { CSSProperties } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useCase } from '../../api/hooks';
import type { CaseResultRow } from '../../api/types';
import { DataTable, type Column } from '../shared/DataTable';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { QueryError } from '../shared/QueryError';
import { Badge } from '../shared/Badge';
import { TimeAgo } from '../shared/TimeAgo';
import { Tooltip } from '../shared/Tooltip';

const styles = {
  page: { display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' } as CSSProperties,
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
  h2: { margin: 0, fontSize: 'var(--text-body)', fontWeight: 600, fontFamily: 'var(--font-mono)' } as CSSProperties,
  mono: { fontFamily: 'var(--font-mono)' } as CSSProperties,
  muted: { color: 'var(--text-muted)', fontSize: 'var(--text-caption)' } as CSSProperties,
  flaky: { color: 'var(--eval-warn)', fontWeight: 600 } as CSSProperties,
  steady: { color: 'var(--eval-pass)', fontWeight: 600 } as CSSProperties,
};

export function CasePage() {
  const { key } = useParams<{ key: string }>();
  const [search] = useSearchParams();
  const run = search.get('run') ?? undefined;
  const { data, loading, error, refetch } = useCase(key ?? '', run);

  if (error) return <QueryError error={error} what="this case" onRetry={refetch} />;
  if (loading && !data) return <LoadingSpinner />;
  if (!data) return <LoadingSpinner />;

  const columns: Column<CaseResultRow>[] = [
    {
      key: 'passed',
      header: 'Result',
      render: (r) => <Badge label={r.passed ? 'PASS' : 'FAIL'} variant={r.passed ? 'pass' : 'fail'} />,
      width: '6rem',
    },
    {
      key: 'runId',
      header: 'Run',
      render: (r) =>
        r.runId ? (
          <Link to={`/runs/${encodeURIComponent(r.runId)}`} style={styles.mono}>
            {r.runId}
          </Link>
        ) : (
          <span style={styles.muted}>no run</span>
        ),
    },
    {
      key: 'traceId',
      header: 'Trace',
      render: (r) =>
        r.traceId ? (
          <Link to={`/traces/${encodeURIComponent(r.traceId)}`} style={styles.mono}>
            {r.traceId}
          </Link>
        ) : (
          <span style={styles.muted}>—</span>
        ),
    },
    { key: 'createdAt', header: 'Evaluated', render: (r) => <TimeAgo timestamp={r.createdAt} />, width: '8rem' },
  ];

  return (
    <div style={styles.page}>
      <Link to="/runs" className="detail-back">
        &larr; Back to runs
      </Link>
      <div style={styles.card} data-case-detail={data.caseKey}>
        <div style={styles.head}>
          <h2 style={styles.h2}>{data.caseKey}</h2>
          <span data-case-attempts={data.attempts}>
            {data.passed} of {data.attempts} attempts passed
          </span>
          {data.flaky ? (
            <Tooltip content="Flaky: this case passed on some attempts and failed on others. The same input, judged the same way, gave different answers.">
              <span style={styles.flaky} tabIndex={0} data-case-flaky="true">
                flaky
              </span>
            </Tooltip>
          ) : (
            <Tooltip content="Every attempt agreed.">
              <span style={styles.steady} tabIndex={0} data-case-flaky="false">
                steady
              </span>
            </Tooltip>
          )}
          {run && <span style={styles.muted}>in run {run}</span>}
          {!run && data.runs.length > 0 && <span style={styles.muted}>across {data.runs.length} runs</span>}
        </div>
        <DataTable columns={columns} data={data.results} emptyMessage="No attempts" />
      </div>
    </div>
  );
}
