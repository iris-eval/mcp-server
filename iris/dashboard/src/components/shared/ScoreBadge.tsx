import { formatScore } from '../../utils/formatters';

export function ScoreBadge({ score, passed }: { score: number; passed?: boolean }) {
  const isPassing = passed ?? score >= 0.7;
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '2px 8px',
        borderRadius: 'var(--border-radius-sm)',
        fontSize: 'var(--font-size-xs)',
        fontWeight: 600,
        fontFamily: 'var(--font-mono)',
        background: isPassing ? '#052e16' : '#450a0a',
        color: isPassing ? '#22c55e' : '#ef4444',
      }}
    >
      {formatScore(score)}
    </span>
  );
}
