/*
 * ThemeToggle — visible UI for issue #10.
 *
 * Single button in the header that flips between dark and light.
 * Persistence + system-preference detection live in ThemeProvider.
 */
import { useTheme } from './ThemeProvider';

const styles = {
  button: {
    appearance: 'none',
    border: '1px solid var(--border-color)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
    cursor: 'pointer',
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    transition: 'background var(--transition-fast), color var(--transition-fast)',
  } as const,
  icon: {
    display: 'inline-block',
    width: '12px',
    height: '12px',
    lineHeight: 1,
  } as const,
};

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const nextLabel = theme === 'dark' ? 'light' : 'dark';
  return (
    <button
      type="button"
      onClick={toggleTheme}
      style={styles.button}
      aria-label={`Switch to ${nextLabel} theme`}
      title={`Switch to ${nextLabel} theme`}
    >
      <span style={styles.icon} aria-hidden="true">
        {theme === 'dark' ? '☾' : '☀'}
      </span>
      <span>{theme}</span>
    </button>
  );
}
