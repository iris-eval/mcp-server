import { useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTraces } from '../../api/hooks';
import { TraceFilters } from './TraceFilters';
import { TraceSearch, hasSearchableWord } from './TraceSearch';
import { TraceTable } from './TraceTable';
import { Pagination } from '../shared/Pagination';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { QueryError } from '../shared/QueryError';

const styles = {
  toolbar: {
    display: 'flex',
    gap: 'var(--space-3)',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  } as const,
  status: {
    color: 'var(--text-secondary)',
    fontSize: 'var(--font-size-sm)',
    minHeight: '1.25em',
  } as const,
};

/** The line under the toolbar that says what a search found; announced to screen readers as it changes. */
function searchStatus(q: string, searchable: boolean, total: number | undefined, index: 'fts5' | 'scan' | undefined): string {
  if (q.trim() === '') return '';
  if (!searchable) return 'Search matches words and numbers — punctuation on its own is not searchable.';
  if (total === undefined) return 'Searching…';
  const counted = total === 0 ? `No traces match “${q.trim()}”.` : `${total.toLocaleString()} ${total === 1 ? 'trace matches' : 'traces match'} “${q.trim()}”, best match first.`;
  // Honest about the slower path: this SQLite has no full-text index, so the traces were read one by one.
  return index === 'scan' ? `${counted} (Searched without the full-text index, so larger stores search slowly.)` : counted;
}

export function TraceListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const searchable = hasSearchableWord(q);
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
    if (searchable) p.q = q.trim();
    return p;
  }, [filters, offset, q, searchable]);

  const { data, loading, error, refetch, rateLimitedUntil } = useTraces(params);
  const searching = searchable && data?.search !== undefined;

  const onSearch = (next: string) => {
    const nextParams = new URLSearchParams(searchParams);
    if (next.trim() === '') nextParams.delete('q');
    else nextParams.set('q', next);
    setSearchParams(nextParams, { replace: true });
    setOffset(0);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
      <div style={styles.toolbar}>
        <TraceSearch value={q} onCommit={onSearch} />
        <TraceFilters values={filters} onChange={(v) => { setFilters(v); setOffset(0); }} />
      </div>
      <div role="status" aria-live="polite" style={styles.status}>
        {searchStatus(q, searchable, searchable && data?.search ? data.total : undefined, data?.search?.index)}
      </div>
      {error && <QueryError error={error} what="traces" onRetry={refetch} rateLimitedUntil={rateLimitedUntil} />}
      <div style={{ background: 'var(--bg-secondary)', border: '1px solid var(--border-color)', borderRadius: 'var(--border-radius-lg)', overflow: 'hidden' }}>
        {loading && !data ? (
          <LoadingSpinner />
        ) : (
          <>
            <TraceTable
              traces={data?.traces ?? []}
              onSelect={(t) => navigate(`/traces/${t.trace_id}`)}
              searching={searching}
              emptyMessage={searchable ? `No traces match “${q.trim()}”` : undefined}
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
