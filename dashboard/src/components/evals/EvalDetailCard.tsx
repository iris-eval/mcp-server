import { useState, type CSSProperties } from 'react';
import type { BuiltInRuleMeta, EvalResult, RuleProofSummary, VerdictLabelValue } from '../../api/types';
import { RuleResultRow } from './RuleResultRow';
import { VerdictPanel } from './VerdictPanel';
import { Tooltip } from '../shared/Tooltip';
import { TT } from '../shared/tooltipText';

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
  /**
   * Labels on this evaluation's fires by rule name, and the handler that
   * writes one. Without the handler no control is drawn.
   */
  labels?: ReadonlyMap<string, VerdictLabelValue> | null;
  onLabel?: (evalId: string, rule: string, label: VerdictLabelValue) => void;
  labelBusy?: boolean;
  /** One sentence after a label was written: the rule's local precision now. */
  labelNote?: string | null;
  /** Re-score this evaluation's trace under the rules and labels as they stand now; the earlier row is kept. */
  onReevaluate?: (evalId: string) => void;
  reevaluating?: boolean;
  reevaluateNote?: string | null;
}

/* Static styling lives in utilities.css (.eval-card block). Only the
 * pass/fail mark color stays inline — it's chosen from data. */

const styles = {
  actions: { display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap', paddingTop: 'var(--space-2)', fontSize: 'var(--text-caption)', color: 'var(--text-muted)' } as CSSProperties,
  note: { fontSize: 'var(--text-caption)', color: 'var(--text-secondary)' } as CSSProperties,
  supersedes: { fontFamily: 'var(--font-mono)', fontSize: 'var(--text-caption-xs)', color: 'var(--text-muted)' } as CSSProperties,
};

export function EvalDetailCard({
  evalResult,
  rules = null,
  proofs = null,
  callHref,
  input,
  questionText = null,
  labels = null,
  onLabel,
  labelBusy = false,
  labelNote = null,
  onReevaluate,
  reevaluating = false,
  reevaluateNote = null,
}: EvalDetailCardProps) {
  const texts = { output: evalResult.output_text, input };
  // The ladder (D-4): one control on the panel opens method, computation and uncertainty on every row.
  const [expanded, setExpanded] = useState(false);
  const supersedes = typeof evalResult.provenance?.supersedes === 'string' ? evalResult.provenance.supersedes : null;
  return (
    <div className="iris-card eval-card" data-eval-id={evalResult.id}>
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
            label={labels?.get(rule.ruleName) ?? null}
            onLabel={onLabel ? (r, l) => onLabel(evalResult.id, r, l) : undefined}
            labelBusy={labelBusy}
          />
        ))}
      </div>

      {(onReevaluate || labelNote || reevaluateNote || supersedes) && (
        <div className="eval-card__actions" style={styles.actions}>
          {onReevaluate && (
            <Tooltip content={TT.reevaluate}>
              <button
                type="button"
                className="iris-btn iris-btn--ghost iris-btn--sm"
                disabled={reevaluating}
                aria-busy={reevaluating || undefined}
                data-reevaluate={evalResult.id}
                onClick={() => onReevaluate(evalResult.id)}
              >
                {reevaluating ? 'Re-scoring…' : 'Re-score under today’s rules and labels'}
              </button>
            </Tooltip>
          )}
          {supersedes && (
            <span style={styles.supersedes} data-supersedes={supersedes}>
              re-scored from {supersedes.slice(0, 12)}…
            </span>
          )}
          <span role="status" aria-live="polite" style={styles.note} data-eval-note="true">
            {reevaluateNote ?? labelNote ?? ''}
          </span>
        </div>
      )}

    </div>
  );
}
