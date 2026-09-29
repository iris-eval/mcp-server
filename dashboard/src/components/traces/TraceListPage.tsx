import { useState, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { useTraces } from '../../api/hooks';
import { TraceFilters } from './TraceFilters';
import { TraceSearch, hasSearchableWord, shortPrefixes, SEARCH_MIN_PREFIX_CHARS } from './TraceSearch';
import type { TraceQueryResult } from '../../api/types';
import { TraceTable } from './TraceTable';
import { Pagination } from '../shared/Pagination';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { QueryError } from '../shared/QueryError';
import { ExportMenu } from '../shared/ExportMenu';

const styles = {
  toolbar: {
    display: 'flex',
    gap: 'var(--space-3)',
    flexWrap: 'wrap',
    alignItems: 'flex-start',
  } as const,
  toolbarEnd: {
    marginLeft: 'auto',
  } as const,
  status: {
    color: 'var(--text-secondary)',
    fontSize: 'var(--font-size-sm)',
    minHeight: '1.25em',
  } as const,
};

/** The line under the toolbar that says what a search found; announced to screen readers as it changes. */
function searchStatus(q: string, searchable: boolean, short: string[], total: number | undefined, search: TraceQueryResult['search']): string {
  if (q.trim() === '') return '';
  if (!searchable) return 'Search matches words and numbers — punctuation on its own is not searchable.';
  if (short.length > 0) return `A prefix needs at least ${SEARCH_MIN_PREFIX_CHARS} letters before the * (${short.join(', ')} starts too many words to narrow the search): type more of the word, or drop the *.`;
  if (total === undefined || search === undefined) return 'Searching…';
  const shown = q.trim();
  let counted: string;
  if (search.complete === false) {
    // Stopped at the time budget: the count and the page are of the newest traces it read, not of them all.
    const seconds = (search.budget_ms ?? 1000) / 1000;
    const budget = `${seconds.toLocaleString()} ${seconds === 1 ? 'second' : 'seconds'}`;
    counted =
      total === 0
        ? `No match for “${shown}” in the newest traces read before the search stopped at its limit of ${budget}. Add a word or a filter to narrow it.`
        : `At least ${total.toLocaleString()} ${total === 1 ? 'trace matches' : 'traces match'} “${shown}”: the search stopped at its limit of ${budget}, so these are the best matches among the newest traces it read. Add a word or a filter to narrow it.`;
  } else {
    counted = total === 0 ? `No traces match “${shown}”.` : `${total.toLocaleString()} ${total === 1 ? 'trace matches' : 'traces match'} “${shown}”, best match first.`;
  }
  // Honest about the slower path: this SQLite has no full-text index, so the traces were read one by one.
  return search.index === 'scan' ? `${counted} (Searched without the full-text index, so larger stores search slowly.)` : counted;
}

export function TraceListPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const q = searchParams.get('q') ?? '';
  const short = shortPrefixes(q);
  // A prefix the server would refuse is not sent: the status line says why instead.
  const searchable = hasSearchableWord(q) && short.length === 0;
  const [filters, setFilters] = useState({
    agent_name: '',
    framework: '',
    since: '',
    until: '',
  });
  const [offset, setOffset] = useState(0);
  const limit = 50;

  // What the list is filtered by: sent with each page, and what the export carries (#4).
  const filterParams = useMemo(() => {
    const p: Record<string, string> = {};
    if (filters.agent_name) p.agent_name = filters.agent_name;
    if (filters.framework) p.framework = filters.framework;
    if (filters.since) p.since = new Date(filters.since).toISOString();
    if (filters.until) p.until = new Date(filters.until).toISOString();
    if (searchable) p.q = q.trim();
    return p;
  }, [filters, q, searchable]);
  const params = useMemo(() => ({ limit: String(limit), offset: String(offset), ...filterParams }), [filterParams, offset]);

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
        <div style={styles.toolbarEnd}>
          <ExportMenu kind="traces" filters={filterParams} total={data?.total} />
        </div>
      </div>
      <div role="status" aria-live="polite" style={styles.status}>
        {searchStatus(q, hasSearchableWord(q), short, searchable && data?.search ? data.total : undefined, data?.search)}
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
