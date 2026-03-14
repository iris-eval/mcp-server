import type { Span } from '../../api/types';
import { JsonViewer } from '../shared/JsonViewer';

export function SpanDetail({ span }: { span: Span }) {
  return (
    <div
      style={{
        padding: 'var(--space-4)',
        paddingLeft: 'var(--space-8)',
        background: 'var(--bg-primary)',
        borderBottom: '1px solid var(--border-color)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, 1fr)', gap: 'var(--space-2)', fontSize: 'var(--font-size-sm)' }}>
        <div><span style={{ color: 'var(--text-muted)' }}>Span ID:</span> <code>{span.span_id}</code></div>
        <div><span style={{ color: 'var(--text-muted)' }}>Trace ID:</span> <code>{span.trace_id}</code></div>
        <div><span style={{ color: 'var(--text-muted)' }}>Start:</span> {new Date(span.start_time).toLocaleString()}</div>
        <div><span style={{ color: 'var(--text-muted)' }}>End:</span> {span.end_time ? new Date(span.end_time).toLocaleString() : '—'}</div>
        {span.status_message && <div style={{ gridColumn: '1 / -1' }}><span style={{ color: 'var(--text-muted)' }}>Status:</span> {span.status_message}</div>}
      </div>
      {span.attributes && <JsonViewer data={span.attributes} label="Attributes" />}
      {span.events && span.events.length > 0 && <JsonViewer data={span.events} label="Events" />}
    </div>
  );
}
