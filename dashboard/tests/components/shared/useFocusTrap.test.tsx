/*
 * useFocusTrap — verifies the keyboard trap + focus-restore semantics
 * for modal dialogs. Without this hook a Tab cycle could escape into
 * the background page, and screen-reader users would land at <body>
 * after dialog close instead of returning to the trigger.
 */
import { describe, it, expect } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import { useState } from 'react';
import { useFocusTrap } from '../../../src/components/shared/useFocusTrap';

function ModalHarness({ initialOpen = false }: { initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const trapRef = useFocusTrap<HTMLDivElement>(open);
  return (
    <>
      <button data-testid="opener" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <div ref={trapRef} role="dialog" aria-modal="true">
          <button data-testid="first">first</button>
          <button data-testid="middle">middle</button>
          <button data-testid="last" onClick={() => setOpen(false)}>
            close
          </button>
        </div>
      )}
    </>
  );
}

describe('useFocusTrap', () => {
  it('auto-focuses the first focusable element when activated', () => {
    const { getByTestId } = render(<ModalHarness initialOpen />);
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('Tab from the last element wraps to the first', () => {
    const { getByTestId } = render(<ModalHarness initialOpen />);
    const last = getByTestId('last');
    last.focus();
    expect(document.activeElement).toBe(last);
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(document.activeElement).toBe(getByTestId('first'));
  });

  it('Shift+Tab from the first element wraps to the last', () => {
    const { getByTestId } = render(<ModalHarness initialOpen />);
    expect(document.activeElement).toBe(getByTestId('first'));
    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(getByTestId('last'));
  });

  it('restores focus to the opener when the trap deactivates', () => {
    const { getByTestId, queryByRole } = render(<ModalHarness />);
    const opener = getByTestId('opener');
    opener.focus();
    expect(document.activeElement).toBe(opener);
    // Open
    act(() => fireEvent.click(opener));
    expect(queryByRole('dialog')).not.toBeNull();
    expect(document.activeElement).toBe(getByTestId('first'));
    // Close (clicks the "last" button which sets open=false)
    act(() => fireEvent.click(getByTestId('last')));
    expect(queryByRole('dialog')).toBeNull();
    // Focus is restored to the opener
    expect(document.activeElement).toBe(opener);
  });

  it('does not interfere with keys other than Tab', () => {
    const { getByTestId } = render(<ModalHarness initialOpen />);
    expect(document.activeElement).toBe(getByTestId('first'));
    // Pressing arrows / chars / Esc / etc. should be no-ops as far as the trap is concerned
    fireEvent.keyDown(document, { key: 'ArrowDown' });
    fireEvent.keyDown(document, { key: 'a' });
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(document.activeElement).toBe(getByTestId('first'));
  });
});
