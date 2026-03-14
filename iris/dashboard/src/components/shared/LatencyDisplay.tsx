import { formatLatency } from '../../utils/formatters';

export function LatencyDisplay({ ms }: { ms: number }) {
  const color = ms < 1000 ? 'var(--accent-success)' : ms < 5000 ? 'var(--accent-warning)' : 'var(--accent-error)';
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--font-size-sm)', color }}>
      {formatLatency(ms)}
    </span>
  );
}
