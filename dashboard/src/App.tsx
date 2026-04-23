import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Shell } from './components/layout/Shell';
import { ThemeProvider } from './components/layout/ThemeProvider';
import { DensitySync } from './components/layout/DensitySync';
import { CommandPaletteProvider } from './components/command/CommandPaletteProvider';
import { PreferencesProvider } from './hooks/usePreferences';
import { TourProvider } from './components/onboarding/TourProvider';
import { DashboardPage } from './components/dashboard/DashboardPage';
import { TraceListPage } from './components/traces/TraceListPage';
import { TraceDetailPage } from './components/traces/TraceDetailPage';
import { EvalListPage } from './components/evals/EvalListPage';
import { MomentsTimelinePage } from './components/moments/MomentsTimelinePage';
import { MomentDetailPage } from './components/moments/MomentDetailPage';
import { RulesPage } from './components/rules/RulesPage';
import { AuditPage } from './components/audit/AuditPage';

export function App() {
  return (
    <PreferencesProvider>
      <DensitySync />
      <ThemeProvider>
        <BrowserRouter>
          <TourProvider>
            <CommandPaletteProvider>
              <Shell>
                <Routes>
                  <Route path="/" element={<DashboardPage />} />
                  <Route path="/moments" element={<MomentsTimelinePage />} />
                  <Route path="/moments/:id" element={<MomentDetailPage />} />
                  <Route path="/rules" element={<RulesPage />} />
                  <Route path="/audit" element={<AuditPage />} />
                  <Route path="/traces" element={<TraceListPage />} />
                  <Route path="/traces/:id" element={<TraceDetailPage />} />
                  <Route path="/evals" element={<EvalListPage />} />
                </Routes>
              </Shell>
            </CommandPaletteProvider>
          </TourProvider>
        </BrowserRouter>
      </ThemeProvider>
    </PreferencesProvider>
  );
}
