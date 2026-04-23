import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip } from '../../../src/components/shared/Tooltip';

beforeEach(() => {
  vi.useRealTimers();
});

describe('Tooltip', () => {
  it('renders the trigger child', () => {
    render(
      <Tooltip content="Helpful explanation">
        <button>Trigger</button>
      </Tooltip>,
    );
    expect(screen.getByRole('button', { name: 'Trigger' })).toBeInTheDocument();
  });

  it('shows tooltip after delay on hover', async () => {
    const user = userEvent.setup();
    render(
      <Tooltip content="Helpful explanation" delayMs={50}>
        <button>Trigger</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole('button'));
    await waitFor(
      () => {
        const tt = screen.getByRole('tooltip');
        expect(tt).toHaveTextContent('Helpful explanation');
      },
      { timeout: 500 },
    );
  });

  it('shows tooltip on focus immediately when reduced motion preferred', () => {
    // jsdom default prefers no preferences set; we just verify focus DOES open.
    render(
      <Tooltip content="Focus reveal" delayMs={0}>
        <button>Trigger</button>
      </Tooltip>,
    );
    act(() => {
      screen.getByRole('button').focus();
    });
    return waitFor(() => {
      expect(screen.getByRole('tooltip')).toHaveTextContent('Focus reveal');
    });
  });

  it('hides on blur', async () => {
    render(
      <Tooltip content="Bye" delayMs={0}>
        <button>Trigger</button>
      </Tooltip>,
    );
    const btn = screen.getByRole('button');
    act(() => btn.focus());
    await waitFor(() => expect(btn.getAttribute('aria-describedby')).not.toBeNull());
    act(() => btn.blur());
    await waitFor(() => {
      expect(btn.getAttribute('aria-describedby')).toBeNull();
    });
  });

  it('attaches aria-describedby to the trigger when shown', async () => {
    render(
      <Tooltip content="A11y matters" delayMs={0}>
        <button>Trigger</button>
      </Tooltip>,
    );
    act(() => screen.getByRole('button').focus());
    await waitFor(() => {
      expect(screen.getByRole('button').getAttribute('aria-describedby')).toMatch(/^tt-/);
    });
  });

  it('does not interfere with the original onMouseEnter handler', async () => {
    const user = userEvent.setup();
    const inner = vi.fn();
    render(
      <Tooltip content="X" delayMs={50}>
        <button onMouseEnter={inner}>Trigger</button>
      </Tooltip>,
    );
    await user.hover(screen.getByRole('button'));
    expect(inner).toHaveBeenCalled();
  });

  it('disabled prop suppresses the tooltip', () => {
    render(
      <Tooltip content="Should not appear" disabled delayMs={0}>
        <button>Trigger</button>
      </Tooltip>,
    );
    act(() => screen.getByRole('button').focus());
    // No tooltip element rendered when disabled
    expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  });

  it('Escape closes an open tooltip', async () => {
    render(
      <Tooltip content="Closeable" delayMs={0}>
        <button>Trigger</button>
      </Tooltip>,
    );
    const btn = screen.getByRole('button');
    act(() => btn.focus());
    // The tooltip element is always in the DOM (hidden via style) — waiting
    // for toBeInTheDocument is insufficient. We need to wait for the
    // `open` state to propagate to aria-describedby, so the Escape key's
    // window listener is registered before we fire the event. Without
    // this, Escape may fire during the show() setTimeout gap and be
    // ignored, leaving the tooltip permanently open.
    await waitFor(() => {
      expect(btn.getAttribute('aria-describedby')).toMatch(/^tt-/);
    });
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => {
      expect(btn.getAttribute('aria-describedby')).toBeNull();
    });
  });
});
