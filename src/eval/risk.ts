/*
 * The risk estimate — arc 3's composer, run here in the harness only.
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
 * Arc 2 measured this beside today's arithmetic on a labelled corpus before
 * arc 3 made it the composer: on the held-out split it is right about
 * shipping 57.7% of the time against 38.5%, at an IDENTICAL false-block
 * rate, and misses 55.6% of the bad outputs against 83.3%. The difference
 * in accuracy is +19.2 points with a 95% interval of [-7.5, 42.4], so the
 * case for it is that it misses less without blocking more — not that it is
 * proven more accurate at that sample size. Plan §4.3, §4.4;
 * proof/COMPOSITE.md carries the numbers and regenerates them.
 */
import type { EvalResult, EvalRuleResult, FailureClass } from '../types/eval.js';
import { publishedAccuracyFor } from './accuracy.js';
import { PUBLISHED_ACCURACY_CORPUS_VERSION } from './published-accuracy.js';
import { FAILURE_CLASS_IDS } from './failure-classes.js';
import { fnv1a, mulberry32 } from './seeded-random.js';

/** Jeffreys prior: half a count on each cell, so a family that made no mistakes does not claim certainty. */
const HALF = 0.5;
const sensOf = (d: { counts: { tp: number; fn: number } }): number => (d.counts.tp + HALF) / (d.counts.tp + d.counts.fn + 2 * HALF);
const specOf = (d: { counts: { tn: number; fp: number } }): number => (d.counts.tn + HALF) / (d.counts.tn + d.counts.fp + 2 * HALF);

export const RISK_DRAWS = 2000;
export const DEFAULT_PRIOR = 0.5;

/**
 * What the prior means (arc 2 finding, for arc 3's deliberation):
 *   'per-class'  — plan §4.3 as written: π is the prior that EACH examined
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
}

function beta(a: number, b: number, rng: () => number): number {
  // Marsaglia–Tsang gamma with the shape < 1 boost; beta = ga / (ga + gb).
  const gamma = (shape: number): number => {
    if (shape < 1) return gamma(shape + 1) * Math.pow(rng(), 1 / shape);
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        const u1 = rng();
        const u2 = rng();
        x = Math.sqrt(-2 * Math.log(u1 || 1e-12)) * Math.cos(2 * Math.PI * u2);
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = rng();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  const ga = gamma(a);
  const gb = gamma(b);
  return ga / (ga + gb);
}

/** The evaluated detections and inferences with a published family, one entry per rule. */
export function detectorsOf(result: EvalResult): Detector[] {
  const out: Detector[] = [];
  for (const r of result.rule_results) {
    if (r.skipped) continue;
    if (r.kind !== 'detection' && r.kind !== 'inference') continue;
    const acc = publishedAccuracyFor(r.ruleName);
    if (!acc) continue;
    out.push({
      name: r.ruleName,
      classes: (r.classes ?? []) as FailureClass[],
      fired: r.passed === false,
      counts: { tp: acc.tp, fp: acc.fp, fn: acc.fn, tn: acc.tn },
    });
  }
  return out;
}

/** The per-class prior under a mode, given how many classes the detectors examine. */
export function classPrior(prior: number, mode: PriorMode, examinedClasses: number): number {
  if (mode === 'per-class' || examinedClasses <= 1) return prior;
  return 1 - Math.pow(1 - prior, 1 / examinedClasses);
}

function pBadFrom(detectors: Detector[], prior: number, mode: PriorMode, sensOf: (d: Detector) => number, specOf: (d: Detector) => number): { pBad: number; perClass: Record<string, number | null> } {
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
   * something. Found by arc 2 while writing up the composer, not by
   * reading it.
   */
  const point = pBadFrom(detectors, prior, mode, sensOf, specOf);
  const rng = mulberry32(fnv1a(`risk:${PUBLISHED_ACCURACY_CORPUS_VERSION}:${mode}:${prior.toFixed(3)}:${detectors.map((d) => `${d.name}${d.fired ? '!' : ''}`).join(',')}`));
  const draws: number[] = [];
  for (let i = 0; i < RISK_DRAWS; i++) {
    const sens = new Map<string, number>();
    const spec = new Map<string, number>();
    for (const d of detectors) {
      sens.set(d.name, beta(d.counts.tp + 0.5, d.counts.fn + 0.5, rng));
      spec.set(d.name, beta(d.counts.tn + 0.5, d.counts.fp + 0.5, rng));
    }
    draws.push(pBadFrom(detectors, prior, mode, (d) => sens.get(d.name)!, (d) => spec.get(d.name)!).pBad);
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
    ],
  };
}

const isEffectivelyCritical = (r: EvalRuleResult): boolean => r.critical === true;

/**
 * Compose by kind, as arc 3 will: gates (a failing policy that is effectively
 * critical here), then vetoes (a failing effectively-critical detection),
 * then the risk against τ. `unknown` when a critical rule was asked and could
 * not answer (defeated or config_invalid) — the fail-closed seam.
 */
export function riskVerdict(result: EvalResult, tau: number = DEFAULT_TAU, prior: number = DEFAULT_PRIOR, mode: PriorMode = DEFAULT_PRIOR_MODE): RiskVerdict {
  const rows = result.rule_results;
  const gates = rows.filter((r) => r.kind === 'policy' && !r.skipped && r.passed === false && isEffectivelyCritical(r));
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
  const confidence = risk.lo <= tau && tau <= risk.hi ? 'marginal' : 'decisive';
  if (risk.pBad > tau) {
    const by = Object.entries(risk.perClass)
      .filter(([, q]) => q !== null && q > 0.5)
      .map(([cls]) => cls);
    return { state: 'fail', basis: 'risk_over_loss', by, risk, confidence };
  }
  return { state: 'pass', basis: 'clean', by: [], risk, confidence };
}
