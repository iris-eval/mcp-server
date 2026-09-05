/*
 * Confusion-matrix arithmetic and intervals for the rule proof.
 *
 * The positive class is the VIOLATION: `actual` is true when the case is
 * labelled positive (the rule should fail it), `predicted` is true when the
 * rule did fail it. Precision = of the outputs the rule failed, the share
 * that were real violations; recall = of the real violations, the share the
 * rule failed.
 *
 * Intervals:
 *   - precision and recall are binomial proportions → Wilson score 95%
 *     (proof/judge/lib/wilson.ts, one implementation for the whole proof
 *     directory).
 *   - F1 is not a proportion and has no closed-form interval. It gets a
 *     seeded percentile bootstrap: resample the family's cases with
 *     replacement B times, recompute F1 each time, take the 2.5th and 97.5th
 *     percentiles. The generator is mulberry32 from a fixed seed, so the
 *     interval is a pure function of the case order and the predictions —
 *     the same on every machine and every run.
 */

import { wilson } from '../judge/lib/wilson.js';
import { fnv1a, mulberry32 } from './materialise.js';
import { credibleIntervals } from './intervals.js';

export interface Observation {
  id: string;
  actual: boolean;
  predicted: boolean;
  skipped: boolean;
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export type Interval = [number, number];

export interface RuleSummary extends Confusion {
  /** Dirichlet (Jeffreys) credible intervals — do not collapse to [1, 1] at zero errors. */
  credible95: { precision: Interval | null; recall: Interval | null; f1: Interval | null };
  n: number;
  positives: number;
  negatives: number;
  skipped: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  ci95: {
    precision: Interval | null;
    recall: Interval | null;
    f1: Interval | null;
  };
}

export const F1_BOOTSTRAP_RESAMPLES = 2000;
export const F1_BOOTSTRAP_SEED = 'proof-f1-bootstrap-v1';
export const F1_CI_METHOD = `bootstrap-percentile-${F1_BOOTSTRAP_RESAMPLES}-mulberry32-seed-${F1_BOOTSTRAP_SEED}`;

export function confusion(obs: readonly Observation[]): Confusion {
  const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
  for (const o of obs) {
    if (o.actual && o.predicted) c.tp++;
    else if (!o.actual && o.predicted) c.fp++;
    else if (o.actual && !o.predicted) c.fn++;
    else c.tn++;
  }
  return c;
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

export function f1Of(c: Confusion): number | null {
  const den = 2 * c.tp + c.fp + c.fn;
  return den === 0 ? null : (2 * c.tp) / den;
}

export function round4(x: number | null): number | null {
  return x === null ? null : Math.round(x * 10_000) / 10_000;
}

function roundInterval(i: Interval | null): Interval | null {
  return i === null ? null : [round4(i[0]) as number, round4(i[1]) as number];
}

function wilsonInterval(k: number, n: number): Interval | null {
  const w = wilson(k, n);
  return w === null ? null : [w.lo, w.hi];
}

/**
 * Percentile bootstrap interval for F1. Resamples that leave F1 undefined
 * (no positive labels and no positive predictions drawn) are discarded;
 * returns null when fewer than half the resamples were usable or the
 * observed F1 itself is undefined.
 */
export function bootstrapF1(
  obs: readonly Observation[],
  resamples: number = F1_BOOTSTRAP_RESAMPLES,
  seed: string = F1_BOOTSTRAP_SEED,
): Interval | null {
  if (obs.length === 0 || f1Of(confusion(obs)) === null) return null;
  const rng = mulberry32(fnv1a(seed));
  const values: number[] = [];
  for (let b = 0; b < resamples; b++) {
    const c: Confusion = { tp: 0, fp: 0, fn: 0, tn: 0 };
    for (let i = 0; i < obs.length; i++) {
      const o = obs[Math.floor(rng() * obs.length)];
      if (o.actual && o.predicted) c.tp++;
      else if (!o.actual && o.predicted) c.fp++;
      else if (o.actual && !o.predicted) c.fn++;
      else c.tn++;
    }
    const f = f1Of(c);
    if (f !== null) values.push(f);
  }
  if (values.length < resamples / 2) return null;
  values.sort((a, b) => a - b);
  const at = (q: number): number => values[Math.min(values.length - 1, Math.max(0, Math.ceil(q * values.length) - 1))];
  return [at(0.025), at(0.975)];
}

export function summarise(obs: readonly Observation[], seed = 'proof'): RuleSummary {
  const c = confusion(obs);
  const credible = credibleIntervals(c, seed);
  const n = obs.length;
  const positives = obs.filter((o) => o.actual).length;
  const precision = ratio(c.tp, c.tp + c.fp);
  const recall = ratio(c.tp, c.tp + c.fn);
  return {
    ...c,
    n,
    positives,
    negatives: n - positives,
    skipped: obs.filter((o) => o.skipped).length,
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1Of(c)),
    ci95: {
      precision: roundInterval(c.tp + c.fp === 0 ? null : wilsonInterval(c.tp, c.tp + c.fp)),
      recall: roundInterval(c.tp + c.fn === 0 ? null : wilsonInterval(c.tp, c.tp + c.fn)),
      f1: roundInterval(bootstrapF1(obs)),
    },
    credible95: {
      precision: roundInterval(credible.precision),
      recall: roundInterval(credible.recall),
      f1: roundInterval(credible.f1),
    },
  };
}
