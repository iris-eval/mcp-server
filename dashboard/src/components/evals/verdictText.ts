/*
 * The vocabulary a verdict is read in: what each basis means,
 * what the composer's facts are, and the short name of each question.
 * Pure; the panel renders it and the tests hold the table.
 */
import type { Provenance, QuestionId, Verdict, VerdictBasis } from '../../api/types';

export const BASIS_TEXT: Record<VerdictBasis, string> = {
  policy_gate: 'A gate decided it: a threshold you set, or a judge question, and the rule named failed.',
  detector_veto: 'A critical rule fired. Its fail is the verdict, regardless of every other rule.',
  critical_unknown:
    'A critical rule was asked and could not judge, so the verdict is unknown rather than clean. eval.onCriticalSkipped decides whether unknown reads as a fail.',
  required_evidence_missing:
    'A rule you require evidence from did not run on this call, so the verdict is unknown rather than clean.',
  risk_over_loss:
    'The rules that fired, at their published accuracy and the prior in force, put the risk of a bad output over your loss threshold.',
  clean:
    'Nothing decided against it: no gate failed, no veto fired, and the risk estimate, where one exists, stayed under your loss threshold.',
  no_rules: 'No rule could judge this output, so there is no verdict.',
};

export const STATE_TEXT: Record<Verdict['state'], { label: string; tone: 'pass' | 'fail' | 'unknown' }> = {
  pass: { label: 'PASS', tone: 'pass' },
  fail: { label: 'FAIL', tone: 'fail' },
  unknown: { label: 'UNKNOWN', tone: 'unknown' },
};

export const CONFIDENCE_TEXT: Record<NonNullable<Verdict['confidence']>, string> = {
  decisive: 'Decisive: the credible interval on the risk estimate lies wholly on one side of your loss threshold.',
  marginal:
    'Marginal: the credible interval on the risk estimate straddles your loss threshold, so this verdict could go either way on the evidence available.',
};

/** The short name of each question, for a row; the server sends the full text on capabilities. */
export const QUESTION_LABEL: Record<QuestionId, string> = {
  safe_output: 'Safe to show',
  grounded: 'Grounded',
  complete: 'Complete',
  relevant: 'On task',
  task_completed: 'Task completed',
  tool_use_correct: 'Acted well',
  within_budget: 'Within budget',
};

export const QUESTION_STATUS_TEXT = {
  judged: 'Judged: at least one rule that answers this question ran.',
  unjudged: 'Not judged: no rule that answers this question could run on this call. Unknown, not clean.',
  not_applicable: 'Not applicable: this question does not arise for this kind of output.',
} as const;

export const SEVERITY_TEXT = {
  block: 'This changes the verdict.',
  warn: 'This did not decide the verdict, and a setting would make it.',
  note: 'For the record.',
} as const;

export const ADDRESSEE_TEXT = {
  agent: 'To the agent that made the call.',
  operator: 'To whoever runs this deployment.',
  author: 'To whoever wrote the rule.',
} as const;

/** A row stamped before the composer carries no verdict: say so, never fabricate one. */
export const NO_VERDICT_TEXT =
  'No verdict recorded: this evaluation predates 0.9.0, before Iris composed verdicts. Re-evaluate the trace to get one.';

export function fmtRisk(risk: NonNullable<Verdict['risk']>): string {
  return `p(bad) ${risk.pBad.toFixed(2)} [${risk.lo.toFixed(2)}, ${risk.hi.toFixed(2)}]`;
}

/** The loss threshold the composer used, from the stored facts: τ = 1 / (1 + falsePassCost). */
export function tauOf(composer: NonNullable<Provenance['composer']>): number {
  return 1 / (1 + composer.falsePassCost);
}

export interface ComposerFact {
  key: string;
  value: string;
  sentence: string;
}

export function composerFacts(composer: NonNullable<Provenance['composer']>): ComposerFact[] {
  return [
    {
      key: 'eval.falsePassCost',
      value: String(composer.falsePassCost),
      sentence: `A false pass costs ${composer.falsePassCost}× a false block, so the risk threshold is τ = 1/(1+${composer.falsePassCost}) = ${tauOf(composer).toFixed(2)}.`,
    },
    {
      key: 'eval.defaultsGate',
      value: String(composer.defaultsGate),
      sentence: composer.defaultsGate
        ? 'Shipped thresholds gate: a policy rule fails the verdict even when the number is Iris’s default.'
        : 'Shipped thresholds advise: a policy rule fails the verdict only when you set its number.',
    },
    {
      key: 'eval.onCriticalSkipped',
      value: composer.onCriticalSkipped,
      sentence:
        composer.onCriticalSkipped === 'unknown'
          ? 'A critical rule that cannot judge leaves the verdict unknown.'
          : composer.onCriticalSkipped === 'fail'
            ? 'A critical rule that cannot judge fails the verdict.'
            : 'A critical rule that cannot judge is treated as a pass.',
    },
  ];
}
