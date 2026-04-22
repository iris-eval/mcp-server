import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { Shell } from './components/layout/Shell';
import { ThemeProvider } from './components/layout/ThemeProvider';
import { DashboardPage } from './components/dashboard/DashboardPage';
import { TraceListPage } from './components/traces/TraceListPage';
import { TraceDetailPage } from './components/traces/TraceDetailPage';
import { EvalListPage } from './components/evals/EvalListPage';

export function App() {
  return (
    <ThemeProvider>
      <BrowserRouter>
        <Shell>
          <Routes>
            <Route path="/" element={<DashboardPage />} />
            <Route path="/traces" element={<TraceListPage />} />
            <Route path="/traces/:id" element={<TraceDetailPage />} />
            <Route path="/evals" element={<EvalListPage />} />
          </Routes>
        </Shell>
      </BrowserRouter>
    </ThemeProvider>
  );
}
