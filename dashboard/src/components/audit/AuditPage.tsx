/*
 * AuditPage — read-only view of ~/.iris/audit.log (B8.4).
 *
 * Lists every rule deploy / delete / toggle / update with timestamp,
 * user, rule id + name, and details payload. Filterable by action +
 * substring search. CSV export of the current filtered set.
 *
 * State coverage (per feedback_enterprise_state_completeness.md):
 *   - empty (no entries ever): hero CTA pointing at Make-This-A-Rule
 *   - empty after filter: clear-filter inline action
 *   - loading: skeleton
 *   - error: retry button
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuditLog } from '../../api/hooks';
import type { AuditAction, AuditLogEntry } from '../../api/types';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { Tooltip } from '../shared/Tooltip';
import { formatTimeAgo, formatTimestamp } from '../../utils/formatters';

const ACTION_OPTIONS: Array<{ value: AuditAction | ''; label: string }> = [
  { value: '', label: 'All actions' },
  { value: 'rule.deploy', label: 'Deploy' },
  { value: 'rule.delete', label: 'Delete' },
  { value: 'rule.toggle', label: 'Toggle' },
  { value: 'rule.update', label: 'Update' },
];

const ACTION_COLOR: Record<AuditAction, string> = {
  'rule.deploy': 'var(--accent-success)',
  'rule.delete': 'var(--accent-error)',
  'rule.toggle': 'var(--accent-warning)',
  'rule.update': 'var(--accent-tool)',
};

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-6)',
  } as const,
  header: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'flex-start',
    gap: 'var(--space-4)',
    flexWrap: 'wrap',
  } as const,
  titleBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
  } as const,
  title: {
    fontSize: 'var(--font-size-2xl)',
    fontWeight: 700,
    margin: 0,
    color: 'var(--text-primary)',
  } as const,
  subtitle: {
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-muted)',
    margin: 0,
    maxWidth: '640px',
  } as const,
  pathHint: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
  } as const,
  filterRow: {
    display: 'flex',
    gap: 'var(--space-3)',
    alignItems: 'center',
    flexWrap: 'wrap',
    background: 'var(--bg-secondary)',
    padding: 'var(--space-3) var(--space-4)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius)',
  } as const,
  label: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  } as const,
  select: {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-2)',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
  } as const,
  input: {
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-2)',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
    minWidth: '180px',
  } as const,
  exportBtn: {
    appearance: 'none',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
    cursor: 'pointer',
    marginLeft: 'auto',
  } as const,
  tableWrap: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius)',
    overflow: 'hidden',
  } as const,
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 'var(--font-size-sm)',
  } as const,
  th: {
    textAlign: 'left',
    padding: 'var(--space-2) var(--space-3)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-muted)',
    borderBottom: '1px solid var(--border-color)',
    background: 'var(--bg-tertiary)',
  } as const,
  td: {
    padding: 'var(--space-2) var(--space-3)',
    borderBottom: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    verticalAlign: 'top',
  } as const,
  actionPill: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-xs)',
    padding: '2px var(--space-2)',
    borderRadius: 'var(--border-radius-sm)',
    fontWeight: 600,
  } as const,
  details: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    maxWidth: '420px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  empty: {
    background: 'var(--bg-secondary)',
    border: '1px dashed var(--border-color)',
    borderRadius: 'var(--border-radius-lg)',
    padding: 'var(--space-12)',
    textAlign: 'center',
    color: 'var(--text-muted)',
  } as const,
  emptyTitle: {
    fontSize: 'var(--font-size-lg)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    margin: '0 0 var(--space-2)',
  } as const,
  errorBox: {
    background: 'oklch(28% 0.10 25 / 0.18)',
    border: '1px solid var(--accent-error)',
    borderRadius: 'var(--border-radius)',
    padding: 'var(--space-4)',
    color: 'var(--accent-error)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
  } as const,
  link: {
    color: 'var(--accent-primary)',
    textDecoration: 'underline',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-xs)',
  } as const,
  retryBtn: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--accent-error)',
    color: 'var(--accent-error)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
    width: 'fit-content',
  } as const,
};

function formatDetails(details?: Record<string, unknown>): string {
  if (!details || Object.keys(details).length === 0) return '—';
  return Object.entries(details)
    .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

function downloadCsv(entries: AuditLogEntry[]): void {
  const escape = (s: string): string => `"${s.replace(/"/g, '""')}"`;
  const header = ['ts', 'action', 'user', 'ruleId', 'ruleName', 'details'].join(',');
  const lines = entries.map((e) =>
    [
      escape(e.ts),
      escape(e.action),
      escape(e.user),
      escape(e.ruleId),
      escape(e.ruleName ?? ''),
      escape(formatDetails(e.details)),
    ].join(','),
  );
  const csv = [header, ...lines].join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `iris-audit-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function AuditPage() {
  const [actionFilter, setActionFilter] = useState<AuditAction | ''>('');
  const [search, setSearch] = useState('');

  const queryParams = useMemo<Record<string, string>>(() => {
    const params: Record<string, string> = { limit: '500' };
    if (actionFilter) params.action = actionFilter;
    if (search.trim()) params.search = search.trim();
    return params;
  }, [actionFilter, search]);

  const { data, loading, error, refetch } = useAuditLog(queryParams);

  const hasActiveFilters = Boolean(actionFilter) || Boolean(search.trim());
  const clear = () => {
    setActionFilter('');
    setSearch('');
  };

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div style={styles.titleBlock}>
          <h1 style={styles.title}>Audit log</h1>
          <p style={styles.subtitle}>
            Immutable record of every custom rule deploy, delete, toggle, and update. Stored in{' '}
            <code>~/.iris/audit.log</code> as append-only JSONL — the file is the source of
            truth, this view is just a window onto it.
          </p>
          {data?.path && (
            <span style={styles.pathHint}>file: {data.path}</span>
          )}
        </div>
      </div>

      <div style={styles.filterRow}>
        <span style={styles.label}>Filter</span>
        <select
          style={styles.select}
          value={actionFilter}
          onChange={(e) => setActionFilter(e.target.value as AuditAction | '')}
          aria-label="Filter by action"
        >
          {ACTION_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <input
          style={styles.input}
          type="search"
          placeholder="Search rule id or name…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          aria-label="Search audit entries"
        />
        {hasActiveFilters && (
          <button type="button" onClick={clear} style={{ ...styles.select, cursor: 'pointer' }}>
            Clear
          </button>
        )}
        {data && data.entries.length > 0 && (
          <button
            type="button"
            onClick={() => downloadCsv(data.entries)}
            style={styles.exportBtn}
            aria-label="Export current view as CSV"
          >
            Export CSV ({data.entries.length})
          </button>
        )}
      </div>

      {error && (
        <div style={styles.errorBox} role="alert">
          <strong>Could not load audit log</strong>
          <span>{error}</span>
          <button type="button" style={styles.retryBtn} onClick={refetch}>
            Retry
          </button>
        </div>
      )}

      {loading && !data && <LoadingSpinner />}

      {data && data.entries.length === 0 && (
        <div style={styles.empty}>
          {hasActiveFilters ? (
            <>
              <h2 style={styles.emptyTitle}>No entries match these filters</h2>
              <button
                type="button"
                onClick={clear}
                style={{ ...styles.retryBtn, color: 'var(--accent-primary)', borderColor: 'var(--accent-primary)' }}
              >
                Clear filters
              </button>
            </>
          ) : (
            <>
              <h2 style={styles.emptyTitle}>No audit entries yet</h2>
              <p>
                Deploy your first custom rule via the{' '}
                <Link to="/moments" style={styles.link}>Decision Moments timeline</Link>{' '}
                — every deploy + delete will appear here.
              </p>
            </>
          )}
        </div>
      )}

      {data && data.entries.length > 0 && (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>When</th>
                <th style={styles.th}>Action</th>
                <th style={styles.th}>Rule</th>
                <th style={styles.th}>User</th>
                <th style={styles.th}>Details</th>
              </tr>
            </thead>
            <tbody>
              {data.entries.map((entry, idx) => (
                <tr key={`${entry.ts}-${entry.ruleId}-${idx}`}>
                  <td style={styles.td}>
                    <Tooltip content={formatTimestamp(entry.ts)}>
                      <span tabIndex={0}>{formatTimeAgo(entry.ts)}</span>
                    </Tooltip>
                  </td>
                  <td style={styles.td}>
                    <span
                      style={{
                        ...styles.actionPill,
                        background: `${ACTION_COLOR[entry.action]} / 0.15`,
                        color: ACTION_COLOR[entry.action],
                      }}
                    >
                      {entry.action.replace('rule.', '')}
                    </span>
                  </td>
                  <td style={styles.td}>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                      <strong style={{ fontFamily: 'var(--font-mono)' }}>
                        {entry.ruleName ?? entry.ruleId}
                      </strong>
                      {entry.ruleName && (
                        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
                          {entry.ruleId}
                        </span>
                      )}
                    </div>
                  </td>
                  <td style={styles.td}>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{entry.user}</span>
                  </td>
                  <td style={styles.td}>
                    <Tooltip content={formatDetails(entry.details)}>
                      <span style={styles.details} tabIndex={0}>{formatDetails(entry.details)}</span>
                    </Tooltip>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
