/*
 * The risk estimate — the composer (0.10.0), run here in the harness only.
 *
 * "Bad = any failure class present." The score-layer rules are detectors of
 * DIFFERENT classes, and two detectors of the same class are correlated, so
 * the structure that matches the claim is a noisy-OR across classes with a
 * max inside a class — not a naive-Bayes product (which multiplies
 * correlated evidence) and not a logistic model (which cannot be read
 * against the proof page).
 *
 *   for each class c examined by ≥1 evaluated detection/inference with a
 *   published family:
 *     fired non-empty → q_c = max PPV_d(π_c) over the fired detectors
 *     nothing fired   → q_c = π·Π(1−sens_d) / (π·Π(1−sens_d) + (1−π)·Π spec_d)
 *   p_bad = 1 − Π_c (1 − q_c)
 *   [lo, hi] from 2,000 seeded draws of every sens/spec from its Beta posterior
 *
 * Measurements never enter (their proof is conformance to a formula, not the
 * badness of an output); policies are gates, not evidence; judgments would
 * enter only with a local measured run, which no harness case has.
 *
 * This was measured beside the old arithmetic on a labelled corpus before
 * 0.10.0 made it the composer: on the held-out split it is right about
 * shipping 57.7% of the time against 38.5%, at an IDENTICAL false-block
 * rate, and misses 55.6% of the bad outputs against 83.3%. The difference
 * in accuracy is +19.2 points with a 95% interval of [-7.5, 42.4], so the
 * case for it is that it misses less without blocking more — not that it is
 * proven more accurate at that sample size.
 * proof/COMPOSITE.md carries the numbers and regenerates them.
 */
import type { EvalResult, EvalRuleResult, FailureClass } from '../types/eval.js';
import { publishedAccuracyFor } from './accuracy.js';
import { PUBLISHED_ACCURACY_CORPUS_VERSION } from './published-accuracy.js';
import { FAILURE_CLASS_IDS } from './failure-classes.js';
import { beta, fnv1a, mulberry32, sensitivity, specificity } from './stats.js';
import { decides } from './gate.js';
import { verdictConfidence, type CalibrationTable } from './confidence.js';

/** Jeffreys prior: half a count on each cell, so a family that made no mistakes does not claim certainty. */
/*
 * The same two functions the published number uses (src/eval/stats.ts).
 * They were a private copy here until 0.11.0 found the two had drifted: the
 * risk carried the half-counts and the published PPV did not, so a rule
 * could show a reader 1.00 while the verdict computed 0.97 from the same
 * counts. One quantity, one definition.
 */
const sensOf = (d: { counts: { tp: number; fn: number } }): number => sensitivity(d.counts as never) ?? 0;
const specOf = (d: { counts: { tn: number; fp: number } }): number => specificity(d.counts as never) ?? 0;

export const RISK_DRAWS = 2000;
export const DEFAULT_PRIOR = 0.5;

/**
 * What the prior means (measured before the composer shipped in 0.10.0):
 *   'per-class'  — the literal reading: π is the prior that EACH examined
 *                  class is present. With K classes examined the prior that
 *                  nothing is wrong is (1 − π)^K — at π = 0.5 and K = 10 it
 *                  is 0.001, so the noisy-OR blocks nearly everything.
 *   'per-output' — π is the prior that the OUTPUT is bad (any class
 *                  present); it is spread over the K examined classes as
 *                  π_c = 1 − (1 − π)^(1/K), so that Π(1 − π_c) = 1 − π.
 * Both are measured on the composite corpus so the choice is made on a
 * number, not a preference.
 */
export type PriorMode = 'per-class' | 'per-output';
export const DEFAULT_PRIOR_MODE: PriorMode = 'per-output';
/** τ = 1 / (1 + c) with c = 1: a false pass costs the same as a false block. */
export const DEFAULT_FALSE_PASS_COST = 1;
export const DEFAULT_TAU = 1 / (1 + DEFAULT_FALSE_PASS_COST);

export interface RiskEstimate {
  pBad: number;
  lo: number;
  hi: number;
  perClass: Record<string, number | null>;
  assumptions: string[];
}

export type RiskBasis = 'policy_gate' | 'detector_veto' | 'risk_over_loss' | 'clean' | 'no_rules';

export interface RiskVerdict {
  state: 'pass' | 'fail' | 'unknown';
  basis: RiskBasis;
  by: string[];
  risk: RiskEstimate | null;
  confidence: 'decisive' | 'marginal' | null;
}

interface Detector {
  name: string;
  classes: FailureClass[];
  fired: boolean;
  counts: { tp: number; fp: number; fn: number; tn: number };
  /**
   * The deployment's own labels on this rule's fires, read
   * off the row's stamped uncertainty — so a stored evaluation re-composes
   * on read from the same counts that decided it, and the risk layer needs
   * no second source. Present only at LOCAL_LABEL_MIN labels, on a FIRE.
   */
  local?: { right: number; wrong: number };
}

/** The positive predictive value the local labels imply, with the same half-count prior the published path carries. */
const localPpv = (l: { right: number; wrong: number }): number => (l.right + 0.5) / (l.right + l.wrong + 1);

