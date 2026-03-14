import type { EvalResult } from '../../api/types';
import { Badge } from '../shared/Badge';
import { ScoreBadge } from '../shared/ScoreBadge';

export function EvalDetailCard({ evalResult }: { evalResult: EvalResult }) {
  return (
    <div
      style={{
        background: 'var(--bg-secondary)',
        border: '1px solid var(--border-color)',
        borderRadius: 'var(--border-radius)',
        padding: 'var(--space-4)',
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--space-3)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
        <Badge label={evalResult.eval_type} />
        <Badge label={evalResult.passed ? 'PASS' : 'FAIL'} variant={evalResult.passed ? 'pass' : 'fail'} />
        <ScoreBadge score={evalResult.score} passed={evalResult.passed} />
      </div>

      {/* Rule results */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)' }}>
        {evalResult.rule_results.map((rule) => (
          <div
            key={rule.ruleName}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 'var(--space-2)',
              fontSize: 'var(--font-size-sm)',
              padding: 'var(--space-1) var(--space-2)',
              background: 'var(--bg-primary)',
              borderRadius: 'var(--border-radius-sm)',
            }}
          >
            <span style={{ color: rule.passed ? 'var(--accent-success)' : 'var(--accent-error)', width: '16px' }}>
              {rule.passed ? '\u2713' : '\u2717'}
            </span>
            <code style={{ color: 'var(--text-secondary)', fontSize: 'var(--font-size-xs)' }}>{rule.ruleName}</code>
            <span style={{ flex: 1, color: 'var(--text-muted)', fontSize: 'var(--font-size-xs)' }}>{rule.message}</span>
            <ScoreBadge score={rule.score} passed={rule.passed} />
          </div>
        ))}
      </div>

      {/* Suggestions */}
      {evalResult.suggestions.length > 0 && (
        <div style={{ fontSize: 'var(--font-size-sm)' }}>
          <div style={{ color: 'var(--text-muted)', marginBottom: 'var(--space-1)' }}>Suggestions:</div>
          <ul style={{ margin: 0, paddingLeft: 'var(--space-5)', color: 'var(--text-secondary)' }}>
            {evalResult.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
