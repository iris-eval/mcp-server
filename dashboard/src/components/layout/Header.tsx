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
import { useLocation } from 'react-router';
import { useHealth, useCapabilities } from '../../api/hooks';
import { useConnection } from '../../api/connection';
import { useDocumentVisible } from '../../hooks/useDocumentVisible';
import { shellStatus } from './shellStatus';
import { StatusPill, JudgeChip, DemoChip } from './StatusChips';
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
  rightCluster: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
  } as const,
};

export function Header() {
  const location = useLocation();
  const meta = resolveRouteMeta(location.pathname);

  /*
   * The header reads the server, not a constant (D-2). One health poll and
   * the client's own record of its last answer decide the pill; the judge
   * chip and the DEMO chip come from the same answers; capabilities is read
   * once for the judge's enable steps and the retention window.
   */
  const health = useHealth();
  const capabilities = useCapabilities();
  const connection = useConnection();
  const visible = useDocumentVisible();
  const status = shellStatus({
    connection: connection.state,
    visible,
    rateLimitedUntil: health.rateLimitedUntil,
    health: health.data,
    error: health.error,
  });

  return (
    <header style={styles.header}>
      <div style={styles.titleBlock}>
        <div style={styles.titleRow}>
          <h1 style={styles.title}>{meta?.title ?? 'Iris'}</h1>
          <StatusPill status={status} />
          <JudgeChip health={health.data} capabilities={capabilities.data} />
          {health.data?.mode === 'demo' && <DemoChip />}
        </div>
        {meta?.subtitle && <span style={styles.subtitle}>{meta.subtitle}</span>}
      </div>

      <div style={styles.rightCluster}>
        <CommandPaletteTrigger />
        <NotificationsPopover />
        <AccountMenu serverVersion={health.data?.version ?? null} retention={capabilities.data?.retention ?? null} />
      </div>
    </header>
  );
}
