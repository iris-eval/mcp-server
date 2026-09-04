import type { CSSProperties } from 'react';
import type { EvalResult } from '../../api/types';
import { Badge } from '../shared/Badge';
import { ScoreBadge } from '../shared/ScoreBadge';

const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  padding: 0,
  margin: -1,
  overflow: 'hidden',
  clip: 'rect(0, 0, 0, 0)',
  whiteSpace: 'nowrap',
  border: 0,
};

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
        {evalResult.rule_results.map((rule) => {
          /*
           * A skipped rule is "not judged", not "failed": the server ships it
           * with passed:false / score:0 as placeholders and `skipped: true`.
           * This card used to branch on `passed` alone and drew the same red
           * cross for "no cost was supplied" as for "an SSN was found" — the
           * moment page already told the two apart; the /evals modal and the
           * trace page did not.
           */
          const state = rule.skipped ? 'skipped' : rule.passed ? 'passed' : 'failed';
          const color =
            state === 'skipped'
              ? 'var(--eval-skipped)'
              : state === 'passed'
                ? 'var(--eval-pass)'
                : 'var(--eval-fail)';
          const mark = state === 'skipped' ? '○' : state === 'passed' ? '✓' : '✗';
          const srLabel = state === 'skipped' ? 'Skipped: ' : state === 'passed' ? 'Passed: ' : 'Failed: ';
          return (
            <div key={rule.ruleName} className="eval-card__rule" data-rule-state={state}>
              <span className="eval-card__rule-mark" style={{ color }} aria-hidden="true">
                {mark}
              </span>
              <code className="eval-card__rule-name">
                <span style={SR_ONLY}>{srLabel}</span>
                {rule.ruleName}
              </code>
              <span className="eval-card__rule-message">{rule.message}</span>
              {state === 'skipped' ? (
                <Badge label="SKIPPED" variant="UNSET" />
              ) : (
                <ScoreBadge score={rule.score} passed={rule.passed} />
              )}
            </div>
          );
        })}
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
