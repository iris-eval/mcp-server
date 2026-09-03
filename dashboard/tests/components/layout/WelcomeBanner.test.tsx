/*
 * WelcomeBanner names the REAL preferences file the server reports —
 * it used to hardcode `~/.iris/preferences.json`, which is wrong under
 * IRIS_HOME and always wrong in --demo mode (#377 item 2).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';

const preferencesMock = { displayPath: null as string | null };

vi.mock('../../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: null,
    displayPath: preferencesMock.displayPath,
    loading: false,
    error: null,
    patch: vi.fn(),
    refetch: vi.fn(),
  }),
}));

import { WelcomeBanner } from '../../../src/components/layout/WelcomeBanner';

function renderBanner() {
  return render(
    <MemoryRouter>
      <WelcomeBanner />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  preferencesMock.displayPath = null;
});

describe('WelcomeBanner', () => {
  it('shows the server-reported preferences path, e.g. the demo file under IRIS_HOME', () => {
    preferencesMock.displayPath = '$IRIS_HOME/demo-preferences.json';
    renderBanner();
    expect(screen.getByText('$IRIS_HOME/demo-preferences.json')).toBeInTheDocument();
    expect(screen.queryByText('~/.iris/preferences.json')).not.toBeInTheDocument();
  });

  it('falls back to a generic phrase before the path is known', () => {
    renderBanner();
    expect(screen.getByRole('region', { name: 'Welcome' })).toHaveTextContent(/your Iris preferences file/);
  });

  it('dismissal persists in localStorage', () => {
    renderBanner();
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss welcome banner' }));
    expect(screen.queryByRole('region', { name: 'Welcome' })).not.toBeInTheDocument();
    expect(window.localStorage.getItem('iris-welcome-banner-dismissed')).toBe('1');
  });

  it('has no axe violations', async () => {
    preferencesMock.displayPath = '~/.iris/preferences.json';
    const { container } = renderBanner();
    const results = await axe(container);
    expect(results.violations).toEqual([]);
  });
});
