import type { Trace } from '../../api/types';
import { DataTable, type Column } from '../shared/DataTable';
import { TimeAgo } from '../shared/TimeAgo';
import { LatencyDisplay } from '../shared/LatencyDisplay';
import { CostDisplay } from '../shared/CostDisplay';
import { Badge } from '../shared/Badge';

export function TraceTable({
  traces,
  onSelect,
}: {
  traces: Trace[];
  onSelect: (trace: Trace) => void;
}) {
  const columns: Column<Trace>[] = [
    {
      key: 'agent_name',
      header: 'Agent',
      render: (t) => <strong>{t.agent_name}</strong>,
    },
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
  ];

  return <DataTable columns={columns} data={traces} onRowClick={onSelect} emptyMessage="No traces found" />;
}
