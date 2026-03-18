import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTraces } from '../../api/hooks';
import { api } from '../../api/client';
import { TraceFilters } from './TraceFilters';
import { TraceTable } from './TraceTable';
import { Pagination } from '../shared/Pagination';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { ExportButton } from '../shared/ExportButton';

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

  const filterParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (filters.agent_name) p.agent_name = filters.agent_name;
    if (filters.framework) p.framework = filters.framework;
    if (filters.since) p.since = new Date(filters.since).toISOString();
    if (filters.until) p.until = new Date(filters.until).toISOString();
    return p;
  }, [filters]);

  const { data, loading } = useTraces(params);

  function handleExport(format: 'csv' | 'json') {
    const url = api.getTracesExportUrl({ ...filterParams, format });
    window.open(url, '_blank');
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
