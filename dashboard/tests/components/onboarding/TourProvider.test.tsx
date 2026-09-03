/*
 * The welcome tour must not reappear across demo / real dashboards.
 *
 * Dismissal used to live only in server preferences, which are per
 * server (preferences.json vs demo-preferences.json vs IRIS_HOME), so the
 * same browser was toured again on every switch (#377 item 2). The
 * browser now remembers in localStorage, like the banner, and either
 * source suppresses the auto-open.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { Preferences } from '../../../src/api/types';

const preferencesMock: { preferences: Preferences | null } = { preferences: null };

vi.mock('../../../src/hooks/usePreferences', () => ({
  usePreferences: () => ({
    preferences: preferencesMock.preferences,
    displayPath: null,
    loading: false,
    error: null,
    patch: vi.fn().mockResolvedValue(null),
    refetch: vi.fn(),
  }),
}));

import { TourProvider, useTour } from '../../../src/components/onboarding/TourProvider';
import {
  TOUR_DISMISSED_STORAGE_KEY,
  readTourDismissed,
  writeTourDismissed,
} from '../../../src/components/onboarding/tourDismissal';

function prefs(dismissedTours: string[]): Preferences {
  return {
    autoLaunch: true,
    dismissedBanners: [],
    theme: 'system',
    momentFilters: {},
    dismissedTours,
    archivedMoments: [],
    density: 'compact',
    sidebarCollapsed: false,
  };
}

function Probe() {
  const { tourOpen } = useTour();
  return <span data-testid="tour-state">{tourOpen ? 'open' : 'closed'}</span>;
}

function renderProbe() {
  return render(
    <TourProvider>
      <Probe />
    </TourProvider>,
  );
}

beforeEach(() => {
  window.localStorage.clear();
  preferencesMock.preferences = null;
});

describe('TourProvider auto-open', () => {
  it('opens on a fresh browser against a fresh server', () => {
    preferencesMock.preferences = prefs([]);
    renderProbe();
    expect(screen.getByTestId('tour-state')).toHaveTextContent('open');
  });

  it('stays closed when this browser dismissed it — even against a server that never saw the dismissal', () => {
    writeTourDismissed();
    // A different server (say, --demo) with a pristine preferences file.
    preferencesMock.preferences = prefs([]);
    renderProbe();
    expect(screen.getByTestId('tour-state')).toHaveTextContent('closed');
  });

  it('still honours a server-side dismissal from another browser', () => {
    preferencesMock.preferences = prefs(['tour-welcome']);
    renderProbe();
    expect(screen.getByTestId('tour-state')).toHaveTextContent('closed');
  });

  it('tourDismissal round-trips through localStorage', () => {
    expect(readTourDismissed()).toBe(false);
    writeTourDismissed();
    expect(window.localStorage.getItem(TOUR_DISMISSED_STORAGE_KEY)).toBe('1');
    expect(readTourDismissed()).toBe(true);
  });
});
