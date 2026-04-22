import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ThemeProvider, useTheme } from '../../../src/components/layout/ThemeProvider';
import { ThemeToggle } from '../../../src/components/layout/ThemeToggle';

function ProbeTheme() {
  const { theme } = useTheme();
  return <span data-testid="probe">{theme}</span>;
}

describe('ThemeProvider', () => {
  beforeEach(() => {
    window.localStorage.removeItem('iris-theme');
    document.documentElement.removeAttribute('data-theme');
  });

  it('defaults to dark theme when no preference is stored and prefers-color-scheme is dark', () => {
    render(
      <ThemeProvider>
        <ProbeTheme />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('dark');
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('reads the stored theme on mount', () => {
    window.localStorage.setItem('iris-theme', 'light');
    render(
      <ThemeProvider>
        <ProbeTheme />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });

  it('toggles theme via the ThemeToggle button and persists', async () => {
    const user = userEvent.setup();
    render(
      <ThemeProvider>
        <ThemeToggle />
        <ProbeTheme />
      </ThemeProvider>,
    );
    expect(screen.getByTestId('probe')).toHaveTextContent('dark');
    await user.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(screen.getByTestId('probe')).toHaveTextContent('light');
    expect(window.localStorage.getItem('iris-theme')).toBe('light');
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});
