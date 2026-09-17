import { useState } from 'react';
import type { BuiltInRuleMeta, EvalResult, RuleProofSummary } from '../../api/types';
import { RuleResultRow } from './RuleResultRow';
import { VerdictPanel } from './VerdictPanel';

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
  /** The questions' full text by id, from capabilities, when the page has it. */
  questionText?: ReadonlyMap<string, string> | null;
}

/* Static styling lives in utilities.css (.eval-card block). Only the
 * pass/fail mark color stays inline — it's chosen from data. */

export function EvalDetailCard({ evalResult, rules = null, proofs = null, callHref, input, questionText = null }: EvalDetailCardProps) {
  const texts = { output: evalResult.output_text, input };
  // The ladder (D-4): one control on the panel opens method, computation and uncertainty on every row.
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="iris-card eval-card">
      <VerdictPanel
        evalType={evalResult.eval_type}
        passed={evalResult.passed}
        score={evalResult.score}
        verdict={evalResult.verdict}
        coverage={evalResult.coverage}
        interpretations={evalResult.interpretations}
        provenance={evalResult.provenance}
        criticalFailures={evalResult.critical_failures}
        criticalSkipped={evalResult.critical_skipped}
        ruleResults={evalResult.rule_results}
        questionText={questionText}
        expanded={expanded}
        onToggleExpanded={() => setExpanded((v) => !v)}
      />

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
            depth={expanded ? 'full' : 'default'}
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
