import { ThemeToggle } from './ThemeToggle';

const styles = {
  header: {
    padding: 'var(--space-3) var(--space-6)',
    borderBottom: '1px solid var(--border-color)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    background: 'var(--bg-secondary)',
    gap: 'var(--space-4)',
  } as const,
  indicator: {
    display: 'inline-flex',
    alignItems: 'center',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
  } as const,
  dot: {
    display: 'inline-block',
    width: '6px',
    height: '6px',
    borderRadius: '50%',
    background: 'var(--accent-success)',
    marginRight: 'var(--space-2)',
  } as const,
  spacer: {
    flex: 1,
  } as const,
};

export function Header() {
  return (
    <header style={styles.header}>
      <div style={styles.indicator}>
        <span style={styles.dot} />
        Auto-refreshing
      </div>
      <div style={styles.spacer} />
      <ThemeToggle />
    </header>
  );
}
