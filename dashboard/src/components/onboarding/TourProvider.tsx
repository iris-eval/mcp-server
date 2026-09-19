/*
 * TourProvider — global state for the welcome tour.
 *
 * The tour opens on request only (the command palette's "Take the tour";
 * arc 7, D-5). It used to auto-open on a fresh browser against a fresh
 * server, alongside a welcome banner and the first-run modal; all three
 * competed for the first screen, and the Failures empty state now carries
 * what they said. The dismissal record (localStorage + the server-side
 * preference) is kept so an older bundle's decision still reads.
 *
 * Lifted into its own provider so:
 *   - Shell can render <WelcomeTour /> with the live state
 *   - CommandPaletteProvider can pull `openTour` into the command context
 *     without entangling tour-render logic
 */
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';

interface TourContextValue {
  tourOpen: boolean;
  openTour: () => void;
  closeTour: () => void;
}

const TourContext = createContext<TourContextValue | null>(null);

export function TourProvider({ children }: { children: ReactNode }) {
  const [tourOpen, setTourOpen] = useState(false);

  const openTour = useCallback(() => setTourOpen(true), []);
  const closeTour = useCallback(() => setTourOpen(false), []);

  const value = useMemo(() => ({ tourOpen, openTour, closeTour }), [tourOpen, openTour, closeTour]);

  return <TourContext.Provider value={value}>{children}</TourContext.Provider>;
}

export function useTour(): TourContextValue {
  const ctx = useContext(TourContext);
  if (!ctx) throw new Error('useTour must be used inside <TourProvider>');
  return ctx;
}
