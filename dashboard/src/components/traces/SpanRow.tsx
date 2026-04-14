import { useState } from 'react';
import type { Span } from '../../api/types';
import { Badge } from '../shared/Badge';
import { LatencyDisplay } from '../shared/LatencyDisplay';
import { SpanDetail } from './SpanDetail';

export function SpanRow({ span, depth = 0 }: { span: Span; depth?: number }) {
  const [expanded, setExpanded] = useState(false);
  const latencyMs =
    span.end_time && span.start_time
      ? new Date(span.end_time).getTime() - new Date(span.start_time).getTime()
      : null;

  return (
    <div>
      <div
        onClick={() => setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setExpanded(!expanded); } }}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        aria-label={`${expanded ? 'Collapse' : 'Expand'} span ${span.name}`}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 'var(--space-3)',
          padding: 'var(--space-2) var(--space-3)',
          paddingLeft: `${16 + depth * 24}px`,
          cursor: 'pointer',
          borderBottom: '1px solid var(--border-color)',
          fontSize: 'var(--font-size-sm)',
        }}
        onMouseOver={(e) => { (e.currentTarget as HTMLElement).style.background = 'var(--bg-hover)'; }}
        onMouseOut={(e) => { (e.currentTarget as HTMLElement).style.background = 'transparent'; }}
      >
        <span style={{ color: 'var(--text-muted)', width: '12px' }}>{expanded ? '\u25BC' : '\u25B6'}</span>
        <Badge label={span.kind} />
        <Badge label={span.status_code} />
        <span style={{ flex: 1, color: 'var(--text-primary)' }}>{span.name}</span>
        {latencyMs != null && <LatencyDisplay ms={latencyMs} />}
      </div>
      {expanded && <SpanDetail span={span} />}
    </div>
  );
}
