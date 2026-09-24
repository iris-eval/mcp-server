/*
 * Runs: every run the store knows, newest first, with its
 * counts and its pass rate; and the compare action — pick a baseline and a
 * candidate, and the compare_runs tool answers through POST /api/v1/compare.
 */
import { useEffect, useState, type CSSProperties, type FormEvent } from 'react';
import { Link } from 'react-router';
import { api } from '../../api/client';
import { useRuns } from '../../api/hooks';
import { asApiError, type ApiError } from '../../api/errors';
import type { CompareRunsResult, RunSummaryRow } from '../../api/types';
import { DataTable, type Column } from '../shared/DataTable';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { QueryError } from '../shared/QueryError';
import { PageEmptyState } from '../layout/PageEmptyState';
import { TimeAgo } from '../shared/TimeAgo';
import { ComparisonView } from './ComparisonView';
import { Layers } from 'lucide-react';

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
  form: { display: 'flex', alignItems: 'flex-end', gap: 'var(--space-3)', flexWrap: 'wrap' } as CSSProperties,
  field: { display: 'flex', flexDirection: 'column', gap: '2px', fontSize: 'var(--text-caption)', color: 'var(--text-muted)' } as CSSProperties,
  select: {
    minWidth: '14rem',
    padding: 'var(--space-1) var(--space-2)',
    background: 'var(--bg-base)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--radius-sm)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-body-sm)',
  } as CSSProperties,
  check: { display: 'flex', alignItems: 'center', gap: 'var(--space-1_5)', fontSize: 'var(--text-caption)', color: 'var(--text-muted)' } as CSSProperties,
  mono: { fontFamily: 'var(--font-mono)' } as CSSProperties,
  muted: { color: 'var(--text-muted)', fontSize: 'var(--text-caption)' } as CSSProperties,
  h2: { margin: 0, fontSize: 'var(--text-body)', fontWeight: 600 } as CSSProperties,
  rawNav: { display: 'flex', alignItems: 'baseline', gap: 'var(--space-3)', fontSize: 'var(--text-caption)' } as CSSProperties,
};

function rate(run: RunSummaryRow): string {
  if (run.evaluated === 0) return 'no evaluations';
  return `${((run.passed / run.evaluated) * 100).toFixed(1)}%`;
}

