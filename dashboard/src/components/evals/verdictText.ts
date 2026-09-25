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

export const CONFIDENCE_TEXT = {
  decisive:
    'Decisive: the credible interval on the risk estimate lies wholly on one side of your loss threshold, and on the composite corpus verdicts at this risk level were measured to land on that side.',
  /** A pass whose interval clears the threshold, not yet confirmed by labelled data at its risk level: the ordinary case at the defaults. */
  unconfirmed:
    'Marginal: the risk estimate has not yet been confirmed by labelled data at this level, so the verdict is not called decisive. It says how far the estimate has been checked, not that this output is a close call; iris-eval.com/proof has the measured numbers.',
  /** A fail, or any verdict whose interval straddles the threshold: a close call. */
  close:
    'Marginal: either the credible interval on the risk estimate straddles your loss threshold, or the composite corpus did not confirm the estimate at this risk level. Treat it as a close call.',
  /** Appended when the row carries the composer's notes; a row stored without them carries none, so nothing is promised. */
  which: ' The note below says which test it did not pass.',
} as const;

/**
 * How the confidence chip reads. A marginal PASS whose interval clears the
 * threshold is neutral: it says the corpus has not yet confirmed the
 * estimate there, not that this output is in doubt. A marginal fail, and a
 * verdict whose interval straddles the threshold, is a close call and keeps
 * the warning tone.
 */
export function confidenceChip(
  verdict: Pick<Verdict, 'state' | 'risk' | 'confidence'>,
  composer: Provenance['composer'] | null,
  hasNotes: boolean,
): { tone: 'warn' | 'muted'; tooltip: string } | null {
  if (!verdict.confidence) return null;
  if (verdict.confidence === 'decisive') return { tone: 'muted', tooltip: CONFIDENCE_TEXT.decisive };
  // A row with no composer facts re-composed under the defaults, whose threshold is 0.5.
  const t = composer ? tauOf(composer) : 0.5;
  const straddles = verdict.risk !== null && verdict.risk.lo <= t && t <= verdict.risk.hi;
  const close = verdict.state !== 'pass' || straddles;
  const which = hasNotes ? CONFIDENCE_TEXT.which : '';
  return close ? { tone: 'warn', tooltip: CONFIDENCE_TEXT.close + which } : { tone: 'muted', tooltip: CONFIDENCE_TEXT.unconfirmed + which };
}

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
