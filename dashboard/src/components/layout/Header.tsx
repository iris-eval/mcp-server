/*
 * Header v2 — Design System v2.B chrome rebuild.
 *
 * Layout:
 *   [Page title + status dot]  …  [⌘K trigger]  [Notifications]  [Account]
 *
 * Page title resolves from the current route via routeTitles.ts.
 * Status dot moves the "Auto-refreshing" indicator into a compact pill.
 *
 * v2.C (2026-04-23): Notifications + Account are now real popovers.
 * Theme toggle moved from header into AccountMenu per R2.5 spec.
 */
import { useLocation } from 'react-router-dom';
import { Tooltip } from '../shared/Tooltip';
import { CommandPaletteTrigger } from '../command/CommandPaletteTrigger';
import { NotificationsPopover } from './NotificationsPopover';
import { AccountMenu } from './AccountMenu';
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
};

export function Header() {
  const location = useLocation();
  const meta = resolveRouteMeta(location.pathname);

  return (
    <header style={styles.header}>
      <div style={styles.titleBlock}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>{meta?.title ?? 'Iris'}</h1>
          <Tooltip content="Auto-refreshing. Cadence varies per view (live tail ~3s, trends ~30s).">
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
        <NotificationsPopover />
        <AccountMenu />
      </div>
    </header>
  );
}
