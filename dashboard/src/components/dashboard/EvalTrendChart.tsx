import { useState } from 'react';
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import type { EvalTrendPoint } from '../../api/types';

type Period = '24h' | '7d' | '30d' | 'all';

const periodLabels: Record<Period, string> = {
  '24h': '24 Hours',
  '7d': '7 Days',
  '30d': '30 Days',
  'all': 'All Time',
};

function formatLabel(timestamp: string, period: Period): string {
  const date = new Date(timestamp);
  if (period === '24h') return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  if (period === '7d') return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

interface Props {
  data: EvalTrendPoint[];
  period: Period;
  onPeriodChange: (period: Period) => void;
}

export function EvalTrendChart({ data, period, onPeriodChange }: Props) {
  const formatted = data.map((d) => ({
    ...d,
    label: formatLabel(d.timestamp, period),
    scorePercent: Math.round(d.avgScore * 100),
    passPercent: Math.round(d.passRate * 100),
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
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 'var(--space-4)' }}>
        <h3
          style={{
            fontSize: 'var(--font-size-sm)',
            color: 'var(--text-muted)',
            textTransform: 'uppercase',
            letterSpacing: '0.05em',
            margin: 0,
          }}
        >
          Eval Score Trend
        </h3>
        <div style={{ display: 'flex', gap: 'var(--space-1)' }}>
          {(Object.keys(periodLabels) as Period[]).map((p) => (
            <button
              key={p}
              onClick={() => onPeriodChange(p)}
              style={{
                padding: '4px 10px',
                fontSize: 'var(--font-size-xs)',
                fontWeight: period === p ? 600 : 400,
                color: period === p ? 'var(--accent-primary)' : 'var(--text-muted)',
                background: period === p ? 'rgba(13, 148, 136, 0.12)' : 'transparent',
                border: `1px solid ${period === p ? 'var(--accent-primary)' : 'var(--border-color)'}`,
                borderRadius: 'var(--border-radius-sm)',
                cursor: 'pointer',
                transition: 'var(--transition-fast)',
              }}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <ResponsiveContainer width="100%" height={220}>
        <AreaChart data={formatted}>
          <defs>
            <linearGradient id="evalScoreFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#0d9488" stopOpacity={0.25} />
              <stop offset="95%" stopColor="#0d9488" stopOpacity={0} />
            </linearGradient>
            <linearGradient id="passRateFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="5%" stopColor="#22c55e" stopOpacity={0.12} />
              <stop offset="95%" stopColor="#22c55e" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid strokeDasharray="3 3" stroke="rgba(39, 39, 42, 0.5)" vertical={false} />
          <XAxis dataKey="label" stroke="#71717a" fontSize={11} tickLine={false} axisLine={false} />
          <YAxis
            domain={[0, 100]}
            stroke="#71717a"
            fontSize={11}
            tickLine={false}
            axisLine={false}
            tickFormatter={(v: number) => `${v}%`}
          />
          <Tooltip
            contentStyle={{
              background: '#1c1c1f',
              border: '1px solid #27272a',
              borderRadius: '8px',
              color: '#fafafa',
              fontSize: '13px',
            }}
            formatter={(value, name) => [
              `${value}%`,
              name === 'scorePercent' ? 'Avg Score' : 'Pass Rate',
            ]}
          />
          <Area
            type="monotone"
            dataKey="scorePercent"
            stroke="#0d9488"
            strokeWidth={2.5}
            fillOpacity={1}
            fill="url(#evalScoreFill)"
          />
          <Area
            type="monotone"
            dataKey="passPercent"
            stroke="#22c55e"
            strokeWidth={1.5}
            strokeDasharray="4 3"
            fillOpacity={1}
            fill="url(#passRateFill)"
          />
        </AreaChart>
      </ResponsiveContainer>
      <div style={{ display: 'flex', gap: 'var(--space-5)', justifyContent: 'center', marginTop: 'var(--space-2)' }}>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: 12, height: 3, background: '#0d9488', borderRadius: 2, display: 'inline-block' }} />
          Avg Score
        </span>
        <span style={{ fontSize: 'var(--font-size-xs)', color: 'var(--text-muted)', display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span style={{ width: 12, height: 3, background: '#22c55e', borderRadius: 2, display: 'inline-block', borderTop: '1px dashed #22c55e' }} />
          Pass Rate
        </span>
      </div>
    </div>
  );
}