/*
 * ONE SAMPLER. The risk layer carried
 * its own Beta draw — the same Marsaglia–Tsang gamma as stats.ts, but with
 * the shape < 1 boost drawing its uniform in a different order — so the
 * verdict's credible interval and the published PPV interval were computed
 * by two implementations of one idea. They now share stats.beta; the
 * composite intervals moved by the amount proof/COMPOSITE.md's regeneration
 * records, and nothing else changed.
 */

/** The evaluated detections and inferences with a published family, one entry per rule. */
export function detectorsOf(result: EvalResult): Detector[] {
  const out: Detector[] = [];
  for (const r of result.rule_results) {
    if (r.skipped) continue;
    if (r.kind !== 'detection' && r.kind !== 'inference') continue;
    const acc = publishedAccuracyFor(r.ruleName);
    if (!acc) continue;
    const u = r.uncertainty;
    const local =
      u !== undefined && u.basis === 'local_labels' && r.passed === false && u.n > 0
        ? { right: Math.round(u.precision.point * u.n), wrong: u.n - Math.round(u.precision.point * u.n) }
        : undefined;
    out.push({
      name: r.ruleName,
      classes: (r.classes ?? []) as FailureClass[],
      fired: r.passed === false,
      counts: { tp: acc.tp, fp: acc.fp, fn: acc.fn, tn: acc.tn },
      ...(local !== undefined ? { local } : {}),
    });
  }
  return out;
}

/** The per-class prior under a mode, given how many classes the detectors examine. */
export function classPrior(prior: number, mode: PriorMode, examinedClasses: number): number {
  if (mode === 'per-class' || examinedClasses <= 1) return prior;
  return 1 - Math.pow(1 - prior, 1 / examinedClasses);
}

