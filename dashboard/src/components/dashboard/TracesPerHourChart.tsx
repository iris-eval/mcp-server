import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

interface DataPoint {
  hour: string;
  count: number;
}

export function TracesPerHourChart({ data }: { data: DataPoint[] }) {
  const formatted = data.map((d) => ({
    ...d,
    label: new Date(d.hour).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  }));

  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--border-radius-lg)',
        padding: 'var(--space-5)',
      }}
    >
      <h3
        style={{
          fontSize: 'var(--font-size-sm)',
          color: 'var(--text-muted)',
          marginBottom: 'var(--space-4)',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        }}
      >
        Traces Per Hour
      </h3>
      <ResponsiveContainer width="100%" height={250}>
        <AreaChart data={formatted}>
          <defs>
            <linearGradient id="colorCount" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#6366f1" stopOpacity={0.3} />
              <stop offset="95%" stopColor="#6366f1" stopOpacity={0} />
            </linearGradient>
          </defs>
          <XAxis dataKey="label" stroke="#71717a" fontSize={12} />
          <YAxis stroke="#71717a" fontSize={12} />
          <Tooltip
            contentStyle={{
              background: '#1c1c1f',
              border: '1px solid #27272a',
              borderRadius: '8px',
              color: '#fafafa',
              fontSize: '13px',
            }}
          />
          <Area
            type="monotone"
            dataKey="count"
            stroke="#6366f1"
            fillOpacity={1}
            fill="url(#colorCount)"
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
