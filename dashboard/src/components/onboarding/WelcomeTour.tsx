/*
 * WelcomeTour — first-visit guided introduction (B8.3).
 *
 * 5-step modal sequence (not a DOM-spotlight tour) introducing the
 * dashboard's core concepts. Robust against route changes — each step
 * stands alone; no fragile selector targeting.
 *
 * Trigger:
 *   - Auto-opens on first visit when `tour-welcome` is NOT in
 *     preferences.dismissedTours.
 *   - Re-openable via the "Onboarding tour" command in the palette.
 *
 * Dismissal:
 *   - "Skip" button: writes 'tour-welcome' to dismissedTours; tour
 *     never auto-opens again on this machine.
 *   - "Finish" button (after step 5): same as Skip but with a celebratory
 *     final state.
 *   - ESC: same as Skip.
 *
 * Persistence: preferences.dismissedTours is server-mediated, so dismissal
 * survives across browser reloads AND iris-mcp restarts.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { usePreferences } from '../../hooks/usePreferences';
import { useCommandPalette } from '../command/CommandPaletteProvider';
import { useFocusTrap } from '../shared/useFocusTrap';

const TOUR_ID = 'tour-welcome';

interface TourStep {
  title: string;
  body: ReactNode;
  /** Optional CTA shown above the navigation buttons. */
  cta?: { label: string; href?: string; action?: () => void };
}

const styles = {
  backdrop: {
    position: 'fixed',
    inset: 0,
    background: 'oklch(0% 0 0 / 0.65)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 130,
    padding: 'var(--space-4)',
  } as const,
  panel: {
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-lg)',
    width: 'min(560px, 100%)',
    maxHeight: '85vh',
    boxShadow: 'var(--shadow-lg)',
    display: 'flex',
    flexDirection: 'column',
    overflow: 'hidden',
  } as const,
  progressTrack: {
    height: '3px',
    background: 'var(--bg-tertiary)',
    overflow: 'hidden',
  } as const,
  progressFill: {
    height: '100%',
    background: 'var(--accent-primary)',
    transition: 'width var(--transition-base)',
  } as const,
  header: {
    padding: 'var(--space-4) var(--space-5)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 'var(--space-3)',
  } as const,
  stepLabel: {
    fontFamily: 'var(--font-mono)',
    fontSize: 'var(--font-size-xs)',
    color: 'var(--text-muted)',
    letterSpacing: '0.05em',
  } as const,
  skip: {
    appearance: 'none',
    background: 'transparent',
    border: 'none',
    color: 'var(--text-muted)',
    fontSize: 'var(--font-size-xs)',
    fontFamily: 'inherit',
    cursor: 'pointer',
    textDecoration: 'underline',
  } as const,
  body: {
    padding: '0 var(--space-5) var(--space-4)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'var(--space-3)',
  } as const,
  title: {
    margin: 0,
    fontSize: 'var(--font-size-xl)',
    fontWeight: 700,
    color: 'var(--text-primary)',
  } as const,
  text: {
    fontSize: 'var(--font-size-sm)',
    color: 'var(--text-secondary)',
    lineHeight: 1.6,
    margin: 0,
  } as const,
  ctaRow: {
    display: 'flex',
    gap: 'var(--space-2)',
    flexWrap: 'wrap',
  } as const,
  ctaBtn: {
    appearance: 'none',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border-color)',
    color: 'var(--text-primary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-1) var(--space-3)',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
    cursor: 'pointer',
    textDecoration: 'none',
    display: 'inline-flex',
    alignItems: 'center',
  } as const,
  footer: {
    padding: 'var(--space-3) var(--space-5)',
    borderTop: '1px solid var(--border-color)',
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: 'var(--space-2)',
    background: 'var(--bg-tertiary)',
  } as const,
  navBtn: {
    appearance: 'none',
    background: 'transparent',
    border: '1px solid var(--border-color)',
    color: 'var(--text-secondary)',
    borderRadius: 'var(--border-radius-sm)',
    padding: 'var(--space-2) var(--space-4)',
    fontSize: 'var(--font-size-sm)',
    fontFamily: 'inherit',
    cursor: 'pointer',
  } as const,
  navBtnPrimary: {
    background: 'var(--accent-primary)',
    color: 'var(--bg-primary)',
    borderColor: 'var(--accent-primary)',
    fontWeight: 600,
  } as const,
  navBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  } as const,
  shortcut: {
    fontFamily: 'var(--font-mono)',
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-color)',
    borderRadius: 'var(--border-radius-sm)',
    padding: '1px 6px',
    color: 'var(--text-muted)',
    fontSize: '11px',
  } as const,
};

