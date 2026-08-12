/*
 * TraceDetailPage — single trace surface.
 *
 * The chrome already renders h1 "Trace" from routeTitles. This page adds
 * the resource-specific summary card + semantic sections wrapped in
 * <section aria-labelledby> so AT users can navigate by structure.
 */
import { useParams, Link } from 'react-router';
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

/* Static styling lives in utilities.css (.detail-* block). */

export function TraceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useTraceDetail(id!);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState message={`Error: ${error}`} />;
  if (!data) return <EmptyState message="Trace not found" />;

  const { trace, spans, evals } = data;

  return (
    <div className="iris-stack iris-stack--lg">
      <Link to="/traces" className="detail-back">&larr; Back to traces</Link>

      <section aria-labelledby="trace-summary-title" className="iris-card detail-card">
        <h2
          id="trace-summary-title"
          className="detail-card__label"
          style={{ marginBottom: 'var(--space-3)' }}
        >
          Trace summary
        </h2>
        <div className="detail-card__grid">
          <div>
            <span className="detail-card__label">Trace ID</span><br />
            <CopyableId
              value={trace.trace_id}
              displayValue={`${trace.trace_id.slice(0, 12)}...${trace.trace_id.slice(-4)}`}
              ariaLabel="Copy trace ID"
            />
          </div>
          <div><span className="detail-card__label">Agent</span><br /><strong>{trace.agent_name}</strong></div>
          <div><span className="detail-card__label">Framework</span><br />{trace.framework ? <Badge label={trace.framework} /> : '—'}</div>
          <div><span className="detail-card__label">Latency</span><br />{trace.latency_ms != null ? <LatencyDisplay ms={trace.latency_ms} /> : '—'}</div>
          <div><span className="detail-card__label">Cost</span><br />{trace.cost_usd != null ? <CostDisplay value={trace.cost_usd} /> : '—'}</div>
          <div><span className="detail-card__label">Time</span><br />{new Date(trace.timestamp).toLocaleString()}</div>
        </div>
      </section>

      {(trace.input || trace.output) && (
        <section aria-labelledby="trace-io-title" className="detail-section">
          <h2 id="trace-io-title" className="detail-section__title">Input / Output</h2>
          {trace.input && <JsonViewer data={trace.input} label="Input" />}
          {trace.output && <JsonViewer data={trace.output} label="Output" />}
        </section>
      )}

      <section aria-labelledby="trace-spans-title" className="detail-section">
        <h2 id="trace-spans-title" className="detail-section__title">Spans ({spans.length})</h2>
        <SpanTree spans={spans} />
      </section>

      {trace.tool_calls && trace.tool_calls.length > 0 && (
        <section aria-labelledby="trace-tools-title" className="detail-section">
          <h2 id="trace-tools-title" className="detail-section__title">Tool Calls ({trace.tool_calls.length})</h2>
          {trace.tool_calls.map((call, i) => (
            <ToolCallCard key={i} call={call} />
          ))}
        </section>
      )}

      {evals.length > 0 && (
        <section aria-labelledby="trace-evals-title" className="detail-section">
          <h2 id="trace-evals-title" className="detail-section__title">Evaluations ({evals.length})</h2>
          {evals.map((evalResult) => (
            <EvalDetailCard key={evalResult.id} evalResult={evalResult} />
          ))}
        </section>
      )}

      {trace.metadata && (
        <section aria-labelledby="trace-metadata-title" className="detail-section">
          <h2 id="trace-metadata-title" className="detail-section__title">Metadata</h2>
          <JsonViewer data={trace.metadata} label="Metadata" />
        </section>
      )}
    </div>
  );
}
