import { formatScore } from '../../utils/formatters';

/** `neutral`: the score of a verdict that was not checked. It is a gradient over the rules that ran, and neither colour of a result. */
export function ScoreBadge({ score, passed, neutral }: { score: number; passed?: boolean; neutral?: boolean }) {
  const isPassing = passed ?? score >= 0.7;
  if (neutral) {
    return (
      <span
        style={{
          display: 'inline-block',
          padding: '2px 8px',
          borderRadius: 'var(--border-radius-sm)',
          fontSize: 'var(--font-size-xs)',
          fontWeight: 600,
          fontFamily: 'var(--font-mono)',
          background: '#27272a',
          color: '#a1a1aa',
        }}
      >
        {formatScore(score)}
      </span>
    );
  }
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
        // The red is #ef4444 lifted to 4.5:1 on its #450a0a fill.
        color: isPassing ? '#22c55e' : '#f44948',
      }}
    >
      {formatScore(score)}
    </span>
  );
}
