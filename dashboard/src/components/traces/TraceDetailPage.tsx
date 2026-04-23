/*
 * TraceDetailPage — single trace surface.
 *
 * The chrome already renders h1 "Trace" from routeTitles. This page adds
 * the resource-specific summary card + semantic sections wrapped in
 * <section aria-labelledby> so AT users can navigate by structure.
 */
import { useParams, Link } from 'react-router-dom';
import { useTraceDetail } from '../../api/hooks';
import { SpanTree } from './SpanTree';
import { ToolCallCard } from './ToolCallCard';
import { EvalDetailCard } from '../evals/EvalDetailCard';
import { Badge } from '../shared/Badge';
import { LatencyDisplay } from '../shared/LatencyDisplay';
import { CostDisplay } from '../shared/CostDisplay';
import { CopyableId } from '../shared/CopyableId';
import { JsonViewer } from '../shared/JsonViewer';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { EmptyState } from '../shared/EmptyState';

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-6)',
  } as const,
  back: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
  } as const,
  summary: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    padding: 'var(--space-5)',
  } as const,
  summaryGrid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
    gap: 'var(--space-4)',
    fontSize: 'var(--text-body-sm)',
  } as const,
  summaryLabel: {
    color: 'var(--text-muted)',
    fontSize: 'var(--text-caption)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  } as const,
  section: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  sectionTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-heading-sm)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: '-0.01em',
    lineHeight: 'var(--leading-heading)',
    margin: 0,
  } as const,
};

export function TraceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useTraceDetail(id!);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState message={`Error: ${error}`} />;
  if (!data) return <EmptyState message="Trace not found" />;

  const { trace, spans, evals } = data;

  return (
    <div style={styles.page}>
      <Link to="/traces" style={styles.back}>&larr; Back to traces</Link>

      <section aria-labelledby="trace-summary-title" style={styles.summary}>
        <h2 id="trace-summary-title" style={{ ...styles.summaryLabel, marginBottom: 'var(--space-3)' }}>
          Trace summary
        </h2>
        <div style={styles.summaryGrid}>
          <div>
            <span style={styles.summaryLabel}>Trace ID</span><br />
            <CopyableId
              value={trace.trace_id}
              displayValue={`${trace.trace_id.slice(0, 12)}...${trace.trace_id.slice(-4)}`}
              ariaLabel="Copy trace ID"
            />
          </div>
          <div><span style={styles.summaryLabel}>Agent</span><br /><strong>{trace.agent_name}</strong></div>
          <div><span style={styles.summaryLabel}>Framework</span><br />{trace.framework ? <Badge label={trace.framework} /> : '—'}</div>
          <div><span style={styles.summaryLabel}>Latency</span><br />{trace.latency_ms != null ? <LatencyDisplay ms={trace.latency_ms} /> : '—'}</div>
          <div><span style={styles.summaryLabel}>Cost</span><br />{trace.cost_usd != null ? <CostDisplay value={trace.cost_usd} /> : '—'}</div>
          <div><span style={styles.summaryLabel}>Time</span><br />{new Date(trace.timestamp).toLocaleString()}</div>
        </div>
      </section>

      {(trace.input || trace.output) && (
        <section aria-labelledby="trace-io-title" style={styles.section}>
          <h2 id="trace-io-title" style={styles.sectionTitle}>Input / Output</h2>
          {trace.input && <JsonViewer data={trace.input} label="Input" />}
          {trace.output && <JsonViewer data={trace.output} label="Output" />}
        </section>
      )}

      <section aria-labelledby="trace-spans-title" style={styles.section}>
        <h2 id="trace-spans-title" style={styles.sectionTitle}>Spans ({spans.length})</h2>
        <SpanTree spans={spans} />
      </section>

      {trace.tool_calls && trace.tool_calls.length > 0 && (
        <section aria-labelledby="trace-tools-title" style={styles.section}>
          <h2 id="trace-tools-title" style={styles.sectionTitle}>Tool Calls ({trace.tool_calls.length})</h2>
          {trace.tool_calls.map((call, i) => (
            <ToolCallCard key={i} call={call} />
          ))}
        </section>
      )}

      {evals.length > 0 && (
        <section aria-labelledby="trace-evals-title" style={styles.section}>
          <h2 id="trace-evals-title" style={styles.sectionTitle}>Evaluations ({evals.length})</h2>
          {evals.map((evalResult) => (
            <EvalDetailCard key={evalResult.id} evalResult={evalResult} />
          ))}
        </section>
      )}

      {trace.metadata && (
        <section aria-labelledby="trace-metadata-title" style={styles.section}>
          <h2 id="trace-metadata-title" style={styles.sectionTitle}>Metadata</h2>
          <JsonViewer data={trace.metadata} label="Metadata" />
        </section>
      )}
    </div>
  );
}
