/*
 * RateLimitBanner — informs the user the dashboard is being rate-limited
 * and auto-resumes at a known timestamp.
 *
 * This is the visible side of audit item #12. When a page's useApiData
 * hook surfaces rateLimitedUntil, the page wraps this banner above its
 * primary content. The banner:
 *   - counts down to the reset time with a live tick
 *   - tells the user polling is paused and will auto-resume
 *   - gives them a manual retry button in case they want to try sooner
 *
 * Intentionally no icon-motion — reduced-motion preference still
 * respected, just a static alert role.
 */
import { useEffect, useState } from 'react';

export interface RateLimitBannerProps {
  /** Epoch-ms when the rate limit is expected to reset. */
  until: number;
  /** Manual retry handler — calls refetch() from the parent hook. */
  onRetry?: () => void;
}

const styles = {
  wrap: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 'var(--space-3)',
    padding: 'var(--space-3) var(--space-4)',
    background: 'var(--bg-card)',
    border: '1px solid var(--eval-warn)',
    borderRadius: 'var(--radius)',
    fontSize: 'var(--text-body-sm)',
    color: 'var(--text-primary)',
  } as const,
  text: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  } as const,
  heading: {
    fontWeight: 600,
    color: 'var(--eval-warn)',
  } as const,
  countdown: {
    fontSize: 'var(--text-caption)',
    color: 'var(--text-secondary)',
    fontFamily: 'var(--font-mono)',
  } as const,
  retry: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--border-default)',
    color: 'var(--text-primary)',
    borderRadius: 'var(--radius-sm)',
    padding: 'var(--space-1_5) var(--space-3)',
    fontSize: 'var(--text-caption)',
    fontFamily: 'inherit',
    cursor: 'pointer',
  } as const,
};

function formatRemaining(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

export function RateLimitBanner({ until, onRetry }: RateLimitBannerProps) {
  const [remaining, setRemaining] = useState(() => until - Date.now());

  useEffect(() => {
    // Tick every second. Cleared when `until` changes or the banner
    // unmounts after a successful refetch clears the rate limit.
    const id = window.setInterval(() => {
      const next = until - Date.now();
      setRemaining(next);
      if (next <= 0) window.clearInterval(id);
    }, 1000);
    return () => window.clearInterval(id);
  }, [until]);

  return (
    <div role="alert" aria-live="polite" style={styles.wrap}>
      <div style={styles.text}>
        <span style={styles.heading}>Dashboard rate-limited</span>
        <span style={styles.countdown}>
          {remaining > 0
            ? `Auto-resuming in ${formatRemaining(remaining)} · polling paused to respect the server's rate limit.`
            : 'Resuming…'}
        </span>
      </div>
      {onRetry && (
        <button type="button" style={styles.retry} onClick={onRetry}>
          Retry now
        </button>
      )}
    </div>
  );
}
