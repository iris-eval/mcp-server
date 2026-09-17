/*
 * One run (arc 7, D-5): its counts and provenance, and the evaluations in
 * it — collapsed to one per trace, exactly as a comparison counts them.
 */
import type { CSSProperties } from 'react';
import { Link, useParams } from 'react-router';
import { useRun } from '../../api/hooks';
import type { RunResultRow } from '../../api/types';
import { DataTable, type Column } from '../shared/DataTable';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { QueryError } from '../shared/QueryError';
import { Badge } from '../shared/Badge';
import { TimeAgo } from '../shared/TimeAgo';
import { CopyableId } from '../shared/CopyableId';

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
  facts: { margin: 0, display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '2px var(--space-4)', fontSize: 'var(--text-body-sm)' } as CSSProperties,
  dt: { color: 'var(--text-muted)' } as CSSProperties,
  dd: { margin: 0, fontFamily: 'var(--font-mono)' } as CSSProperties,
  mono: { fontFamily: 'var(--font-mono)' } as CSSProperties,
  muted: { color: 'var(--text-muted)', fontSize: 'var(--text-caption)' } as CSSProperties,
  h2: { margin: 0, fontSize: 'var(--text-body)', fontWeight: 600 } as CSSProperties,
};

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error, refetch } = useRun(id ?? '');

  if (error) return <QueryError error={error} what="this run" onRetry={refetch} />;
  if (loading && !data) return <LoadingSpinner />;
  if (!data) return <LoadingSpinner />;

  const { run, results } = data;
  const columns: Column<RunResultRow>[] = [
    {
      key: 'passed',
      header: 'Result',
      render: (r) => <Badge label={r.passed ? 'PASS' : 'FAIL'} variant={r.passed ? 'pass' : 'fail'} />,
      width: '6rem',
    },
    {
      key: 'caseKey',
      header: 'Case',
      render: (r) =>
        r.caseKey ? (
          <Link to={`/cases/${encodeURIComponent(r.caseKey)}`} style={styles.mono} data-case-link={r.caseKey}>
            {r.caseKey}
          </Link>
        ) : (
          <span style={styles.muted}>—</span>
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
    { key: 'agent', header: 'Agent', render: (r) => r.agentName ?? <span style={styles.muted}>—</span> },
    {
      key: 'failedRules',
      header: 'Failed rules',
      render: (r) => (r.failedRules.length > 0 ? <code>{r.failedRules.join(', ')}</code> : <span style={styles.muted}>none</span>),
    },
    { key: 'createdAt', header: 'Evaluated', render: (r) => <TimeAgo timestamp={r.createdAt} />, width: '8rem' },
  ];

  return (
    <div style={styles.page}>
      <Link to="/runs" className="detail-back">
        &larr; Back to runs
      </Link>
      <div style={styles.card} data-run-detail={run.runId}>
        <h2 style={styles.h2}>
          <CopyableId value={run.runId} displayValue={run.runId} ariaLabel="Copy run id" />
          {run.label && <span style={styles.muted}> · {run.label}</span>}
        </h2>
        <dl style={styles.facts}>
          <dt style={styles.dt}>traces</dt>
          <dd style={styles.dd}>{run.traces}</dd>
          <dt style={styles.dt}>evaluated</dt>
          <dd style={styles.dd} data-run-passed={`${run.passed}/${run.evaluated}`}>
            {run.passed} of {run.evaluated} passed
          </dd>
          <dt style={styles.dt}>agents</dt>
          <dd style={styles.dd}>{run.agentNames.join(', ') || '—'}</dd>
          <dt style={styles.dt}>engine</dt>
          <dd style={styles.dd}>{run.engineVersions.join(', ') || '—'}</dd>
          <dt style={styles.dt}>ruleset</dt>
          <dd style={styles.dd}>{run.rulesetHashes.map((h) => h.slice(0, 12)).join(', ') || '—'}</dd>
          {run.reevaluationOf && (
            <>
              <dt style={styles.dt}>re-evaluation of</dt>
              <dd style={styles.dd}>
                <Link to={`/runs/${encodeURIComponent(run.reevaluationOf)}`}>{run.reevaluationOf}</Link>
              </dd>
            </>
          )}
          {run.startedAt && (
            <>
              <dt style={styles.dt}>started</dt>
              <dd style={styles.dd}>
                <TimeAgo timestamp={run.startedAt} />
              </dd>
            </>
          )}
        </dl>
        <p style={styles.muted}>One evaluation per trace, the most recent — the way a comparison counts them.</p>
        <DataTable columns={columns} data={results} emptyMessage="No evaluations in this run" />
      </div>
    </div>
  );
}
