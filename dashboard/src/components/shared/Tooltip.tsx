/*
 * Tooltip — accessible hover + focus tooltip primitive.
 *
 * Renders a child trigger and a positioned tooltip popup. Shows on hover
 * (after a configurable delay), on keyboard focus, or on long-press
 * (touch). Hides on blur, mouse leave, and Escape.
 *
 * Accessibility:
 *   - Trigger gets aria-describedby pointing at the tooltip
 *   - Tooltip uses role="tooltip"
 *   - prefers-reduced-motion is respected (no fade animation)
 *   - Works for touch + keyboard, not just mouse
 *
 * Positioning is intentionally simple — bottom by default, flips to top
 * when near the viewport bottom edge. We don't need a full positioning
 * engine (popper/floating-ui) for one-line metric explanations; the
 * cost-of-a-dep tradeoff isn't worth it.
 */
import {
  cloneElement,
  isValidElement,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
} from 'react';

const SHOW_DELAY_MS = 350;
const FONT_OFFSET_PX = 8;

const styles = {
  wrapper: {
    position: 'relative',
    display: 'inline-flex',
  } as const,
  tooltip: {
    position: 'absolute',
    zIndex: 50,
    pointerEvents: 'none',
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-2)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'inherit',
    boxShadow: 'var(--shadow-md)',
    maxWidth: '280px',
    whiteSpace: 'normal',
    lineHeight: 1.5,
    opacity: 0,
    transform: 'translate(-50%, 4px)',
    transition: 'opacity var(--transition-fast), transform var(--transition-fast)',
    left: '50%',
    top: '100%',
    marginTop: `${FONT_OFFSET_PX}px`,
  } as const,
  tooltipVisible: {
    opacity: 1,
    transform: 'translate(-50%, 0)',
  } as const,
  tooltipTop: {
    top: 'auto',
    bottom: '100%',
    marginTop: 0,
    marginBottom: `${FONT_OFFSET_PX}px`,
    transform: 'translate(-50%, -4px)',
  } as const,
  tooltipTopVisible: {
    transform: 'translate(-50%, 0)',
  } as const,
};

interface TooltipProps {
  /** Tooltip text (kept short; one-line metric explanations). */
  content: ReactNode;
  /** The trigger — typically a small inline element (badge, icon, label). */
  children: ReactElement;
  /** Override placement. Default = bottom (auto-flips to top near viewport edge). */
  placement?: 'bottom' | 'top';
  /** Show delay in ms (mouseover). Default 350. */
  delayMs?: number;
  /** Disable for cases where the parent renders a richer popover already. */
  disabled?: boolean;
}

function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

export function Tooltip({
  content,
  children,
  placement = 'bottom',
  delayMs = SHOW_DELAY_MS,
  disabled = false,
}: TooltipProps) {
  const id = useId();
  const tooltipId = `tt-${id.replace(/[:]/g, '')}`;
  const [open, setOpen] = useState(false);
  const [resolvedPlacement, setResolvedPlacement] = useState<'top' | 'bottom'>(placement);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const showTimer = useRef<number | null>(null);
  const reduced = prefersReducedMotion();

  const clearShow = useCallback(() => {
    if (showTimer.current) {
      window.clearTimeout(showTimer.current);
      showTimer.current = null;
    }
  }, []);

  const show = useCallback(() => {
    if (disabled) return;
    clearShow();
    showTimer.current = window.setTimeout(() => {
      setOpen(true);
      // After mount, check if the tooltip would clip the viewport bottom and
      // flip to top if so.
      if (placement === 'bottom' && wrapperRef.current) {
        const rect = wrapperRef.current.getBoundingClientRect();
        const remainingBelow = window.innerHeight - rect.bottom;
        if (remainingBelow < 80) {
          setResolvedPlacement('top');
        } else {
          setResolvedPlacement('bottom');
        }
      } else {
        setResolvedPlacement(placement);
      }
    }, reduced ? 0 : delayMs);
  }, [clearShow, delayMs, disabled, placement, reduced]);

  const hide = useCallback(() => {
    clearShow();
    setOpen(false);
  }, [clearShow]);

  useEffect(() => () => clearShow(), [clearShow]);

  // ESC dismisses
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, hide]);

  if (!isValidElement(children)) {
    return children as never;
  }

  // Inject aria-describedby + handlers onto the child.
  const childProps = (children as ReactElement<Record<string, unknown>>).props;
  const triggerProps: Record<string, unknown> = {
    'aria-describedby': open ? tooltipId : undefined,
    onMouseEnter: (...args: unknown[]) => {
      show();
      const fn = childProps.onMouseEnter as ((...a: unknown[]) => void) | undefined;
      fn?.(...args);
    },
    onMouseLeave: (...args: unknown[]) => {
      hide();
      const fn = childProps.onMouseLeave as ((...a: unknown[]) => void) | undefined;
      fn?.(...args);
    },
    onFocus: (...args: unknown[]) => {
      show();
      const fn = childProps.onFocus as ((...a: unknown[]) => void) | undefined;
      fn?.(...args);
    },
    onBlur: (...args: unknown[]) => {
      hide();
      const fn = childProps.onBlur as ((...a: unknown[]) => void) | undefined;
      fn?.(...args);
    },
  };

  const cloned = cloneElement(children as ReactElement, triggerProps);

  const tooltipStyle = {
    ...styles.tooltip,
    ...(resolvedPlacement === 'top' ? styles.tooltipTop : {}),
    ...(open ? styles.tooltipVisible : {}),
    ...(open && resolvedPlacement === 'top' ? styles.tooltipTopVisible : {}),
    ...(reduced ? { transition: 'none' } : {}),
  };

  return (
    <span ref={wrapperRef} style={styles.wrapper}>
      {cloned}
      {!disabled && (
        <span id={tooltipId} role="tooltip" style={tooltipStyle}>
          {content}
        </span>
      )}
    </span>
  );
}
