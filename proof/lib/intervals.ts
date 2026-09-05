/*
 * Intervals beyond Wilson — the ones the proof needed and lacked.
 *
 * Dirichlet credible intervals (plan §4.5). The F1 bootstrap resamples
 * observations, so a family with zero errors gives every resample zero
 * errors and an interval of [1, 1] — a point that says the rule is
 * perfect, which thirty cases cannot say. The posterior over the confusion
 * matrix is Dirichlet(tp+½, fp+½, fn+½, tn+½) under the Jeffreys prior;
 * drawing it 2,000 times (seeded Gamma draws, Marsaglia–Tsang) and
 * recomputing precision, recall and F1 per draw gives credible intervals
 * that stay honest at zero errors. Published as a second column beside
 * Wilson so a reader can compare, named a *credible* interval in `method`.
 *
 * Newcombe's hybrid score interval (method 10 in Newcombe 1998) for the
 * difference of two independent proportions, built from each proportion's
 * Wilson limits — the interval arc 5 will print for "did my change make it
 * worse?", and the one arc 2 prints for accuracy(new) − accuracy(old).
 *
 * Brier score and expected calibration error over ten equal-width
 * reliability bins, for a probability against a binary outcome.
 */
import type { Confusion } from './metrics.js';
import { wilson } from '../judge/lib/wilson.js';
import { fnv1a, mulberry32 } from './materialise.js';

export const CREDIBLE_DRAWS = 2000;
export const CREDIBLE_SEED = 'proof-dirichlet-credible-v1';
export const CREDIBLE_METHOD = `dirichlet-jeffreys-${CREDIBLE_DRAWS}-draws-marsaglia-tsang-mulberry32-seed-${CREDIBLE_SEED}`;

export type Interval = [number, number];

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/** Marsaglia–Tsang gamma variate with the shape < 1 boost. */
export function gammaVariate(shape: number, rng: () => number): number {
  if (shape < 1) return gammaVariate(shape + 1, rng) * Math.pow(rng() || 1e-12, 1 / shape);
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      const u1 = rng() || 1e-12;
      const u2 = rng();
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u || 1e-12) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

export interface CredibleIntervals {
  precision: Interval | null;
  recall: Interval | null;
  f1: Interval | null;
}

/**
 * 95% credible intervals for precision, recall and F1 from the Dirichlet
 * posterior of the confusion matrix. Null for a rate whose denominator has
 * no support at all (no positives labelled, or nothing predicted positive)
 * — the same nulls the Wilson columns carry.
 */
export function credibleIntervals(c: Confusion, seed: string, draws: number = CREDIBLE_DRAWS): CredibleIntervals {
  const n = c.tp + c.fp + c.fn + c.tn;
  if (n === 0) return { precision: null, recall: null, f1: null };
  const rng = mulberry32(fnv1a(`${CREDIBLE_SEED}:${seed}`));
  const precision: number[] = [];
  const recall: number[] = [];
  const f1: number[] = [];
  for (let i = 0; i < draws; i++) {
    const g = [gammaVariate(c.tp + 0.5, rng), gammaVariate(c.fp + 0.5, rng), gammaVariate(c.fn + 0.5, rng), gammaVariate(c.tn + 0.5, rng)];
    const sum = g[0] + g[1] + g[2] + g[3];
    const [tp, fp, fn] = [g[0] / sum, g[1] / sum, g[2] / sum];
    precision.push(tp / (tp + fp));
    recall.push(tp / (tp + fn));
    f1.push((2 * tp) / (2 * tp + fp + fn));
  }
  const pct = (xs: number[]): Interval => {
    const s = [...xs].sort((a, b) => a - b);
    const at = (q: number): number => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
    return [round4(at(0.025)), round4(at(0.975))];
  };
  return {
    precision: c.tp + c.fp === 0 ? null : pct(precision),
    recall: c.tp + c.fn === 0 ? null : pct(recall),
    f1: 2 * c.tp + c.fp + c.fn === 0 ? null : pct(f1),
  };
}

/**
 * Newcombe hybrid score interval (method 10) for p1 − p2, two independent
 * proportions k1/n1 and k2/n2. Null when either has no trials.
 */
export function newcombeDifference(k1: number, n1: number, k2: number, n2: number): { delta: number; lo: number; hi: number } | null {
  const w1 = wilson(k1, n1);
  const w2 = wilson(k2, n2);
  if (!w1 || !w2) return null;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const delta = p1 - p2;
  const lo = delta - Math.sqrt((p1 - w1.lo) ** 2 + (w2.hi - p2) ** 2);
  const hi = delta + Math.sqrt((w1.hi - p1) ** 2 + (p2 - w2.lo) ** 2);
  return { delta: round4(delta), lo: round4(Math.max(-1, lo)), hi: round4(Math.min(1, hi)) };
}

export interface CalibrationBin {
  /** Lower edge of the bin, inclusive; the last bin includes 1. */
  from: number;
  to: number;
  n: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

export interface Calibration {
  n: number;
  brier: number;
  ece: number;
  bins: CalibrationBin[];
}

/** Brier score and expected calibration error over ten equal-width bins; `p` is P(bad), `bad` the outcome. */
export function calibration(pairs: ReadonlyArray<{ p: number; bad: boolean }>): Calibration | null {
  if (pairs.length === 0) return null;
  const bins: CalibrationBin[] = Array.from({ length: 10 }, (_, i) => ({ from: i / 10, to: (i + 1) / 10, n: 0, meanPredicted: null, observedRate: null }));
  const sums = bins.map(() => ({ p: 0, bad: 0 }));
  let brier = 0;
  for (const { p, bad } of pairs) {
    const clamped = Math.min(1, Math.max(0, p));
    brier += (clamped - (bad ? 1 : 0)) ** 2;
    const i = Math.min(9, Math.floor(clamped * 10));
    bins[i].n += 1;
    sums[i].p += clamped;
    sums[i].bad += bad ? 1 : 0;
  }
  let ece = 0;
  bins.forEach((b, i) => {
    if (b.n === 0) return;
    b.meanPredicted = round4(sums[i].p / b.n);
    b.observedRate = round4(sums[i].bad / b.n);
    ece += (b.n / pairs.length) * Math.abs(b.meanPredicted - b.observedRate);
  });
  return { n: pairs.length, brier: round4(brier / pairs.length), ece: round4(ece), bins };
}
