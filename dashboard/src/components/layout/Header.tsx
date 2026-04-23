/*
 * Header v2 — Design System v2.B chrome rebuild.
 *
 * Layout:
 *   [Page title + status dot]  …  [⌘K trigger]  [Notifications]  [Account]
 *
 * Page title resolves from the current route via routeTitles.ts.
 * Status dot moves the "Auto-refreshing" indicator into a compact pill.
 * Notifications + Account are STUBS in v2.B (clickable but no dropdown
 * yet) — full popovers ship in v2.C.
 *
 * Theme toggle is REMOVED from the header (was in v1) per R2.5 — moves
 * to the account menu dropdown in v2.C.
 */
import { useLocation } from 'react-router-dom';
import { Bell } from 'lucide-react';
import { Icon } from '../shared/Icon';
import { Tooltip } from '../shared/Tooltip';
import { CommandPaletteTrigger } from '../command/CommandPaletteTrigger';
import { ThemeToggle } from './ThemeToggle';
import { resolveRouteMeta } from './routeTitles';

const styles = {
  header: {
    height: 'var(--header-height)',
    padding: '0 var(--space-5)',
    borderBottom: '1px solid var(--border-subtle)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    background: 'var(--bg-base)',
    gap: 'var(--space-4)',
    flexShrink: 0,
  } as const,
  titleBlock: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
    minWidth: 0,
  } as const,
  titleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
  } as const,
  title: {
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-heading-sm)',
    fontWeight: 600,
    color: 'var(--text-primary)',
    letterSpacing: '-0.01em',
    margin: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  subtitle: {
    fontSize: 'var(--text-caption)',
    color: 'var(--text-muted)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  } as const,
  statusPill: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-1_5)',
    padding: '2px var(--space-2)',
    borderRadius: 'var(--radius-pill)',
    background: 'rgba(34, 197, 94, 0.12)',
    color: 'var(--eval-pass)',
    fontSize: 'var(--text-caption-xs)',
    fontFamily: 'var(--font-mono)',
    fontWeight: 600,
  } as const,
  statusDot: {
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: 'var(--eval-pass)',
  } as const,
  rightCluster: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
  } as const,
  iconButton: {
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
    transition: 'background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast)',
    position: 'relative',
  } as const,
  accountTrigger: {
    appearance: 'none',
    width: '32px',
    height: '32px',
    border: '1px solid var(--border-default)',
    background: 'var(--iris-950)',
    color: 'var(--iris-300)',
    borderRadius: '50%',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontFamily: 'var(--font-display)',
    fontSize: 'var(--text-caption)',
    fontWeight: 700,
    transition: 'background-color var(--transition-fast), border-color var(--transition-fast)',
  } as const,
};

export function Header() {
  const location = useLocation();
  const meta = resolveRouteMeta(location.pathname);

  return (
    <header style={styles.header}>
      <div style={styles.titleBlock}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>{meta?.title ?? 'Iris'}</h1>
          <Tooltip content="Auto-refreshing every 5 seconds. Pause via account menu (coming v0.4.1).">
            <span style={styles.statusPill} aria-label="Auto-refreshing" tabIndex={0}>
              <span style={styles.statusDot} aria-hidden="true" />
              live
            </span>
          </Tooltip>
        </div>
        {meta?.subtitle && <span style={styles.subtitle}>{meta.subtitle}</span>}
      </div>

      <div style={styles.rightCluster}>
        <CommandPaletteTrigger />

        {/* Theme toggle temporarily in header for v2.B; moves into Account
         * menu dropdown in v2.C per R2.5 spec. Don't remove until the
         * account menu ships — users would lose theme control. */}
        <ThemeToggle />

        <Tooltip content="Notifications (full popover ships v2.C)">
          <button
            type="button"
            style={styles.iconButton}
            aria-label="Notifications"
            disabled
            title="Coming in v2.C"
          >
            <Icon as={Bell} size={16} />
          </button>
        </Tooltip>

        <Tooltip content="Account menu (full dropdown ships v2.C)">
          <button
            type="button"
            style={styles.accountTrigger}
            aria-label="Account menu"
            disabled
            title="Coming in v2.C"
          >
            I
          </button>
        </Tooltip>
      </div>
    </header>
  );
}