function pBadFrom(
  detectors: Detector[],
  prior: number,
  mode: PriorMode,
  sensOf: (d: Detector) => number,
  specOf: (d: Detector) => number,
  localPpvOf: (d: Detector) => number | null = (d) => (d.local ? localPpv(d.local) : null),
): { pBad: number; perClass: Record<string, number | null> } {
  const perClass: Record<string, number | null> = {};
  let survive = 1;
  const examinedClasses = FAILURE_CLASS_IDS.filter((cls) => detectors.some((d) => d.classes.includes(cls))).length;
  const priorC = classPrior(prior, mode, examinedClasses);
  for (const cls of FAILURE_CLASS_IDS) {
    const examined = detectors.filter((d) => d.classes.includes(cls));
    if (examined.length === 0) {
      perClass[cls] = null;
      continue;
    }
    const fired = examined.filter((d) => d.fired);
    let q: number;
    if (fired.length > 0) {
      q = Math.max(
        ...fired.map((d) => {
          // A fire with enough of the deployment's own labels carries the
          // deployment's precision — the one place the estimate learns
          // from the traffic it runs on.
          const own = localPpvOf(d);
          if (own !== null) return own;
          const s = sensOf(d);
          const p = specOf(d);
          const den = s * priorC + (1 - p) * (1 - priorC);
          return den === 0 ? 0 : (s * priorC) / den;
        }),
      );
    } else {
      let missAll = 1;
      let specAll = 1;
      for (const d of examined) {
        missAll *= 1 - sensOf(d);
        specAll *= specOf(d);
      }
      const den = priorC * missAll + (1 - priorC) * specAll;
      q = den === 0 ? 0 : (priorC * missAll) / den;
    }
    perClass[cls] = q;
    survive *= 1 - q;
  }
  return { pBad: 1 - survive, perClass };
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** p_bad with a 95% credible interval from the Beta posteriors of every detector's sensitivity and specificity. */
export function riskEstimate(result: EvalResult, prior: number = DEFAULT_PRIOR, mode: PriorMode = DEFAULT_PRIOR_MODE): RiskEstimate | null {
  const detectors = detectorsOf(result);
  if (detectors.length === 0) return null;
  /*
   * Jeffreys half-counts in the POINT estimate, not only in the draws.
   *
   * Twelve of the fifteen published families recorded zero false positives.
   * With specificity exactly 1 the positive predictive value of a fire is
   * exactly 1 at every prior, so p_bad read exactly 1.000 on 31 of the 111
   * composite cases — the same overconfidence the credible interval was
   * added to cure, reintroduced one layer down. A half-count on each cell
   * says what thirty cases can actually support: no_silent_tool_failure's
   * single-fire contribution moves from 1.000 to about 0.69, still well
   * over the shipped threshold, and now with an interval that means
   * something. Found while writing up the composer, not by
   * reading it.
   */
  const point = pBadFrom(detectors, prior, mode, sensOf, specOf);
  const localised = detectors.filter((d) => d.local !== undefined);
  const rng = mulberry32(
    fnv1a(
      `risk:${PUBLISHED_ACCURACY_CORPUS_VERSION}:${mode}:${prior.toFixed(3)}:${detectors.map((d) => `${d.name}${d.fired ? '!' : ''}${d.local ? `@${d.local.right}/${d.local.wrong}` : ''}`).join(',')}`,
    ),
  );
  const draws: number[] = [];
  for (let i = 0; i < RISK_DRAWS; i++) {
    const sens = new Map<string, number>();
    const spec = new Map<string, number>();
    const own = new Map<string, number>();
    for (const d of detectors) {
      sens.set(d.name, beta(d.counts.tp + 0.5, d.counts.fn + 0.5, rng));
      spec.set(d.name, beta(d.counts.tn + 0.5, d.counts.fp + 0.5, rng));
      // The local precision's own posterior: Beta(right + ½, wrong + ½).
      if (d.local) own.set(d.name, beta(d.local.right + 0.5, d.local.wrong + 0.5, rng));
    }
    draws.push(pBadFrom(detectors, prior, mode, (d) => sens.get(d.name)!, (d) => spec.get(d.name)!, (d) => own.get(d.name) ?? null).pBad);
  }
  draws.sort((a, b) => a - b);
  const at = (q: number): number => draws[Math.min(draws.length - 1, Math.max(0, Math.ceil(q * draws.length) - 1))];
  // The point uses the observed rates; a rate at exactly 1 (no false positives
  // in the family) puts the point above every posterior draw, so the interval
  // is widened to contain it — an interval that excludes its own point is a
  // presentation error, not a finding.
  return {
    pBad: round4(point.pBad),
    lo: round4(Math.min(at(0.025), point.pBad)),
    hi: round4(Math.max(at(0.975), point.pBad)),
    perClass: Object.fromEntries(Object.entries(point.perClass).map(([k, v]) => [k, v === null ? null : round4(v)])),
    assumptions: [
      'detectors independent across classes',
      'published accuracy is in-sample, same-model labelled',
      'sensitivity and specificity carry a half-count prior, so a family with no observed errors does not read as certain',
      `prior ${prior}, spread ${mode}`,
      ...(localised.length > 0
        ? [`local precision from this deployment's labels replaces the published positive predictive value for: ${localised.map((d) => `${d.name} (${d.local!.right + d.local!.wrong} labels)`).join(', ')}`]
        : []),
    ],
  };
}

const isEffectivelyCritical = (r: EvalRuleResult): boolean => r.critical === true;

/**
 * Compose by kind, as the engine does: gates (a failing policy that is effectively
 * critical here), then vetoes (a failing effectively-critical detection),
 * then the risk against τ. `unknown` when a critical rule was asked and could
 * not answer (defeated or config_invalid) — the fail-closed seam. `table` is
 * the calibration the confidence label reads (./confidence.ts); the composite
 * harness passes the one it has just measured, so its own output never
 * depends on the table it is about to regenerate.
 */
export function riskVerdict(
  result: EvalResult,
  tau: number = DEFAULT_TAU,
  prior: number = DEFAULT_PRIOR,
  mode: PriorMode = DEFAULT_PRIOR_MODE,
  table?: CalibrationTable,
): RiskVerdict {
  const rows = result.rule_results;
  /*
   * The product's rule (compose.ts, step 1, through gate.ts): a policy gates
   * when the deployment or the caller decided its number, or when it has
   * none — and advises at OUR default. Until 0.16.0 this harness gated a
   * policy only when critical, so the composite measured a composer the
   * product does not run: no_stub_output blocked in the product and was a
   * "missed block" here. No deployment config in the harness, so
   * defaultsGate is false.
   */
  const gates = rows.filter((r) => r.kind === 'policy' && !r.skipped && r.passed === false && (isEffectivelyCritical(r) || decides(r, false)));
  if (gates.length > 0) return { state: 'fail', basis: 'policy_gate', by: gates.map((r) => r.ruleName), risk: riskEstimate(result, prior, mode), confidence: null };
  const vetoes = rows.filter((r) => (r.kind === 'detection' || r.kind === 'inference') && !r.skipped && r.passed === false && isEffectivelyCritical(r));
  if (vetoes.length > 0) return { state: 'fail', basis: 'detector_veto', by: vetoes.map((r) => r.ruleName), risk: riskEstimate(result, prior, mode), confidence: null };
  const unknown = rows.filter((r) => isEffectivelyCritical(r) && r.skipped && r.skipClass && r.skipClass !== 'not_applicable');
  if (unknown.length > 0) return { state: 'unknown', basis: 'clean', by: unknown.map((r) => r.ruleName), risk: null, confidence: null };
  const risk = riskEstimate(result, prior, mode);
  if (!risk) {
    const judged = rows.some((r) => !r.skipped);
    return { state: judged ? 'pass' : 'unknown', basis: judged ? 'clean' : 'no_rules', by: [], risk: null, confidence: null };
  }
  const confidence = verdictConfidence(risk, tau, { prior, priorMode: mode, localLabels: detectorsOf(result).some((d) => d.local !== undefined) }, table).confidence;
  if (risk.pBad > tau) {
    const by = Object.entries(risk.perClass)
      .filter(([, q]) => q !== null && q > 0.5)
      .map(([cls]) => cls);
    return { state: 'fail', basis: 'risk_over_loss', by, risk, confidence };
  }
  return { state: 'pass', basis: 'clean', by: [], risk, confidence };
}
