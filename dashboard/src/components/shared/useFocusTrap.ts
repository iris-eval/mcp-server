/*
 * useFocusTrap — keyboard accessibility primitive for modal dialogs.
 *
 * Two responsibilities:
 *   1. Trap Tab cycles inside the container so keyboard users can't
 *      accidentally land on background page content while a modal is open.
 *   2. Restore focus to the element that opened the modal when the
 *      modal closes — so screen-reader/keyboard users land back where
 *      they were instead of at <body>.
 *
 * Usage:
 *   const containerRef = useFocusTrap(isOpen);
 *   if (!isOpen) return null;
 *   return <div ref={containerRef} role="dialog" aria-modal="true">...</div>;
 *
 * Notes:
 *   - The hook auto-focuses the first focusable element in the container
 *     on activation. If no focusable element exists, focus is unchanged.
 *   - Tab from the LAST element wraps to the FIRST. Shift+Tab from the
 *     FIRST wraps to the LAST.
 *   - Restoration uses the focused element at the moment of activation.
 *     If the opener was removed from the DOM by the time the modal closes,
 *     the .focus() call is a no-op (graceful degradation).
 *   - Esc-handling is left to the calling component — every modal has its
 *     own dismissal semantics (cancel-vs-confirm, confirmation prompt, etc.)
 *     so coupling that into the trap would over-reach.
 */
import { useEffect, useRef, type RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      !el.hasAttribute('hidden') &&
      el.getAttribute('aria-hidden') !== 'true',
  );
}

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>(
  active: boolean,
): RefObject<T | null> {
  const containerRef = useRef<T | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!active) return;

    // Snapshot the element that had focus when the trap activated, so we
    // can restore on close. Falls back to null gracefully if document
    // doesn't have an active element (jsdom edge case).
    restoreFocusRef.current = (document.activeElement as HTMLElement) ?? null;

    const container = containerRef.current;
    if (container) {
      const focusables = getFocusable(container);
      const first = focusables[0];
      if (first) {
        first.focus();
      }
    }

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      if (!container) return;
      const focusables = getFocusable(container);
      if (focusables.length === 0) return;

      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;

      if (e.shiftKey) {
        // Shift+Tab on first element wraps to last
        if (active === first || !container.contains(active)) {
          e.preventDefault();
          last.focus();
        }
      } else {
        // Tab on last element wraps to first
        if (active === last || !container.contains(active)) {
          e.preventDefault();
          first.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
      // Restore focus to the original opener. Wrapped in try/catch because
      // the element may have been removed from the DOM (e.g. the moment
      // detail page that opened the modal navigated away).
      try {
        restoreFocusRef.current?.focus?.();
      } catch {
        // Graceful degradation — focus restoration is best-effort.
      }
    };
  }, [active]);

  return containerRef;
}
