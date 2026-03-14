import type { DashboardSummary } from '../../api/types';
import { formatLatency, formatCost, formatScore, formatNumber } from '../../utils/formatters';

const cardStyle = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--border-radius-lg)',
  padding: 'var(--space-5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
} as const;

const labelStyle = {
  fontSize: 'var(--font-size-xs)',
  color: 'var(--text-muted)',
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
} as const;

const valueStyle = {
  fontSize: 'var(--font-size-2xl)',
  fontWeight: 700,
  color: 'var(--text-primary)',
  fontFamily: 'var(--font-mono)',
} as const;

export function SummaryCards({ summary }: { summary: DashboardSummary }) {
  const cards = [
    { label: 'Total Traces', value: formatNumber(summary.total_traces) },
    { label: 'Avg Latency', value: formatLatency(summary.avg_latency_ms) },
    { label: 'Total Cost', value: formatCost(summary.total_cost_usd) },
    { label: 'Error Rate', value: formatScore(summary.error_rate) },
    { label: 'Eval Pass Rate', value: formatScore(summary.eval_pass_rate) },
  ];

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 'var(--space-4)' }}>
      {cards.map(({ label, value }) => (
        <div key={label} style={cardStyle}>
          <span style={labelStyle}>{label}</span>
          <span style={valueStyle}>{value}</span>
        </div>
      ))}
    </div>
  );
}
