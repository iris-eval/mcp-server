import type { ToolCallRecord } from '../../api/types';
import { Badge } from '../shared/Badge';
import { JsonViewer } from '../shared/JsonViewer';

export function ToolCallCard({ call }: { call: ToolCallRecord }) {
  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--border-radius)',
        padding: 'var(--space-4)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <Badge label="TOOL" />
        <strong style={{ fontSize: 'var(--font-size-sm)' }}>{call.tool_name}</strong>
        {call.latency_ms != null && (
          <span style={{ color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)', fontFamily: 'var(--font-mono)' }}>
            {call.latency_ms}ms
          </span>
        )}
        {call.error && <Badge label="ERROR" variant="ERROR" />}
      </div>
      {call.input !== undefined && <JsonViewer data={call.input} label="Input" />}
      {call.output !== undefined && <JsonViewer data={call.output} label="Output" />}
      {call.error && (
        <div style={{ color: 'var(--accent-error)', fontSize: 'var(--font-size-sm)', fontFamily: 'var(--font-mono)' }}>
          {call.error}
        </div>
      )}
    </div>
  );
}