export function WelcomeTour({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const { open: openPalette } = useCommandPalette();
  const [stepIndex, setStepIndex] = useState(0);
  const { patch } = usePreferences();

  const steps: TourStep[] = useMemo(
    () => [
      {
        title: 'Welcome to Iris',
        body: (
          <>
            <p style={styles.text}>
              Iris is the agent eval standard for MCP. Every trace your agents log gets scored
              against 13 built-in rules covering completeness, relevance, safety, and cost.
            </p>
            <p style={styles.text}>
              The next 4 steps introduce the system-design ideas that make Iris different from
              a generic observability tool. Takes about a minute.
            </p>
          </>
        ),
      },
      {
        title: 'Decision Moments',
        body: (
          <>
            <p style={styles.text}>
              Not every trace deserves your attention. Iris classifies each one by
              <strong> significance</strong> — safety violations, cost spikes, multi-category
              fails. The timeline surfaces what matters and recedes the rest.
            </p>
            <p style={styles.text}>
              Color + glyph together encode the kind, so the signal is colorblind-safe at a
              glance.
            </p>
          </>
        ),
        cta: {
          label: 'Open the Decision Moment Timeline →',
          href: '/moments',
        },
      },
      {
        title: 'Make-This-A-Rule (workflow inversion)',
        body: (
          <>
            <p style={styles.text}>
              Most eval tools want you to author rules in isolation. Iris flips that:{' '}
              <strong>open a moment, click "Make this a rule," and the composer pre-fills
              from the observed pattern.</strong>{' '}
              Rules are born from production behavior, not whiteboards.
            </p>
            <p style={styles.text}>
              Every deployed rule remembers its source moment. Audit log captures every deploy
              + delete with provenance.
            </p>
          </>
        ),
      },
      {
        title: 'Command palette (⌘K)',
        body: (
          <>
            <p style={styles.text}>
              Press <span style={styles.shortcut}>⌘ K</span> (or{' '}
              <span style={styles.shortcut}>Ctrl K</span>) anywhere to jump to any page,
              filter the timeline, toggle the theme, or open the docs. Type{' '}
              <span style={styles.shortcut}>?</span> for the full shortcut list.
            </p>
            <p style={styles.text}>
              Sequence shortcuts: <span style={styles.shortcut}>g m</span> → moments,{' '}
              <span style={styles.shortcut}>g r</span> → rules,{' '}
              <span style={styles.shortcut}>g a</span> → audit log.
            </p>
          </>
        ),
        cta: {
          label: 'Open the command palette',
          action: () => {
            onClose();
            openPalette();
          },
        },
      },
      {
        title: "You're set",
        body: (
          <>
            <p style={styles.text}>
              Run an agent through Iris and your first Decision Moment will appear within
              seconds. The dashboard auto-refreshes — no need to reload.
            </p>
            <p style={styles.text}>
              You can re-open this tour any time via the command palette → "Onboarding tour".
            </p>
          </>
        ),
        cta: {
          label: 'Go to Decision Moments',
          href: '/moments',
        },
      },
    ],
    [openPalette, onClose],
  );

  // Reset step on open
  useEffect(() => {
    if (open) setStepIndex(0);
  }, [open]);

  // ESC closes
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') handleSkip();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const trapRef = useFocusTrap<HTMLDivElement>(open);

  if (!open) return null;

  const step = steps[stepIndex];
  const isLast = stepIndex === steps.length - 1;

  const persistDismissal = () => {
    // Best-effort — don't block close on a network failure
    patch({ dismissedTours: [TOUR_ID] }).catch(() => undefined);
  };

  const handleSkip = () => {
    persistDismissal();
    onClose();
  };

  const handleFinish = () => {
    persistDismissal();
    onClose();
  };

  const handleCta = (cta: NonNullable<TourStep['cta']>) => {
    if (cta.action) {
      cta.action();
      return;
    }
    if (cta.href) {
      navigate(cta.href);
    }
  };

  const progressPercent = ((stepIndex + 1) / steps.length) * 100;

  return (
    <div
      ref={trapRef}
      style={styles.backdrop}
      onClick={(e) => {
        if (e.target === e.currentTarget) handleSkip();
      }}
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
    >
      <div style={styles.panel}>
        <div style={styles.progressTrack}>
          <div style={{ ...styles.progressFill, width: `${progressPercent}%` }} />
        </div>
        <div style={styles.header}>
          <span style={styles.stepLabel}>
            STEP {stepIndex + 1} OF {steps.length}
          </span>
          <button type="button" onClick={handleSkip} style={styles.skip}>
            Skip tour
          </button>
        </div>
        <div style={styles.body}>
          <h2 id="tour-title" style={styles.title}>
            {step.title}
          </h2>
          {step.body}
          {step.cta && (
            <div style={styles.ctaRow}>
              <button
                type="button"
                onClick={() => handleCta(step.cta!)}
                style={styles.ctaBtn}
              >
                {step.cta.label}
              </button>
            </div>
          )}
        </div>
        <div style={styles.footer}>
          <button
            type="button"
            onClick={() => setStepIndex((i) => Math.max(0, i - 1))}
            disabled={stepIndex === 0}
            style={{
              ...styles.navBtn,
              ...(stepIndex === 0 ? styles.navBtnDisabled : {}),
            }}
          >
            Back
          </button>
          {isLast ? (
            <button
              type="button"
              onClick={handleFinish}
              style={{ ...styles.navBtn, ...styles.navBtnPrimary }}
            >
              Finish
            </button>
          ) : (
            <button
              type="button"
              onClick={() => setStepIndex((i) => Math.min(steps.length - 1, i + 1))}
              style={{ ...styles.navBtn, ...styles.navBtnPrimary }}
            >
              Next
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export const WELCOME_TOUR_ID = TOUR_ID;
