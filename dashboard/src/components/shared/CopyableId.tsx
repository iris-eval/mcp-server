/*
 * CopyableId — issue #11 (trace-ID copy-to-clipboard).
 *
 * Renders an ID in monospace with a copy button that uses the Clipboard API.
 * Provides visible affordance + ephemeral "Copied" state.
 */
import { useCallback, useEffect, useState } from 'react';
import type React from 'react';

const styles = {
  wrapper: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'var(--space-2)',
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-sm)',
  } as const,
  id: {
    color: 'var(--text-secondary)',
    userSelect: 'all',
  } as const,
  button: {
    appearance: 'none',
    border: '1px solid var(--border-color)',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: '2px var(--space-2)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'inherit',
    cursor: 'pointer',
    transition: 'background var(--transition-fast), color var(--transition-fast)',
  } as const,
  buttonCopied: {
    background: 'var(--accent-success)',
    color: 'var(--bg-primary)',
    borderColor: 'var(--accent-success)',
  } as const,
};

export interface CopyableIdProps {
  /** The full ID string. Always shown as the canonical value to copy. */
  value: string;
  /** Optional shorter display variant (e.g., last 8 chars). Defaults to value. */
  displayValue?: string;
  /** Optional aria label override. Defaults to "Copy ID". */
  ariaLabel?: string;
}

export function CopyableId({ value, displayValue, ariaLabel = 'Copy ID' }: CopyableIdProps) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const onCopy = useCallback(
    async (event: React.MouseEvent<HTMLButtonElement>) => {
      // Stop propagation so this can be embedded inside row-click surfaces (TraceTable)
      // without triggering the parent's onRowClick navigation.
      event.stopPropagation();
      if (typeof navigator === 'undefined' || !navigator.clipboard) {
        // Fallback: select + execCommand for very old browsers / sandboxed iframes.
        // Modern Iris targets evergreen browsers; this branch is defensive.
        return;
      }
      try {
        await navigator.clipboard.writeText(value);
        setCopied(true);
      } catch {
        // Clipboard API can reject in non-secure contexts (http) or denied permissions.
        // Surface nothing; the user sees no "Copied" confirmation and can manually select.
      }
    },
    [value],
  );

  return (
    <span style={styles.wrapper}>
      <span style={styles.id}>{displayValue ?? value}</span>
      <button
        type="button"
        onClick={onCopy}
        style={{ ...styles.button, ...(copied ? styles.buttonCopied : {}) }}
        aria-label={ariaLabel}
        title={ariaLabel}
      >
        {copied ? '✓ copied' : 'copy'}
      </button>
    </span>
  );
}
