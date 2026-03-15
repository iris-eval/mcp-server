import { useParams, Link } from 'react-router-dom';
import { useTraceDetail } from '../../api/hooks';
import { SpanTree } from './SpanTree';
import { ToolCallCard } from './ToolCallCard';
import { EvalDetailCard } from '../evals/EvalDetailCard';
import { Badge } from '../shared/Badge';
import { LatencyDisplay } from '../shared/LatencyDisplay';
import { CostDisplay } from '../shared/CostDisplay';
import { JsonViewer } from '../shared/JsonViewer';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { EmptyState } from '../shared/EmptyState';

const sectionStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-3)',
} as const;

const sectionTitle = {
  fontSize: 'var(--font-size-lg)',
  fontWeight: 600,
  color: 'var(--text-primary)',
} as const;

export function TraceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const { data, loading, error } = useTraceDetail(id!);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState message={`Error: ${error}`} />;
  if (!data) return <EmptyState message="Trace not found" />;

  const { trace, spans, evals } = data;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-4)' }}>
        <Link to="/traces" style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-sm)' }}>&larr; Back</Link>
        <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700 }}>Trace Detail</h1>
      </div>

      {/* Metadata */}
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius-lg)', padding: 'var(--space-5)' }}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 'var(--space-4)', fontSize: 'var(--font-size-sm)' }}>
          <div><span style={{ color: 'var(--text-muted)' }}>Trace ID</span><br /><code title={trace.trace_id} style={{ fontSize: 'var(--font-size-xs)' }}>{trace.trace_id.slice(0, 12)}...{trace.trace_id.slice(-4)}</code></div>
          <div><span style={{ color: 'var(--text-muted)' }}>Agent</span><br /><strong>{trace.agent_name}</strong></div>
          <div><span style={{ color: 'var(--text-muted)' }}>Framework</span><br />{trace.framework ? <Badge label={trace.framework} /> : '—'}</div>
          <div><span style={{ color: 'var(--text-muted)' }}>Latency</span><br />{trace.latency_ms != null ? <LatencyDisplay ms={trace.latency_ms} /> : '—'}</div>
          <div><span style={{ color: 'var(--text-muted)' }}>Cost</span><br />{trace.cost_usd != null ? <CostDisplay value={trace.cost_usd} /> : '—'}</div>
          <div><span style={{ color: 'var(--text-muted)' }}>Time</span><br />{new Date(trace.timestamp).toLocaleString()}</div>
        </div>
      </div>

      {/* Input/Output */}
      {(trace.input || trace.output) && (
        <div style={sectionStyle}>
          <h2 style={sectionTitle}>Input / Output</h2>
          {trace.input && <JsonViewer data={trace.input} label="Input" />}
          {trace.output && <JsonViewer data={trace.output} label="Output" />}
        </div>
      )}

      {/* Spans */}
      <div style={sectionStyle}>
        <h2 style={sectionTitle}>Spans ({spans.length})</h2>
        <SpanTree spans={spans} />
      </div>

      {/* Tool Calls */}
      {trace.tool_calls && trace.tool_calls.length > 0 && (
        <div style={sectionStyle}>
          <h2 style={sectionTitle}>Tool Calls ({trace.tool_calls.length})</h2>
          {trace.tool_calls.map((call, i) => (
            <ToolCallCard key={i} call={call} />
          ))}
        </div>
      )}

      {/* Evaluations */}
      {evals.length > 0 && (
        <div style={sectionStyle}>
          <h2 style={sectionTitle}>Evaluations ({evals.length})</h2>
          {evals.map((evalResult) => (
            <EvalDetailCard key={evalResult.id} evalResult={evalResult} />
          ))}
        </div>
      )}

      {/* Metadata */}
      {trace.metadata && (
        <div style={sectionStyle}>
          <h2 style={sectionTitle}>Metadata</h2>
          <JsonViewer data={trace.metadata} label="Metadata" />
        </div>
      )}
    </div>
  );
}