export function RunsPage() {
  const { data, loading, error, refetch } = useRuns(200);
  const [before, setBefore] = useState('');
  const [after, setAfter] = useState('');
  const [force, setForce] = useState(false);
  const [comparing, setComparing] = useState(false);
  const [comparison, setComparison] = useState<CompareRunsResult | null>(null);
  const [compareError, setCompareError] = useState<ApiError | null>(null);
  const [pinning, setPinning] = useState<string | null>(null);

  const runs = data?.runs ?? [];
  const baseline = runs.find((r) => r.baseline) ?? null;

  // The compare form starts from the pinned baseline; a reader's own choice is never overwritten.
  useEffect(() => {
    if (baseline && before === '') setBefore(baseline.runId);
  }, [baseline, before]);

  async function pin(r: RunSummaryRow) {
    setPinning(r.runId);
    try {
      await api.setRunBaseline(r.runId, !r.baseline);
      if (!r.baseline) setBefore(r.runId);
      refetch();
    } finally {
      setPinning(null);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!before || !after) return;
    setComparing(true);
    setCompareError(null);
    try {
      setComparison(await api.compareRuns({ before, after, force: force || undefined }));
    } catch (err) {
      setComparison(null);
      setCompareError(asApiError(err));
    } finally {
      setComparing(false);
    }
  }

  const columns: Column<RunSummaryRow>[] = [
    {
      key: 'runId',
      header: 'Run',
      render: (r) => (
        <Link to={`/runs/${encodeURIComponent(r.runId)}`} style={styles.mono} data-run-link={r.runId}>
          {r.runId}
        </Link>
      ),
    },
    { key: 'label', header: 'Label', render: (r) => r.label ?? <span style={styles.muted}>—</span> },
    {
      key: 'baseline',
      header: 'Baseline',
      render: (r) => (
        <button
          type="button"
          className="iris-btn"
          onClick={() => void pin(r)}
          disabled={pinning !== null}
          aria-pressed={r.baseline}
          title={r.baseline ? 'The baseline every later run is compared against. Click to unpin.' : 'Pin as the baseline every later run is compared against.'}
          data-run-pin={r.runId}
          {...(r.baseline ? { 'data-run-baseline': r.runId } : {})}
        >
          {r.baseline ? 'baseline' : 'pin'}
        </button>
      ),
      width: '7rem',
    },
    { key: 'traces', header: 'Traces', render: (r) => String(r.traces), width: '6rem' },
    {
      key: 'evaluated',
      header: 'Evaluated',
      render: (r) => (
        <span data-run-evaluated={r.evaluated}>
          {r.passed} of {r.evaluated} passed
        </span>
      ),
      width: '11rem',
    },
    { key: 'rate', header: 'Pass rate', render: (r) => <span style={styles.mono}>{rate(r)}</span>, width: '8rem' },
    { key: 'agents', header: 'Agents', render: (r) => r.agentNames.join(', ') || <span style={styles.muted}>—</span> },
    { key: 'engine', header: 'Engine', render: (r) => <span style={styles.mono}>{r.engineVersions.join(', ') || '—'}</span>, width: '7rem' },
    {
      key: 'started',
      header: 'Started',
      render: (r) => (r.startedAt ? <TimeAgo timestamp={r.startedAt} /> : <span style={styles.muted}>—</span>),
      width: '8rem',
    },
  ];

  if (error) return <QueryError error={error} what="runs" onRetry={refetch} />;
  if (loading && !data) return <LoadingSpinner />;

  if (runs.length === 0) {
    return (
      <PageEmptyState
        icon={Layers}
        title="No runs yet"
        body={
          <>
            A run is a named batch of traces. Pass <code>run</code> (and <code>case_key</code> for a repeated case) on{' '}
            <code>log_trace</code> or on <code>POST /api/v1/traces</code>, and this page lists each run with its pass rate, and can compare two of
            them with an interval.
          </>
        }
      />
    );
  }

  return (
    <div style={styles.page}>
      {/* The raw views are views of this same data (D-5): reachable here, not top-level entries. */}
      <nav aria-label="Raw views" style={styles.rawNav}>
        <span style={styles.muted}>Raw views of the same data:</span>
        <Link to="/traces" data-raw-view="traces">
          Traces
        </Link>
        <Link to="/evals" data-raw-view="evals">
          Evaluations
        </Link>
      </nav>
      <div style={styles.card}>
        <h2 style={styles.h2}>Compare two runs</h2>
        <form style={styles.form} onSubmit={submit} aria-label="Compare two runs">
          <label style={styles.field}>
            before
            <select style={styles.select} value={before} onChange={(e) => setBefore(e.target.value)} data-compare-before="true">
              <option value="">choose a baseline</option>
              {runs.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId}
                </option>
              ))}
            </select>
          </label>
          <label style={styles.field}>
            after
            <select style={styles.select} value={after} onChange={(e) => setAfter(e.target.value)} data-compare-after="true">
              <option value="">choose a candidate</option>
              {runs.map((r) => (
                <option key={r.runId} value={r.runId}>
                  {r.runId}
                </option>
              ))}
            </select>
          </label>
          <label style={styles.check}>
            <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} data-compare-force="true" />
            compare even if not comparable
          </label>
          <button type="submit" className="iris-btn" disabled={!before || !after || comparing} data-compare-submit="true">
            {comparing ? 'Comparing…' : 'Compare'}
          </button>
        </form>
        {compareError && <QueryError error={compareError} what="the comparison" onRetry={() => void submit(new Event('submit') as unknown as FormEvent)} />}
        {comparison && <ComparisonView result={comparison} />}
      </div>

      <div style={styles.card}>
        <h2 style={styles.h2}>
          Runs <span style={styles.muted}>({data?.count ?? runs.length})</span>
        </h2>
        <DataTable columns={columns} data={runs} emptyMessage="No runs" />
      </div>
    </div>
  );
}
