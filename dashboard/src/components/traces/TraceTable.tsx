import type { Trace } from '../../api/types';
import { DataTable, type Column } from '../shared/DataTable';
import { TimeAgo } from '../shared/TimeAgo';
import { LatencyDisplay } from '../shared/LatencyDisplay';
import { CostDisplay } from '../shared/CostDisplay';
import { Badge } from '../shared/Badge';
import { CopyableId } from '../shared/CopyableId';
import { MatchSnippet } from './MatchSnippet';

export function TraceTable({
  traces,
  onSelect,
  searching = false,
  emptyMessage = 'No traces found',
}: {
  traces: Trace[];
  onSelect: (trace: Trace) => void;
  /** A search is showing: add the column with where each trace matched. */
  searching?: boolean;
  emptyMessage?: string;
}) {
  const columns: Column<Trace>[] = [
    {
      key: 'agent_name',
      header: 'Agent',
      render: (t) => <strong>{t.agent_name}</strong>,
    },
    ...(searching
      ? [
          {
            key: 'match',
            header: 'Match',
            render: (t: Trace) => (t.match ? <MatchSnippet match={t.match} /> : null),
            // The excerpt is the reason the row is on screen; it takes the room the text needs.
            width: '45%',
          },
        ]
      : []),
    {
      key: 'framework',
      header: 'Framework',
      render: (t) => t.framework ? <Badge label={t.framework} /> : <span style={{ color: 'var(--text-muted)' }}>—</span>,
    },
    {
      key: 'latency_ms',
      header: 'Latency',
      render: (t) => t.latency_ms != null ? <LatencyDisplay ms={t.latency_ms} /> : '—',
      width: '100px',
    },
    {
      key: 'cost_usd',
      header: 'Cost',
      render: (t) => t.cost_usd != null ? <CostDisplay value={t.cost_usd} /> : '—',
      width: '100px',
    },
    {
      key: 'tools',
      header: 'Tools',
      render: (t) => t.tool_calls?.length ?? 0,
      width: '80px',
    },
    {
      key: 'timestamp',
      header: 'Time',
      render: (t) => <TimeAgo timestamp={t.timestamp} />,
      width: '120px',
    },
    {
      key: 'trace_id',
      header: 'ID',
      render: (t) => (
        <CopyableId
          value={t.trace_id}
          displayValue={t.trace_id.slice(-8)}
          ariaLabel={`Copy trace ID ${t.trace_id}`}
        />
      ),
      width: '160px',
    },
  ];

  return (
    <DataTable
      columns={columns}
      data={traces}
      onRowClick={onSelect}
      rowActionLabel={(t) => `Open trace ${t.trace_id.slice(-8)} from ${t.agent_name}`}
      emptyMessage={emptyMessage}
    />
  );
}
