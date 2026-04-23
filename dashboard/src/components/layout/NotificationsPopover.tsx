/*
 * NotificationsPopover — recent rule activity surfaced from the audit log.
 *
 * The audit log is already the authoritative feed of deploys / deletes /
 * toggles / updates. This popover surfaces the most recent ~10 entries
 * plus an unread badge based on preferences.notificationsLastSeen.
 *
 * Opening the popover updates notificationsLastSeen to now — subsequent
 * opens show the same entries but the badge clears. This is a read
 * surface, not an event bus: the audit log IS the source of truth, and
 * we never write "notification objects" separately.
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bell, Sparkles, Trash2, ToggleRight, PencilLine } from 'lucide-react';
import { Icon } from '../shared/Icon';
import { useAuditLog } from '../../api/hooks';
import { usePreferences } from '../../hooks/usePreferences';
import type { AuditLogEntry } from '../../api/types';
import { formatTimeAgo } from '../../utils/formatters';

const styles = {
  triggerWrap: {
    position: 'relative',
    display: 'inline-block',
  } as const,
  trigger: {
    appearance: 'none',
    width: '32px',
    height: '32px',
    border: '1px solid var(--border-default)',
    background: 'var(--bg-card)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--radius-sm)',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    transition: 'background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast)',
  } as const,
  triggerOpen: {
    borderColor: 'var(--border-glow)',
    color: 'var(--text-primary)',
  } as const,
  badge: {
    position: 'absolute',
    top: '-4px',
    right: '-4px',
    minWidth: '16px',
    height: '16px',
    padding: '0 4px',
    background: 'var(--iris-500)',
    color: 'var(--bg-base)',
    borderRadius: 'var(--radius-pill)',
    fontFamily: 'var(--font-mono)',
    fontSize: '10px',
    fontWeight: 700,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    border: '2px solid var(--bg-base)',
  } as const,
  popover: {
    position: 'absolute',
    top: 'calc(100% + var(--space-2))',
    right: 0,
    width: '340px',
    maxHeight: '440px',
    background: 'var(--bg-card)',
    border: '1px solid var(--border-default)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-lg)',
    zIndex: 50,
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  } as const,
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: 'var(--space-3) var(--space-4)',
    borderBottom: '1px solid var(--border-subtle)',
  } as const,
  headerTitle: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-body)',
    fontWeight: 600,
    color: 'var(--text-primary)',
  } as const,
  headerLink: {
    fontSize: 'var(--text-caption)',
    color: 'var(--text-accent)',
    textDecoration: 'none',
  } as const,
  list: {
    flex: 1,
    overflowY: 'auto',
    padding: 'var(--space-1)',
    display: 'flex',
    flexDirection: 'column',
  } as const,
  emptyState: {
    padding: 'var(--space-5) var(--space-4)',
    textAlign: 'center',
    color: 'var(--text-muted)',
    fontSize: 'var(--text-body-sm)',
  } as const,
  entry: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: 'var(--space-3)',
    padding: 'var(--space-3)',
    borderRadius: 'var(--radius-xs)',
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-primary)',
    textDecoration: 'none',
  } as const,
  entryUnread: {
    background: 'var(--glow-primary)',
  } as const,
  entryIcon: {
    width: '28px',
    height: '28px',
    borderRadius: 'var(--radius-xs)',
    background: 'var(--bg-surface)',
    color: 'var(--text-accent)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    flexShrink: 0,
  } as const,
  entryBody: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  } as const,
  entryTitle: {
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-primary)',
    fontWeight: 500,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  entryMeta: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    color: 'var(--text-muted)',
  } as const,
};

const ACTION_LABEL: Record<AuditLogEntry['action'], string> = {
  'rule.deploy': 'Rule deployed',
  'rule.delete': 'Rule deleted',
  'rule.toggle': 'Rule toggled',
  'rule.update': 'Rule updated',
};

const ACTION_ICON: Record<AuditLogEntry['action'], typeof Sparkles> = {
  'rule.deploy': Sparkles,
  'rule.delete': Trash2,
  'rule.toggle': ToggleRight,
  'rule.update': PencilLine,
};

export function NotificationsPopover() {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const { data } = useAuditLog({ limit: '10' });
  const entries = useMemo(() => data?.entries ?? [], [data]);

  const { preferences, patch } = usePreferences();
  const lastSeen = preferences?.notificationsLastSeen;

  const unreadCount = useMemo(() => {
    if (!lastSeen) return entries.length;
    return entries.filter((e) => e.ts > lastSeen).length;
  }, [entries, lastSeen]);

  // On popover open, mark notifications as seen.
  useEffect(() => {
    if (!open || entries.length === 0) return;
    const mostRecent = entries[0].ts;
    if (lastSeen === mostRecent) return;
    patch({ notificationsLastSeen: mostRecent }).catch(() => undefined);
  }, [open, entries, lastSeen, patch]);

  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => {
      if (!popoverRef.current || !triggerRef.current) return;
      if (
        popoverRef.current.contains(e.target as Node) ||
        triggerRef.current.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div style={styles.triggerWrap}>
      <button
        ref={triggerRef}
        type="button"
        style={{ ...styles.trigger, ...(open ? styles.triggerOpen : {}) }}
        aria-label={
          unreadCount > 0
            ? `Notifications — ${unreadCount} unread`
            : 'Notifications'
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <Icon as={Bell} size={16} />
        {unreadCount > 0 && (
          <span style={styles.badge} aria-hidden="true">
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          ref={popoverRef}
          role="dialog"
          aria-label="Notifications"
          style={styles.popover}
        >
          <div style={styles.header}>
            <span style={styles.headerTitle}>Activity</span>
            <Link
              to="/audit"
              style={styles.headerLink}
              onClick={() => setOpen(false)}
            >
              View all →
            </Link>
          </div>

          <div style={styles.list}>
            {entries.length === 0 ? (
              <div style={styles.emptyState}>
                No rule activity yet. Deploy your first rule from a Decision Moment to see it here.
              </div>
            ) : (
              entries.map((entry) => {
                const unread = !lastSeen || entry.ts > lastSeen;
                const IconComponent = ACTION_ICON[entry.action];
                return (
                  <Link
                    key={`${entry.ts}-${entry.ruleId}`}
                    to="/audit"
                    onClick={() => setOpen(false)}
                    style={{
                      ...styles.entry,
                      ...(unread ? styles.entryUnread : {}),
                    }}
                  >
                    <div style={styles.entryIcon}>
                      <Icon as={IconComponent} size={14} />
                    </div>
                    <div style={styles.entryBody}>
                      <span style={styles.entryTitle}>
                        {ACTION_LABEL[entry.action]}
                        {entry.ruleName ? `: ${entry.ruleName}` : ''}
                      </span>
                      <span style={styles.entryMeta}>
                        {formatTimeAgo(entry.ts)} · {entry.user}
                      </span>
                    </div>
                  </Link>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
