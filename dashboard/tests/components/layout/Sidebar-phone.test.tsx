/*
 * Phone width: below the tablet breakpoint the sidebar is the
 * icon rail whatever the preference says, and the toggle still records the
 * preference — which applies again on a wider viewport.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { axe } from 'jest-axe';
import { NAV_LABELS } from '../../../src/components/layout/navLabels';

const patchMock = vi.fn().mockResolvedValue(null);
const narrowMock = vi.fn();
vi.mock('../../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: { sidebarCollapsed: false, theme: 'dark', density: 'compact', autoLaunch: true, dismissedBanners: [], momentFilters: {}, dismissedTours: [], archivedMoments: [] },
    displayPath: null,
    loading: false,
    error: null,
    patch: patchMock,
    refetch: vi.fn(),
  }),
}));
vi.mock('../../../src/hooks/useMediaQuery', () => ({
  useMediaQuery: (q: string) => narrowMock(q),
}));
vi.mock('../../../src/components/command/CommandPaletteProvider', () => ({
  useCommandPalette: () => ({ open: vi.fn(), close: vi.fn(), toggle: vi.fn(), isOpen: false, openShortcuts: vi.fn() }),
}));

import { Sidebar } from '../../../src/components/layout/Sidebar';

function sidebar() {
  return render(
    <MemoryRouter>
      <Sidebar />
    </MemoryRouter>,
  );
}

describe('Sidebar at phone width', () => {
  beforeEach(() => {
    patchMock.mockClear();
    narrowMock.mockReset();
  });

  it('is the icon rail below 768px even when the preference says expanded, and the entries keep their names for assistive tech', () => {
    narrowMock.mockReturnValue(true);
    const { container } = sidebar();
    expect(narrowMock).toHaveBeenCalledWith('(max-width: 767px)');
    const aside = container.querySelector('aside')!;
    expect(aside.style.width).toBe('var(--sidebar-width-collapsed)');
    // The wordmark is gone; every entry still carries its name.
    expect(aside.textContent).not.toContain('Iris');
    const names = [...container.querySelectorAll('nav a')].map((a) => a.getAttribute('aria-label'));
    expect(names).toEqual([NAV_LABELS.failures, NAV_LABELS.runs, NAV_LABELS.rules, NAV_LABELS.audit]);
  });

  it('on a wide viewport the preference decides', () => {
    narrowMock.mockReturnValue(false);
    const { container } = sidebar();
    expect(container.querySelector('aside')!.style.width).toBe('var(--sidebar-width-expanded)');
    expect(container.querySelector('aside')!.textContent).toContain('Iris');
  });

  it('the toggle records the preference, not the rail the viewport forced', () => {
    narrowMock.mockReturnValue(true);
    const { getByRole } = sidebar();
    fireEvent.click(getByRole('button', { name: /expand sidebar|collapse sidebar/i }));
    // The preference was "expanded"; the toggle asks for "collapsed" — the rail on a phone is not a preference.
    expect(patchMock).toHaveBeenCalledWith({ sidebarCollapsed: true });
  });

  it('has no axe violations as the rail', async () => {
    narrowMock.mockReturnValue(true);
    const { container } = sidebar();
    expect((await axe(container)).violations).toEqual([]);
  });
});
