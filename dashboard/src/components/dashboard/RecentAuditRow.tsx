/*
 * RecentAuditRow — dashboard Row 4 — "RECENT AUDIT".
 *
 * Shows the top 3 rule changes (deploy / delete / toggle) since last
 * visit. Click any entry → /audit (with that entry highlighted via URL
 * fragment, future enhancement).
 *
 * Empty state surfaces the workflow-inversion entry point — same copy
 * pattern as RuleListByCategory's empty custom-rules section.
 */
import { Link } from 'react-router-dom';
import { History, ChevronRight } from 'lucide-react';
import { useAuditLog } from '../../api/hooks';
import { Icon } from '../shared/Icon';
import { Tooltip } from '../shared/Tooltip';
import { formatTimeAgo } from '../../utils/formatters';
import type { AuditAction } from '../../api/types';

const styles = {
  card: {
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius-lg)',
    overflow: 'hidden',
  } as const,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'var(--space-3) var(--space-4)',
    borderBottom: '1px solid var(--border-subtle)',
    background: 'var(--bg-surface)',
  } as const,
  title: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-caption)',
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.08em',
  } as const,
  link: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-accent)',
    textDecoration: 'none',
    fontFamily: 'var(--font-mono)',
  } as const,
  row: {
    display: 'grid',
    gridTemplateColumns: 'auto 1fr 1fr auto',
    gap: 'var(--space-3)',
    alignItems: 'center',
    padding: 'var(--space-2) var(--space-4)',
    borderBottom: '1px solid var(--border-subtle)',
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-primary)',
    textDecoration: 'none',
    minHeight: '32px',
  } as const,
  actionPill: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    fontWeight: 600,
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-pill)',
    minWidth: '64px',
    textAlign: 'center',
  } as const,
  ruleName: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  user: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-secondary)',
  } as const,
  time: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    minWidth: '64px',
    textAlign: 'right',
  } as const,
  empty: {
    padding: 'var(--space-4) var(--space-4)',
    color: 'var(--text-secondary)',
    fontSize: 'var(--text-body-sm)',
    lineHeight: 1.5,
  } as const,
  emptyCta: {
    color: 'var(--text-accent)',
    textDecoration: 'underline',
  } as const,
};

const ACTION_STYLE: Record<AuditAction, { bg: string; fg: string; label: string }> = {
  'rule.deploy': { bg: 'rgba(34, 197, 94, 0.12)', fg: 'var(--eval-pass)', label: 'deploy' },
  'rule.delete': { bg: 'rgba(239, 68, 68, 0.12)', fg: 'var(--eval-fail)', label: 'delete' },
  'rule.toggle': { bg: 'rgba(234, 179, 8, 0.12)', fg: 'var(--eval-warn)', label: 'toggle' },
  'rule.update': { bg: 'rgba(59, 130, 246, 0.12)', fg: 'var(--eval-tool)', label: 'update' },
};

export function RecentAuditRow() {
  const { data, loading } = useAuditLog({ limit: '3' });

  return (
    <div style={styles.card}>
      <div style={styles.header}>
        <div style={styles.title}>
          <Icon as={History} size={14} />
          Recent audit
        </div>
        <Link to="/audit" style={styles.link}>
          View audit log <Icon as={ChevronRight} size={14} />
        </Link>
      </div>

      {loading && !data && <div style={styles.empty}>Loading…</div>}

      {data && data.entries.length === 0 && (
        <div style={styles.empty}>
          No rule changes yet. Deploy your first custom rule from any{' '}
          <Link to="/moments" style={styles.emptyCta}>Decision Moment</Link>{' '}
          and the deploy event appears here. Every change is also written to{' '}
          <code style={{ background: 'var(--bg-surface)', padding: '0 4px', borderRadius: '3px' }}>~/.iris/audit.log</code>.
        </div>
      )}

      {data && data.entries.length > 0 && data.entries.slice(0, 3).map((entry, i) => {
        const action = ACTION_STYLE[entry.action];
        return (
          <Link
            key={`${entry.ts}-${i}`}
            to="/audit"
            style={styles.row}
            title="Open audit log"
          >
            <Tooltip content={action.label}>
              <span style={{ ...styles.actionPill, background: action.bg, color: action.fg }} tabIndex={0}>
                {action.label}
              </span>
            </Tooltip>
            <span style={styles.ruleName}>{entry.ruleName ?? entry.ruleId}</span>
            <span style={styles.user}>{entry.user}</span>
            <Tooltip content={new Date(entry.ts).toLocaleString()}>
              <span style={styles.time} tabIndex={0}>{formatTimeAgo(entry.ts)}</span>
            </Tooltip>
          </Link>
        );
      })}
    </div>
  );
}
