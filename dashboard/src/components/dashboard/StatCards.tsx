interface StatCardProps {
  label: string;
  value: string;
  sub?: string;
  trend?: { value: string; positive: boolean };
  color?: string;
}

const cardStyle = {
  background: 'var(--bg-secondary)',
  border: '1px solid var(--border-color)',
  borderRadius: 'var(--border-radius-lg)',
  padding: 'var(--space-5)',
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-1)',
} as const;

export function StatCard({ label, value, sub, trend, color }: StatCardProps) {
  return (
    <div style={cardStyle}>
      <span
        style={{
          fontSize: 'var(--font-size-xs)',
          color: 'var(--text-muted)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        {label}
      </span>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)' }}>
        <span
          style={{
            fontSize: 'var(--font-size-2xl)',
            fontWeight: 700,
            fontFamily: 'var(--font-mono)',
            color: color || 'var(--text-primary)',
          }}
        >
          {value}
        </span>
        {trend && (
          <span
            style={{
              fontSize: 'var(--font-size-xs)',
              fontFamily: 'var(--font-mono)',
              fontWeight: 600,
              color: trend.positive ? 'var(--accent-success)' : 'var(--accent-error)',
            }}
          >
            {trend.positive ? '▲' : '▼'} {trend.value}
          </span>
        )}
      </div>
      {sub && (
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)' }}>
          {sub}
        </span>
      )}
    </div>
  );
}
