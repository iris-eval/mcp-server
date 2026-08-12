import type { EvalResult } from '../../api/types';
import { Badge } from '../shared/Badge';
import { ScoreBadge } from '../shared/ScoreBadge';

/* Static styling lives in utilities.css (.eval-card block). Only the
 * pass/fail mark color stays inline — it's chosen from data. */

export function EvalDetailCard({ evalResult }: { evalResult: EvalResult }) {
  return (
    <div className="iris-card eval-card">
      <div className="eval-card__badges">
        <Badge label={evalResult.eval_type} />
        <Badge label={evalResult.passed ? 'PASS' : 'FAIL'} variant={evalResult.passed ? 'pass' : 'fail'} />
        <ScoreBadge score={evalResult.score} passed={evalResult.passed} />
      </div>

      {/* Rule results */}
      <div className="eval-card__rules">
        {evalResult.rule_results.map((rule) => (
          <div key={rule.ruleName} className="eval-card__rule">
            <span
              className="eval-card__rule-mark"
              style={{ color: rule.passed ? 'var(--eval-pass)' : 'var(--eval-fail)' }}
            >
              {rule.passed ? '✓' : '✗'}
            </span>
            <code className="eval-card__rule-name">{rule.ruleName}</code>
            <span className="eval-card__rule-message">{rule.message}</span>
            <ScoreBadge score={rule.score} passed={rule.passed} />
          </div>
        ))}
      </div>

      {/* Suggestions */}
      {evalResult.suggestions.length > 0 && (
        <div className="eval-card__suggestions">
          <div className="eval-card__suggestions-label">Suggestions:</div>
          <ul className="eval-card__suggestions-list">
            {evalResult.suggestions.map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
