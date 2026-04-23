/*
 * KeyboardShortcutsOverlay — modal listing every keyboard shortcut.
 *
 * Opened by typing "?" anywhere in the dashboard (handled by the
 * CommandPaletteProvider global listener), or via the
 * "Keyboard shortcuts" command in the palette. Closes via ESC or backdrop
 * click.
 *
 * Shortcut data lives next to the command registry so adding a new
 * command with a `shortcut` field automatically surfaces it here.
 */
import { useEffect } from 'react';
import { buildCommands, type Command } from './commands';

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'oklch(0% 0 0 / 0.55)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 120,
    padding: 'var(--space-4)',
  } as const,
  panel: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-lg)',
    width: 'min(560px, 100%)',
    maxHeight: '85vh',
    overflow: 'auto',
    boxShadow: 'var(--shadow-lg)',
  } as const,
  header: {
    padding: 'var(--space-4) var(--space-5)',
    borderBottom: '1px solid var(--border-color)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  } as const,
  title: {
    margin: 0,
    fontSize: 'var(--font-size-lg)',
    fontWeight: 700,
  } as const,
  close: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-2)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
  } as const,
  body: {
    padding: 'var(--space-4) var(--space-5)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  group: {
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-1)',
  } as const,
  groupTitle: {
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    textTransform: 'uppercase',
    letterSpacing: '0.05em',
    color: 'var(--text-muted)',
    paddingBottom: 'var(--space-1)',
    borderBottom: '1px solid var(--border-color)',
  } as const,
  row: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    padding: 'var(--space-1) 0',
    fontSize: 'var(--font-size-sm)',
  } as const,
  rowTitle: {
    color: 'var(--text-primary)',
  } as const,
  shortcut: {
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    padding: '2px var(--space-2)',
    color: 'var(--text-muted)',
  } as const,
  hint: {
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    paddingTop: 'var(--space-2)',
    borderTop: '1px solid var(--border-color)',
  } as const,
};

interface Props {
  open: boolean;
  onClose: () => void;
}

const GLOBAL_SHORTCUTS: Array<{ keys: string; description: string }> = [
  { keys: '⌘ K / Ctrl K', description: 'Open command palette' },
  { keys: '?', description: 'Open this shortcuts help' },
  { keys: 'Esc', description: 'Close any open dialog' },
];

export function KeyboardShortcutsOverlay({ open, onClose }: Props) {
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, onClose]);

  if (!open) return null;

  // We don't actually need run/setTheme/etc to LIST the shortcuts —
  // pass no-ops; the registry only needs the metadata.
  const noop = () => undefined;
  const cmds: Command[] = buildCommands({
    navigate: noop as never,
    setTheme: noop as never,
    toggleTheme: noop as never,
    openShortcuts: noop,
  });

  const withShortcuts = cmds.filter((c) => c.shortcut);
  const grouped = new Map<string, Command[]>();
  for (const c of withShortcuts) {
    const arr = grouped.get(c.section) ?? [];
    arr.push(c);
    grouped.set(c.section, arr);
  }

  return (
    <div
      style={styles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
    >
      <div style={styles.panel}>
        <div style={styles.header}>
          <h2 style={styles.title}>Keyboard shortcuts</h2>
          <button type="button" onClick={onClose} style={styles.close}>
            esc
          </button>
        </div>
        <div style={styles.body}>
          <div style={styles.group}>
            <div style={styles.groupTitle}>Global</div>
            {GLOBAL_SHORTCUTS.map((g) => (
              <div key={g.keys} style={styles.row}>
                <span style={styles.rowTitle}>{g.description}</span>
                <span style={styles.shortcut}>{g.keys}</span>
              </div>
            ))}
          </div>
          {[...grouped.entries()].map(([section, items]) => (
            <div key={section} style={styles.group}>
              <div style={styles.groupTitle}>{section}</div>
              {items.map((c) => (
                <div key={c.id} style={styles.row}>
                  <span style={styles.rowTitle}>{c.title}</span>
                  <span style={styles.shortcut}>{c.shortcut}</span>
                </div>
              ))}
            </div>
          ))}
          <p style={styles.hint}>
            Press <code>⌘K</code> (or <code>Ctrl+K</code> on Windows / Linux) anywhere to open the
            command palette. Type <code>g</code> followed by a letter to jump (g d → Dashboard, g m →
            Decision Moments, etc.).
          </p>
        </div>
      </div>
    </div>
  );
}
