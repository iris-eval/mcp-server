/*
 * AuditPage — read-only view of ~/.iris/audit.log (B8.4).
 *
 * Lists every rule deploy / delete / toggle / update with timestamp,
 * user, rule id + name, and details payload. Filterable by action +
 * substring search. CSV export of the current filtered set.
 *
 * State coverage (per feedback_enterprise_state_completeness.md):
 *   - empty (no entries ever): PageEmptyState pointing at Make-This-A-Rule
 *   - empty after filter: clear-filter inline action
 *   - loading: skeleton
 *   - error: retry button
 */
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { History, Download } from 'lucide-react';
import { useAuditLog } from '../../api/hooks';
import type { AuditAction, AuditLogEntry } from '../../api/types';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { Tooltip } from '../shared/Tooltip';
import { Icon } from '../shared/Icon';
import { formatTimeAgo, formatTimestamp } from '../../utils/formatters';
import { PageHeader } from '../layout/PageHeader';
import { PageToolbar } from '../layout/PageToolbar';
import { PageEmptyState } from '../layout/PageEmptyState';

const ACTION_OPTIONS: Array<{ value: AuditAction | ''; label: string }> = [
  { value: '', label: 'All actions' },
  { value: 'rule.deploy', label: 'Deploy' },
  { value: 'rule.delete', label: 'Delete' },
  { value: 'rule.toggle', label: 'Toggle' },
  { value: 'rule.update', label: 'Update' },
];

const ACTION_COLOR: Record<AuditAction, string> = {
  'rule.deploy': 'var(--eval-pass)',
  'rule.delete': 'var(--eval-fail)',
  'rule.toggle': 'var(--eval-warn)',
  'rule.update': 'var(--accent-tool)',
};

const ACTION_BG: Record<AuditAction, string> = {
  'rule.deploy': 'rgba(34, 197, 94, 0.15)',
  'rule.delete': 'rgba(239, 68, 68, 0.15)',
  'rule.toggle': 'rgba(245, 158, 11, 0.15)',
  'rule.update': 'rgba(20, 184, 166, 0.15)',
};

const styles = {
  page: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-4)',
  } as const,
  filterLabel: {
    fontSize: 'var(--text-caption-xs)',
    color: 'var(--text-muted)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
  } as const,
  select: {
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--space-1) var(--space-2)',
    fontSize: 'var(--text-body-sm)',
    fontFamily: 'inherit',
  } as const,
  input: {
    background: 'var(--bg-card)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--space-1) var(--space-2)',
    fontSize: 'var(--text-body-sm)',
    fontFamily: 'inherit',
    minWidth: '200px',
  } as const,
  exportBtn: {
    appearance: 'none',
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    fontSize: 'var(--text-body-sm)',
    fontFamily: 'inherit',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1_5)',
    transition: 'background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast)',
  } as const,
  pathHint: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
  } as const,
  countBadge: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
  } as const,
  tableWrap: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
  } as const,
  table: {
    width: '100%',
    borderCollapse: 'collapse',
    fontSize: 'var(--text-body-sm)',
  } as const,
  th: {
    textAlign: 'left',
    padding: 'var(--space-2) var(--space-3)',
    fontSize: 'var(--text-caption-xs)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-muted)',
    borderBottom: '1px solid var(--border-subtle)',
    background: 'var(--bg-surface)',
  } as const,
  td: {
    padding: 'var(--space-2) var(--space-3)',
    borderBottom: '1px solid var(--border-subtle)',
    color: 'var(--text-primary)',
    verticalAlign: 'top',
  } as const,
  actionPill: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-pill)',
    fontWeight: 600,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  } as const,
  details: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    maxWidth: '420px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    display: 'block',
  } as const,
  errorBox: {
    background: 'rgba(239, 68, 68, 0.10)',
    border: '1px solid var(--eval-fail)',
    borderRadius: 'var(--radius)',
    padding: 'var(--space-4)',
    color: 'var(--eval-fail)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-2)',
  } as const,
  link: {
    color: 'var(--text-accent)',
    textDecoration: 'underline',
    fontFamily: 'var(--font-mono)',
  } as const,
  retryBtn: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--eval-fail)',
    color: 'var(--eval-fail)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    cursor: 'pointer',
    fontSize: 'var(--text-body-sm)',
    fontFamily: 'inherit',
    width: 'fit-content',
  } as const,
  clearBtn: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--iris-500)',
    color: 'var(--iris-400)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--space-2) var(--space-4)',
    cursor: 'pointer',
    fontSize: 'var(--text-body-sm)',
    fontFamily: 'inherit',
  } as const,
  emptyCta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    background: 'var(--iris-600)',
    color: 'white',
    padding: 'var(--space-2) var(--space-4)',
    borderRadius: 'var(--radius-sm)',
    textDecoration: 'none',
    fontWeight: 600,
    fontSize: 'var(--text-body-sm)',
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
      <PageHeader
        subtitle={
          <>
            Immutable record of every custom rule deploy, delete, toggle, and update. Stored in{' '}
            <code style={{ fontFamily: 'var(--font-mono)' }}>~/.iris/audit.log</code> as
            append-only JSONL — the file is the source of truth, this view is just a window onto it.
          </>
        }
        meta={
          <span style={styles.countBadge}>
            {data ? `${data.entries.length} entries` : '—'}
            {data?.path && <> · <span style={styles.pathHint}>{data.path}</span></>}
          </span>
        }
      />

      <PageToolbar
        filters={
          <>
            <span style={styles.filterLabel}>Filter</span>
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
          </>
        }
        actions={
          data && data.entries.length > 0 ? (
            <button
              type="button"
              onClick={() => downloadCsv(data.entries)}
              style={styles.exportBtn}
              aria-label="Export current view as CSV"
            >
              <Icon as={Download} size={14} />
              Export CSV ({data.entries.length})
            </button>
          ) : null
        }
      />

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
        hasActiveFilters ? (
          <PageEmptyState
            icon={History}
            title="No entries match these filters"
            body="Try a different action or clear the search."
            cta={
              <button type="button" onClick={clear} style={styles.clearBtn}>
                Clear filters
              </button>
            }
          />
        ) : (
          <PageEmptyState
            icon={History}
            title="No audit entries yet"
            body={
              <>
                Every Make-This-A-Rule deploy, delete, toggle, or update leaves an immutable record here.
                Open the{' '}
                <Link to="/moments" style={styles.link}>Decision Moments</Link>{' '}
                timeline and ship your first rule to see it logged.
              </>
            }
            cta={
              <Link to="/moments" style={styles.emptyCta}>
                Open Decision Moments →
              </Link>
            }
          />
        )
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
                        background: ACTION_BG[entry.action],
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
                        <span style={{ fontSize: 'var(--text-caption-xs)', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
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
