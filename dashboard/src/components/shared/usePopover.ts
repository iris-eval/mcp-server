/*
 * usePopover — focus and dismissal for a non-modal surface that a
 * trigger button opens (the header's account menu and notifications).
 *
 *   - On open, focus moves into the surface: to the first element matching
 *     `initialFocus`, or the surface itself when nothing matches. Without
 *     this a keyboard reader opens the menu and is still on the button,
 *     with the menu's contents one unannounced Tab away, or none.
 *   - Escape closes it and puts focus back on the trigger.
 *   - Focus leaving it (Tab past the end, Shift+Tab before the start, or
 *     a click elsewhere) closes it, and focus stays where it went.
 *
 * Non-modal on purpose: Tab is not trapped (useFocusTrap is for modal
 * dialogs). Escape and the outside click were handled separately by each
 * surface before; they now share this one implementation.
 */
import { useEffect, useRef, type RefObject } from 'react';

const FIRST_FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]';

export interface PopoverRefs<T extends HTMLElement, P extends HTMLElement> {
  triggerRef: RefObject<T | null>;
  popoverRef: RefObject<P | null>;
}

export function usePopover<T extends HTMLElement = HTMLButtonElement, P extends HTMLElement = HTMLDivElement>(
  open: boolean,
  /** The surface's useState setter (stable across renders). */
  setOpen: (open: boolean) => void,
  initialFocus: string = FIRST_FOCUSABLE,
): PopoverRefs<T, P> {
  const triggerRef = useRef<T | null>(null);
  const popoverRef = useRef<P | null>(null);

  useEffect(() => {
    if (!open) return;
    const popover = popoverRef.current;
    const first = popover?.querySelector<HTMLElement>(initialFocus);
    if (first) first.focus();
    else if (popover) {
      if (!popover.hasAttribute('tabindex')) popover.tabIndex = -1;
      popover.focus();
    }

    const inside = (node: EventTarget | null): boolean =>
      node instanceof Node && (!!popoverRef.current?.contains(node) || !!triggerRef.current?.contains(node));

    const onMouseDown = (e: MouseEvent) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onFocusIn = (e: FocusEvent) => {
      if (!inside(e.target)) setOpen(false);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('focusin', onFocusIn);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [open, setOpen, initialFocus]);

  return { triggerRef, popoverRef };
}
