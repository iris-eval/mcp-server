/*
 * MobileBanner — best-on-tablet+ notice when viewport < 768px (B8.6).
 *
 * Non-blocking; the dashboard stays usable. Dismissable via localStorage
 * so a user who briefly resizes their window doesn't keep seeing it.
 * Reappears on the next visit if the viewport is still narrow (acceptable
 * for the rare touch-first user; the goal is to set expectations, not to
 * lock anyone out).
 */
import { useEffect, useState } from 'react';
import { useMediaQuery } from '../../hooks/useMediaQuery';

const STORAGE_KEY = 'iris-mobile-banner-dismissed';

const styles = {
  banner: {
    position: 'fixed',
    bottom: 'var(--space-3)',
    left: 'var(--space-3)',
    right: 'var(--space-3)',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--accent-warning)',
    borderRadius: 'var(--border-radius)',
    padding: 'var(--space-3)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-primary)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 'var(--space-2)',
    zIndex: 80,
  } as const,
  dismiss: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: '2px var(--space-2)',
    cursor: 'pointer',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'inherit',
  } as const,
};

export function MobileBanner() {
  const isNarrow = useMediaQuery('(max-width: 767px)');
  const [dismissedThisSession, setDismissedThisSession] = useState<boolean>(true);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      setDismissedThisSession(window.sessionStorage.getItem(STORAGE_KEY) === '1');
    } catch {
      setDismissedThisSession(false);
    }
  }, []);

  if (!isNarrow || dismissedThisSession) return null;

  const onDismiss = () => {
    setDismissedThisSession(true);
    try {
      window.sessionStorage.setItem(STORAGE_KEY, '1');
    } catch {
      // ignore
    }
  };

  return (
    <div style={styles.banner} role="status" aria-live="polite">
      <span>
        Iris is best on tablet or desktop (≥768px wide). The dashboard works at this size
        but some surfaces may clip.
      </span>
      <button type="button" style={styles.dismiss} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
