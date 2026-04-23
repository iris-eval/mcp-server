/*
 * CommandPaletteTrigger — header button that opens the command palette.
 *
 * Renders a Linear/Vercel-style search affordance with the ⌘K keybinding
 * displayed inline so first-time users discover it without needing to
 * read documentation.
 */
import { useCommandPalette } from './CommandPaletteProvider';

const styles = {
  trigger: {
    appearance: 'none',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-2)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'inherit',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    transition: 'background var(--transition-fast), color var(--transition-fast)',
  } as const,
  prompt: {
    fontFamily: 'var(--font-mono)',
    color: 'var(--text-muted)',
  } as const,
  label: {
    color: 'var(--text-secondary)',
  } as const,
  shortcut: {
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    padding: '1px 6px',
    color: 'var(--text-muted)',
    fontSize: '10px',
  } as const,
};

function detectShortcut(): string {
  if (typeof navigator === 'undefined') return '⌘K';
  const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
  return isMac ? '⌘K' : 'Ctrl K';
}

export function CommandPaletteTrigger() {
  const { open } = useCommandPalette();
  return (
    <button
      type="button"
      onClick={open}
      style={styles.trigger}
      aria-label="Open command palette"
      title="Open command palette"
    >
      <span style={styles.prompt}>›</span>
      <span style={styles.label}>Search or jump to…</span>
      <span style={styles.shortcut}>{detectShortcut()}</span>
    </button>
  );
}
