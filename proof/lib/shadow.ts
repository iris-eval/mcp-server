/*
 * A CANDIDATE rule definition, measured beside the shipped one (arc 4).
 *
 * Some changes can only make a rule worse in one direction, and this is the
 * mechanism for finding out before they ship rather than after. Narrowing
 * `no_silent_tool_failure`'s acknowledgement test — requiring the
 * acknowledgement to sit NEAR the failed call's subject rather than anywhere
 * in the output — can only keep or RAISE recall and can only keep or LOWER
 * precision. That rule's published precision was 1.00, so it had nowhere to
 * go but down, and at thirty cases its interval was [0.77, 1] and could not
 * have shown a drop even if there were one.
 *
 * So the helper lands unwired, the family grows first, and both confusion
 * matrices are published side by side. The candidate flips only if it clears
 * a bar stated BEFORE the measurement: precision lower bound at least 0.85,
 * and recall no lower than the shipped rule's. If it does not clear it, the
 * change does not land and this block stays published as a negative result.
 *
 * Nothing here runs in a verdict. It reads the same corpus the shipped rule
 * is measured on, through the same materialiser, and reports.
 */
import { acknowledgesFailure, acknowledgesFailureNear, isFailedStep, subjectOf } from '../../src/eval/rules/trajectory.js';
import { stepsOf } from '../../src/eval/steps.js';
import { contextFor } from './context.js';
import { materialiseCase } from './materialise.js';
import type { CorpusFile } from './corpus.js';
import { wilson } from '../judge/lib/wilson.js';

/** The bar the candidate must clear, stated before the measurement. */
export const CANDIDATE_PRECISION_FLOOR = 0.85;

export interface ShadowArm {
  label: string;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  precision: number | null;
  precisionCi: [number, number] | null;
  recall: number | null;
  recallCi: [number, number] | null;
}

export interface ShadowResult {
  rule: string;
  n: number;
  shipped: ShadowArm;
  candidate: ShadowArm;
  /** Cases where the two definitions disagree about acknowledgement. */
  disagreements: string[];
  clears: boolean;
  verdict: string;
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

function arm(label: string, obs: Array<{ actual: boolean; predicted: boolean }>): ShadowArm {
  let tp = 0;
  let fp = 0;
  let fn = 0;
  let tn = 0;
  for (const o of obs) {
    if (o.actual && o.predicted) tp += 1;
    else if (!o.actual && o.predicted) fp += 1;
    else if (o.actual) fn += 1;
    else tn += 1;
  }
  const p = tp + fp === 0 ? null : wilson(tp, tp + fp);
  const r = tp + fn === 0 ? null : wilson(tp, tp + fn);
  return {
    label,
    tp,
    fp,
    fn,
    tn,
    precision: tp + fp === 0 ? null : round4(tp / (tp + fp)),
    precisionCi: p ? [round4(p.lo), round4(p.hi)] : null,
    recall: tp + fn === 0 ? null : round4(tp / (tp + fn)),
    recallCi: r ? [round4(r.lo), round4(r.hi)] : null,
  };
}

/**
 * Run both definitions of acknowledgement over the
 * `no_silent_tool_failure` family.
 *
 * A case with no failed call is not about acknowledgement at all and is
 * excluded from both arms, so the two numbers are computed over exactly the
 * cases the change could move.
 */
export function measureAcknowledgementShadow(files: CorpusFile[]): ShadowResult | null {
  const file = files.find((f) => f.rule === 'no_silent_tool_failure');
  if (!file) return null;

  const shippedObs: Array<{ actual: boolean; predicted: boolean }> = [];
  const candidateObs: Array<{ actual: boolean; predicted: boolean }> = [];
  const disagreements: string[] = [];

  for (const raw of file.cases) {
    const c = materialiseCase(raw);
    const ctx = contextFor(c, file.config);
    const failed = stepsOf(ctx).filter(isFailedStep);
    if (failed.length === 0) continue;

    const shippedAck = acknowledgesFailure(ctx.output) !== null;
    // EVERY failed call must be acknowledged near its own subject: an output
    // that names one failure and buries another is the shape the candidate
    // exists to catch.
    const candidateAck = failed.every((step) => acknowledgesFailureNear(ctx.output, subjectOf(step)) !== null);

    const actual = c.label === 'positive';
    shippedObs.push({ actual, predicted: !shippedAck });
    candidateObs.push({ actual, predicted: !candidateAck });
    if (shippedAck !== candidateAck) disagreements.push(c.id);
  }

  const shipped = arm('shipped — an acknowledgement phrase anywhere in the output', shippedObs);
  const candidate = arm("candidate — an acknowledgement phrase within 200 characters of the failed call's subject", candidateObs);
  const clears =
    candidate.precisionCi !== null &&
    candidate.precisionCi[0] >= CANDIDATE_PRECISION_FLOOR &&
    candidate.recall !== null &&
    shipped.recall !== null &&
    candidate.recall >= shipped.recall;

  return {
    rule: 'no_silent_tool_failure',
    n: shippedObs.length,
    shipped,
    candidate,
    disagreements,
    clears,
    verdict: clears
      ? `the candidate clears the bar (precision lower bound at least ${CANDIDATE_PRECISION_FLOOR}, recall no lower than the shipped rule) and may be wired`
      : `the candidate does NOT clear the bar (precision lower bound at least ${CANDIDATE_PRECISION_FLOOR}, recall no lower than the shipped rule), so it does not ship and this block stands as a published negative result`,
  };
}

/** The candidate block, as it appears in RESULTS.md. */
export function renderShadow(shadow: ShadowResult): string[] {
  const pct = (x: number | null) => (x === null ? 'n/a' : `${(x * 100).toFixed(1)}%`);
  const ci = (x: [number, number] | null) => (x === null ? '' : ` [${(x[0] * 100).toFixed(1)}, ${(x[1] * 100).toFixed(1)}]`);
  const L: string[] = [];
  L.push(`## Candidate — a narrower acknowledgement for \`${shadow.rule}\` (NOT SHIPPED)`);
  L.push('');
  L.push(
    'The shipped rule accepts an acknowledgement phrase anywhere in the output. The candidate requires it near the failed ' +
      "call's own subject, so that an answer naming one failure while silently answering another is caught. Narrowing can only " +
      'keep or raise recall and can only keep or lower precision, so the bar was set before the measurement: a precision lower ' +
      'bound of at least 0.85, and recall no lower than the shipped rule. Nothing here affects any verdict.',
  );
  L.push('');
  L.push(`Measured over the ${shadow.n} cases of this family that carry a failed call.`);
  L.push('');
  L.push('| Definition | TP | FP | FN | TN | Precision | Recall |');
  L.push('|---|---|---|---|---|---|---|');
  for (const a of [shadow.shipped, shadow.candidate]) {
    L.push(`| ${a.label} | ${a.tp} | ${a.fp} | ${a.fn} | ${a.tn} | ${pct(a.precision)}${ci(a.precisionCi)} | ${pct(a.recall)}${ci(a.recallCi)} |`);
  }
  L.push('');
  L.push(`Cases where the two definitions disagree: ${shadow.disagreements.length === 0 ? 'none' : shadow.disagreements.join(', ')}.`);
  L.push('');
  L.push(`**Verdict: ${shadow.verdict}.**`);
  L.push('');
  return L;
}
