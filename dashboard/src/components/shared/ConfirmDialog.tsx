/*
 * ConfirmDialog — in-app confirmation modal for destructive actions.
 *
 * Replaces window.confirm()/window.alert(): native prompts block the
 * event loop, can't be styled, can't show request state, and read as a
 * side-project tell. This dialog:
 *
 *   - Traps focus (useFocusTrap) and restores it to the opener on close.
 *   - Initial focus lands on Cancel (first focusable) — a destructive
 *     action is never the default target of a stray Enter.
 *   - Esc / backdrop click cancel; both are ignored while `busy` so an
 *     in-flight delete can't be orphaned mid-request.
 *   - `error` renders inline (role="alert") instead of a second native
 *     popup — the dialog stays open so the user can retry or bail.
 */
import type { ReactNode } from 'react';
import { useEffect } from 'react';
import { useFocusTrap } from './useFocusTrap';

export interface ConfirmDialogProps {
  open: boolean;
  /** Dialog heading — name the action, not "Are you sure?". */
  title: string;
  /** Consequence line under the title. */
  body?: ReactNode;
  /** Confirm button label. Defaults to "Confirm". */
  confirmLabel?: string;
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string;
  /** Destructive styling on the confirm button. */
  danger?: boolean;
  /** True while the confirmed action is in flight — disables both buttons. */
  busy?: boolean;
  /** Failure from the last confirm attempt — shown inline, dialog stays open. */
  error?: string | null;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger = false,
  busy = false,
  error = null,
  onConfirm,
  onCancel,
}: ConfirmDialogProps) {
  const containerRef = useFocusTrap<HTMLDivElement>(open);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busy) {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="iris-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !busy) onCancel();
      }}
    >
      <div
        ref={containerRef}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-dialog-title"
        aria-describedby={body ? 'confirm-dialog-body' : undefined}
        className="iris-modal confirm-dialog__panel"
      >
        <h2 id="confirm-dialog-title" className="confirm-dialog__title">
          {title}
        </h2>
        {body && (
          <p id="confirm-dialog-body" className="confirm-dialog__body">
            {body}
          </p>
        )}
        {error && (
          <p role="alert" className="confirm-dialog__error">
            {error}
          </p>
        )}
        <div className="confirm-dialog__actions">
          <button type="button" className="iris-btn iris-btn--ghost" onClick={onCancel} disabled={busy}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`iris-btn ${danger ? 'iris-btn--danger-solid' : 'iris-btn--primary'}`}
            onClick={onConfirm}
            disabled={busy}
            aria-busy={busy || undefined}
          >
            {busy ? 'Working…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
