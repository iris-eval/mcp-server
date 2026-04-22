/*
 * WelcomeBanner — first-visit dashboard banner (B7).
 *
 * Pairs with the server-side first-run auto-launch (iris/src/preferences.ts).
 * Stored in localStorage so it persists across browser sessions on the
 * same machine. Independent of the server-side ~/.iris/preferences.json.
 *
 * The banner explains:
 *   - what the user is looking at (Decision Moment Timeline is new)
 *   - how to disable auto-launch on subsequent runs
 *   - where to go next
 */
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';

const STORAGE_KEY = 'iris-welcome-banner-dismissed';

const styles = {
  banner: {
    background: 'oklch(28% 0.05 195 / 0.30)',
    borderBottom: '1px solid var(--accent-primary)',
    padding: 'var(--space-3) var(--space-4)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-3)',
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-primary)',
  } as const,
  message: {
    display: 'flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    flexWrap: 'wrap',
  } as const,
  badge: {
    fontSize: 'var(--font-size-xs)',
    fontWeight: 700,
    fontFamily: 'var(--font-mono)',
    background: 'var(--accent-primary)',
    color: 'var(--bg-primary)',
    padding: '2px var(--space-2)',
    borderRadius: 'var(--border-radius-sm)',
    letterSpacing: '0.05em',
  } as const,
  link: {
    color: 'var(--accent-primary)',
    textDecoration: 'underline',
  } as const,
  hint: {
    color: 'var(--text-muted)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'var(--font-mono)',
  } as const,
  dismiss: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'inherit',
  } as const,
};

function readDismissed(): boolean {
  if (typeof window === 'undefined') return false;
  try {
    return window.localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function WelcomeBanner() {
  const [dismissed, setDismissed] = useState<boolean>(true);

  // Read on mount only — avoids SSR hydration mismatch (we always render
  // dismissed=true on first render and then update in effect).
  useEffect(() => {
    setDismissed(readDismissed());
  }, []);

  const onDismiss = () => {
    setDismissed(true);
    try {
      window.localStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // Storage may be unavailable (private mode); banner won't persist
      // dismissal but at least disappears for this tab.
    }
  };

  if (dismissed) return null;

  return (
    <div style={styles.banner} role="region" aria-label="Welcome">
      <div style={styles.message}>
        <span style={styles.badge}>NEW</span>
        <span>
          Welcome to Iris. Start with{' '}
          <Link to="/moments" style={styles.link}>Decision Moments</Link> — every trace
          classified by what makes it noteworthy.
        </span>
        <span style={styles.hint}>
          (To disable auto-launch on future runs: set <code>IRIS_NO_AUTO_LAUNCH=1</code>{' '}
          or edit <code>~/.iris/preferences.json</code>)
        </span>
      </div>
      <button
        type="button"
        onClick={onDismiss}
        style={styles.dismiss}
        aria-label="Dismiss welcome banner"
      >
        Dismiss
      </button>
    </div>
  );
}
