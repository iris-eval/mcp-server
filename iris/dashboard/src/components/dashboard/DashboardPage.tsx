import { useSummary } from '../../api/hooks';
import { SummaryCards } from './SummaryCards';
import { TracesPerHourChart } from './TracesPerHourChart';
import { LoadingSpinner } from '../shared/LoadingSpinner';
import { EmptyState } from '../shared/EmptyState';

export function DashboardPage() {
  const { data, loading, error } = useSummary(24);

  if (loading) return <LoadingSpinner />;
  if (error) return <EmptyState message={`Error: ${error}`} />;
  if (!data) return <EmptyState />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-6)' }}>
      <h1 style={{ fontSize: 'var(--font-size-2xl)', fontWeight: 700 }}>Dashboard</h1>
      <SummaryCards summary={data} />
      <TracesPerHourChart data={data.traces_per_hour} />
    </div>
  );
}
