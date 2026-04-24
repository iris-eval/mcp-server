import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CopyableId } from '../../../src/components/shared/CopyableId';

describe('CopyableId', () => {
  it('renders the value when no displayValue is provided', () => {
    render(<CopyableId value="trace-12345" />);
    expect(screen.getByText('trace-12345')).toBeInTheDocument();
  });

  it('renders the displayValue when provided (canonical value still copyable)', () => {
    render(<CopyableId value="trace-full-12345" displayValue="...12345" />);
    expect(screen.getByText('...12345')).toBeInTheDocument();
    // Full value is still in the DOM as the copy target (not visible to the user as displayValue)
    // We don't assert presence of trace-full-12345 visually because only displayValue renders.
  });

  it('exposes a button with the default aria-label', () => {
    render(<CopyableId value="trace-1" />);
    const button = screen.getByRole('button', { name: 'Copy ID' });
    expect(button).toBeInTheDocument();
  });

  it('uses a custom aria-label when provided', () => {
    render(<CopyableId value="trace-1" ariaLabel="Copy trace ID trace-1" />);
    expect(
      screen.getByRole('button', { name: 'Copy trace ID trace-1' }),
    ).toBeInTheDocument();
  });

  it('writes the value to navigator.clipboard on click', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      writable: true,
      value: { writeText },
    });

    render(<CopyableId value="trace-abc-123" />);
    fireEvent.click(screen.getByRole('button', { name: 'Copy ID' }));

    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('trace-abc-123');
    });
  });
});
