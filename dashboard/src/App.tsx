import { Suspense, useEffect } from 'react';
import { BrowserRouter, Routes, Route } from 'react-router';
import { Shell } from './components/layout/Shell';
import { ThemeProvider } from './components/layout/ThemeProvider';
import { DensitySync } from './components/layout/DensitySync';
import { CommandPaletteProvider } from './components/command/CommandPaletteProvider';
import { PreferencesProvider } from './hooks/usePreferences';
import { TourProvider } from './components/onboarding/TourProvider';
import { RouteBoundary } from './components/layout/ErrorBoundary';
import { NotFoundPage } from './components/layout/NotFoundPage';
import { RouteLoading } from './components/layout/RouteLoading';
import { PAGE_ROUTES, prefetchPages } from './routes';

export function App() {
  // Once the first page is up, fetch the other pages' code while the
  // browser is idle, so later navigation does not wait on the network.
  useEffect(() => prefetchPages(), []);
  return (
    <PreferencesProvider>
      <DensitySync />
      <ThemeProvider>
        <BrowserRouter>
          <TourProvider>
            <CommandPaletteProvider>
              <Shell>
                {/* One boundary per route: a page that throws keeps the shell and says so; the route change resets it. */}
                <RouteBoundary>
                  {/* Inside the boundary, so a page whose code fails to load is reported where the page was. */}
                  <Suspense fallback={<RouteLoading />}>
                    <Routes>
                      {PAGE_ROUTES.map(({ path, Page }) => (
                        <Route key={path} path={path} element={<Page />} />
                      ))}
                      <Route path="*" element={<NotFoundPage />} />
                    </Routes>
                  </Suspense>
                </RouteBoundary>
              </Shell>
            </CommandPaletteProvider>
          </TourProvider>
        </BrowserRouter>
      </ThemeProvider>
    </PreferencesProvider>
  );
}
