import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { CommandPalette } from '../../../src/components/command/CommandPalette';
import { ThemeProvider } from '../../../src/components/layout/ThemeProvider';

function renderPalette(open = true, onClose = vi.fn(), onOpenShortcuts = vi.fn()) {
  return render(
    <MemoryRouter>
      <ThemeProvider>
        <CommandPalette open={open} onClose={onClose} onOpenShortcuts={onOpenShortcuts} />
      </ThemeProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
});

describe('CommandPalette', () => {
  it('renders nothing when closed', () => {
    renderPalette(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('renders the palette + input when open', () => {
    renderPalette(true);
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toBeInTheDocument();
    expect(screen.getByPlaceholderText('Type a command or search…')).toBeInTheDocument();
  });

  it('lists Navigate commands by default', () => {
    renderPalette(true);
    expect(screen.getByRole('option', { name: /Decision Moments/ })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: /Custom Rules/ })).toBeInTheDocument();
  });

  it('filters commands by query', async () => {
    const user = userEvent.setup();
    renderPalette(true);
    const input = screen.getByPlaceholderText('Type a command or search…');
    await user.type(input, 'rules');
    // Custom Rules navigation match remains; non-matching items hidden
    expect(screen.queryByRole('option', { name: /Custom Rules/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Toggle theme/ })).not.toBeInTheDocument();
  });

  it('shows empty state when query matches nothing', async () => {
    const user = userEvent.setup();
    renderPalette(true);
    const input = screen.getByPlaceholderText('Type a command or search…');
    await user.type(input, 'asdfqwerty');
    expect(screen.getByText(/No commands match/)).toBeInTheDocument();
  });

  it('closes on Escape', async () => {
    const onClose = vi.fn();
    renderPalette(true, onClose);
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Escape' });
    });
    expect(onClose).toHaveBeenCalled();
  });

  it('runs the active command on Enter and pushes to recents', async () => {
    const onClose = vi.fn();
    renderPalette(true, onClose);
    // First option is the highest-scored Navigate command — Dashboard with empty query
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    expect(onClose).toHaveBeenCalled();
    const recents = JSON.parse(window.localStorage.getItem('iris-recent-commands') ?? '[]');
    expect(recents.length).toBeGreaterThan(0);
  });

  it('arrow keys move selection', async () => {
    renderPalette(true);
    const initial = document.querySelector('[role="option"][aria-selected="true"]');
    expect(initial).toBeTruthy();
    await act(async () => {
      fireEvent.keyDown(window, { key: 'ArrowDown' });
    });
    const next = document.querySelector('[role="option"][aria-selected="true"]');
    expect(next).toBeTruthy();
    expect(next).not.toBe(initial);
  });

  it('opens shortcuts overlay via the help command', async () => {
    const onOpenShortcuts = vi.fn();
    const user = userEvent.setup();
    renderPalette(true, vi.fn(), onOpenShortcuts);
    const input = screen.getByPlaceholderText('Type a command or search…');
    await user.type(input, 'shortcut');
    await act(async () => {
      fireEvent.keyDown(window, { key: 'Enter' });
    });
    expect(onOpenShortcuts).toHaveBeenCalled();
  });
});
