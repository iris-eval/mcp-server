/*
 * TourProvider — global state + auto-open logic for the welcome tour.
 *
 * Auto-opens once when:
 *   - this browser has not dismissed the tour (localStorage — see
 *     tourDismissal.ts for why the server preference alone was not enough)
 *   - Preferences finish loading
 *   - WELCOME_TOUR_ID is NOT in preferences.dismissedTours
 *
 * Exposes openTour / closeTour for re-triggering from the command palette.
 *
 * Lifted into its own provider so:
 *   - Shell can render <WelcomeTour /> with the live state
 *   - CommandPaletteProvider can pull `openTour` into the command context
 *     without entangling tour-render logic
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { usePreferences } from '../../hooks/usePreferences';
import { WELCOME_TOUR_ID } from './WelcomeTour';
import { readTourDismissed } from './tourDismissal';

interface TourContextValue {
  tourOpen: boolean;
  openTour: () => void;
  closeTour: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

export function TourProvider({ children }: { children: ReactNode }) {
  const { preferences } = usePreferences();
  const [tourOpen, setTourOpen] = useState(false);
  const [autoOpened, setAutoOpened] = useState(false);

  useEffect(() => {
    if (autoOpened) return;
    // This browser already saw it — regardless of which server (demo or
    // real) is behind the page. Decided before preferences even load.
    if (readTourDismissed()) {
      setAutoOpened(true);
      return;
    }
    if (!preferences) return;
    const dismissed = preferences.dismissedTours?.includes(WELCOME_TOUR_ID) ?? false;
    if (!dismissed) {
      setTourOpen(true);
    }
    setAutoOpened(true);
  }, [preferences, autoOpened]);

  const openTour = useCallback(() => setTourOpen(true), []);
  const closeTour = useCallback(() => setTourOpen(false), []);

  const value = useMemo(
    () => ({ tourOpen, openTour, closeTour }),
    [tourOpen, openTour, closeTour],
  );

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used inside <TourProvider>');
  return ctx;
}
