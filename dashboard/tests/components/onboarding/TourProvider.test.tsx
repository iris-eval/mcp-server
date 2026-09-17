/*
 * The tour opens on request only (D-5): never on its own, whatever the
 * browser or the server has recorded; openTour/closeTour drive it.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TourProvider, useTour } from '../../../src/components/onboarding/TourProvider';
import { TOUR_DISMISSED_STORAGE_KEY, readTourDismissed, writeTourDismissed } from '../../../src/components/onboarding/tourDismissal';

function Probe() {
  const { tourOpen, openTour, closeTour } = useTour();
  return (
    <>
      <span data-testid="tour-state">{tourOpen ? 'open' : 'closed'}</span>
      <button type="button" onClick={openTour}>
        open
      </button>
      <button type="button" onClick={closeTour}>
        close
      </button>
    </>
  );
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
});

describe('TourProvider (D-5): on request only', () => {
  it('stays closed on a fresh browser — nothing opens on its own', () => {
    renderProbe();
    expect(screen.getByTestId('tour-state').textContent).toBe('closed');
  });

  it('opens on request and closes on request', () => {
    renderProbe();
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByTestId('tour-state').textContent).toBe('open');
    fireEvent.click(screen.getByText('close'));
    expect(screen.getByTestId('tour-state').textContent).toBe('closed');
  });

  it('a recorded dismissal does not stop a request', () => {
    writeTourDismissed();
    renderProbe();
    fireEvent.click(screen.getByText('open'));
    expect(screen.getByTestId('tour-state').textContent).toBe('open');
  });

  it('tourDismissal round-trips through localStorage', () => {
    expect(readTourDismissed()).toBe(false);
    writeTourDismissed();
    expect(window.localStorage.getItem(TOUR_DISMISSED_STORAGE_KEY)).toBe('1');
    expect(readTourDismissed()).toBe(true);
  });
});
