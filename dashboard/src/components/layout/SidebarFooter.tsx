/*
 * SidebarFooter — anchored to the bottom of the sidebar.
 *
 * Contains:
 *   - Settings link (placeholder for future /settings page)
 *   - Shortcuts trigger (opens KeyboardShortcutsOverlay)
 *   - Version + env strip
 *   - Collapse toggle
 *
 * Theme + density toggles live in the account menu (per R2.5), not here.
 * Version + env give ops engineers the at-a-glance status they expect
 * from enterprise dashboards.
 */
import { Settings, HelpCircle, ChevronsLeft, ChevronsRight } from 'lucide-react';
import { Icon } from '../shared/Icon';
import { Tooltip } from '../shared/Tooltip';

const VERSION = '0.4.0';

const styles = {
  footer: {
    marginTop: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
    padding: 'var(--space-3) 0',
    borderTop: '1px solid var(--border-subtle)',
  } as const,
  iconButton: {
    appearance: 'none',
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-3)',
    padding: 'var(--space-2) var(--space-3)',
    margin: '0 var(--space-2)',
    background: 'transparent',
    border: 'none',
    borderRadius: 'var(--radius-sm)',
    color: 'var(--text-secondary)',
    fontSize: 'var(--text-body)',
    fontFamily: 'var(--font-body)',
    fontWeight: 500,
    textAlign: 'left',
    cursor: 'pointer',
    transition: 'background-color var(--transition-fast), color var(--transition-fast)',
    minHeight: '32px',
  } as const,
  iconButtonCollapsed: {
    justifyContent: 'center',
    padding: 'var(--space-2) 0',
  } as const,
  label: {
    flex: 1,
  } as const,
  versionStrip: {
    margin: 'var(--space-2) var(--space-5)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--text-caption-xs)',
    color: 'var(--text-muted)',
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  } as const,
  versionStripCollapsed: {
    display: 'none',
  } as const,
  envDot: {
    display: 'inline-block',
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: 'var(--iris-500)',
    marginRight: 'var(--space-2)',
  } as const,
};

export interface SidebarFooterProps {
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenShortcuts: () => void;
  onOpenSettings?: () => void;
  /** Hostname or environment marker, e.g. "localhost:6920". */
  env?: string;
}

export function SidebarFooter({
  collapsed,
  onToggleCollapse,
  onOpenShortcuts,
  onOpenSettings,
  env,
}: SidebarFooterProps) {
  return (
    <div style={styles.footer}>
      {onOpenSettings && (
        <Tooltip content="Settings (coming v0.5)" placement="top" disabled={!collapsed}>
          <button
            type="button"
            onClick={onOpenSettings}
            style={{ ...styles.iconButton, ...(collapsed ? styles.iconButtonCollapsed : {}) }}
            aria-label="Settings"
          >
            <Icon as={Settings} size={20} />
            {!collapsed && <span style={styles.label}>Settings</span>}
          </button>
        </Tooltip>
      )}

      <Tooltip content="Keyboard shortcuts (?)" placement="top" disabled={!collapsed}>
        <button
          type="button"
          onClick={onOpenShortcuts}
          style={{ ...styles.iconButton, ...(collapsed ? styles.iconButtonCollapsed : {}) }}
          aria-label="Keyboard shortcuts"
        >
          <Icon as={HelpCircle} size={20} />
          {!collapsed && <span style={styles.label}>Shortcuts</span>}
        </button>
      </Tooltip>

      {!collapsed && (
        <div style={styles.versionStrip}>
          <span>
            <span style={styles.envDot} />
            {env ?? 'localhost'}
          </span>
          <span>v{VERSION}</span>
        </div>
      )}

      <Tooltip
        content={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        placement="top"
        disabled={false}
      >
        <button
          type="button"
          onClick={onToggleCollapse}
          style={{ ...styles.iconButton, ...(collapsed ? styles.iconButtonCollapsed : {}) }}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <Icon as={collapsed ? ChevronsRight : ChevronsLeft} size={20} />
          {!collapsed && <span style={styles.label}>Collapse</span>}
        </button>
      </Tooltip>
    </div>
  );
}
