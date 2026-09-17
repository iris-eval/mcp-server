import type { BuiltInRuleMeta, EvalResult, RuleProofSummary } from '../../api/types';
import { Badge } from '../shared/Badge';
import { ScoreBadge } from '../shared/ScoreBadge';
import { RuleResultRow } from './RuleResultRow';

export interface EvalDetailCardProps {
  evalResult: EvalResult;
  /** The built-in roster by name, when the page has it: the row's definition. */
  rules?: ReadonlyMap<string, BuiltInRuleMeta> | null;
  /** Published accuracy by name, when the page has it: the interval for rows that carry none. */
  proofs?: ReadonlyMap<string, RuleProofSummary> | null;
  /** Where a tool-call evidence item links. */
  callHref?: (index: number) => string;
  /** The trace's input, so input spans can be quoted. The output is the evaluation's own. */
  input?: string;
}

/* Static styling lives in utilities.css (.eval-card block). Only the
 * pass/fail mark color stays inline — it's chosen from data. */

export function EvalDetailCard({ evalResult, rules = null, proofs = null, callHref, input }: EvalDetailCardProps) {
  const texts = { output: evalResult.output_text, input };
  return (
    <div className="iris-card eval-card">
      <div className="eval-card__badges">
        <Badge label={evalResult.eval_type} />
        <Badge label={evalResult.passed ? 'PASS' : 'FAIL'} variant={evalResult.passed ? 'pass' : 'fail'} />
        <ScoreBadge score={evalResult.score} passed={evalResult.passed} />
      </div>

      {/* Rule results */}
      <div className="eval-card__rules">
        {/* One renderer for a rule result (D-3): every stamped field, in RuleResultRow. */}
        {evalResult.rule_results.map((rule) => (
          <RuleResultRow
            key={rule.ruleName}
            result={rule}
            meta={rules?.get(rule.ruleName) ?? null}
            proof={proofs?.get(rule.ruleName) ?? null}
            callHref={callHref}
            texts={texts}
          />
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
