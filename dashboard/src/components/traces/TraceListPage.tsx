import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTraces } from '../../api/hooks';
import { TraceFilters } from './TraceFilters';
import { TraceTable } from './TraceTable';
import { Pagination } from '../shared/Pagination';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { ExportButton } from '../shared/ExportButton';
import type { Trace } from '../../api/types';

function escapeCsvValue(value: unknown): string {
  const s = value === null || value === undefined ? '' : String(value);
  return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
}

function tracesToCsv(traces: Trace[]): string {
  const headers = [
    'trace_id',
    'agent_name',
    'framework',
    'latency_ms',
    'cost_usd',
    'tool_calls_count',
    'timestamp',
  ];

  const rows = traces.map((trace) => [
    trace.trace_id,
    trace.agent_name,
    trace.framework ?? '',
    trace.latency_ms ?? '',
    trace.cost_usd ?? '',
    trace.tool_calls?.length ?? 0,
    trace.timestamp,
  ].map(escapeCsvValue).join(','));

  return [headers.join(','), ...rows].join('\n');
}

function downloadFile(content: string, fileName: string, contentType: string): void {
  const blob = new Blob([content], { type: contentType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function TraceListPage() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState({
    agent_name: '',
    framework: '',
    since: '',
    until: '',
  });
  const [offset, setOffset] = useState(0);
  const limit = 50;

  const params = useMemo(() => {
    const p: Record<string, string> = { limit: String(limit), offset: String(offset) };
    if (filters.agent_name) p.agent_name = filters.agent_name;
    if (filters.framework) p.framework = filters.framework;
    if (filters.since) p.since = new Date(filters.since).toISOString();
    if (filters.until) p.until = new Date(filters.until).toISOString();
    return p;
  }, [filters, offset]);

  const { data, loading } = useTraces(params);

  function handleExport(format: 'csv' | 'json') {
    const traces = data?.traces ?? [];
    if (traces.length === 0) {
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    if (format === 'csv') {
      downloadFile(tracesToCsv(traces), `traces-visible-${timestamp}.csv`, 'text/csv;charset=utf-8');
      return;
    }

    downloadFile(JSON.stringify(traces, null, 2), `traces-visible-${timestamp}.json`, 'application/json;charset=utf-8');
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700 }}>Traces</h1>
        <ExportButton onExport={handleExport} />
      </div>
      <TraceFilters values={filters} onChange={(v) => { setFilters(v); setOffset(0); }} />
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius-lg)', overflow: 'hidden' }}>
        {loading && !data ? (
          <LoadingSpinner />
        ) : (
          <>
            <TraceTable
              traces={data?.traces ?? []}
              onSelect={(t) => navigate(`/traces/${t.trace_id}`)}
            />
            {data && data.total > limit && (
              <div style={{ padding: '0 var(--space-4)' }}>
                <Pagination total={data.total} limit={limit} offset={offset} onPageChange={setOffset} />
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
