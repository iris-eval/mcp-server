import { useState, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTraces } from '../../api/hooks';
import { TraceFilters } from './TraceFilters';
import { TraceTable } from './TraceTable';
import { Pagination } from '../shared/Pagination';
import { LoadingSpinner } from '../shared/LoadingSpinner';

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

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700 }}>Traces</h1>
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
