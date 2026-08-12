import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { ConfirmDialog } from '../../../src/components/shared/ConfirmDialog';

function renderDialog(props: Partial<Parameters<typeof ConfirmDialog>[0]> = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  const utils = render(
    <ConfirmDialog
      open
      title="Delete rule 'no_pii'?"
      body="It will stop firing."
      confirmLabel="Delete rule"
      danger
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...props}
    />,
  );
  return { onConfirm, onCancel, ...utils };
}

describe('ConfirmDialog', () => {
  it('renders nothing when closed', () => {
    renderDialog({ open: false });
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  it('renders an alertdialog with title, body, and both actions', () => {
    renderDialog();
    const dialog = screen.getByRole('alertdialog', { name: "Delete rule 'no_pii'?" });
    expect(dialog).toBeInTheDocument();
    expect(screen.getByText('It will stop firing.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete rule' })).toBeInTheDocument();
  });

  it('focuses Cancel first — a stray Enter must not confirm a destructive action', () => {
    renderDialog();
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('confirm button fires onConfirm; cancel button fires onCancel', () => {
    const { onConfirm, onCancel } = renderDialog();
    fireEvent.click(screen.getByRole('button', { name: 'Delete rule' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('Escape cancels', async () => {
    const { onCancel } = renderDialog();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('while busy, both buttons are disabled and Escape is ignored', async () => {
    const { onCancel } = renderDialog({ busy: true });
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Working…' })).toBeDisabled();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('shows the error inline as an alert and stays open', () => {
    renderDialog({ error: 'Delete failed: API error: 500' });
    expect(screen.getByRole('alert')).toHaveTextContent('Delete failed: API error: 500');
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();
  });
});
