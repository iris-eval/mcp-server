/*
 * Small, seeded statistics for the product side of the proof.
 *
 * The proof harness (proof/lib/) computes the published intervals; this
 * module lets the SHIPPED server reason with them: a seeded generator so a
 * Monte Carlo interval is a pure function of its inputs (the same on every
 * machine, every request), Gamma and Beta draws for posterior sampling, and
 * the diagnostic-test arithmetic (sensitivity, specificity, positive
 * predictive value at a prevalence) that turns a published confusion matrix
 * into "how often a fire is right for you".
 *
 * `fnv1a` and `mulberry32` are byte-identical twins of proof/lib/materialise.ts
 * (src/ cannot import proof/); tests/unit/eval/stats.test.ts pins the two
 * pairs to each other on a fixed seed.
 */

export function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A standard normal draw (Box–Muller) from a uniform generator; the uniform is kept away from 0. */
export function normal(rng: () => number): number {
  let u = 0;
  while (u === 0) u = rng();
  const v = rng();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/**
 * Gamma(shape, 1) by Marsaglia–Tsang. For shape < 1 the standard boost:
 * draw Gamma(shape + 1) and scale by U^(1/shape).
 */
export function gamma(shape: number, rng: () => number): number {
  if (!(shape > 0)) throw new Error(`gamma: shape must be positive, got ${shape}`);
  if (shape < 1) {
    let u = 0;
    while (u === 0) u = rng();
    return gamma(shape + 1, rng) * Math.pow(u, 1 / shape);
  }
  const d = shape - 1 / 3;
  const c = 1 / Math.sqrt(9 * d);
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x) return d * v;
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
  }
}

/** Beta(a, b) as X / (X + Y) with X ~ Gamma(a), Y ~ Gamma(b). */
export function beta(a: number, b: number, rng: () => number): number {
  const x = gamma(a, rng);
  const y = gamma(b, rng);
  return x / (x + y);
}

/** The 2.5th and 97.5th percentiles of a sample (nearest-rank, sorted in place). */
export function percentile95(values: number[]): [number, number] {
  const sorted = [...values].sort((p, q) => p - q);
  const at = (q: number): number => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))];
  return [at(0.025), at(0.975)];
}

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

/** Sensitivity (recall on the positive class) and specificity from a confusion matrix; null where the denominator is zero. */
/**
 * Half a pseudo-count per cell — the Jeffreys prior the interval draws
 * already use.
 *
 * Arc 3 put these half-counts into the RISK arithmetic and stopped there,
 * and arc 4's response-shape test caught what that left behind: the
 * published positive predictive value a reader sees on a rule result was
 * still computed from the raw rates, so a family with no observed false
 * positives reported a point estimate of exactly 1 while the interval it sat
 * in was capped below 1 and the risk layer, computing the same quantity,
 * disagreed with it. Three shipped rules were reporting certainty they had
 * not earned, and the release notes said no case did.
 *
 * The number a reader is shown and the number the verdict is computed from
 * are the same quantity, so they are now the same function.
 */
export const JEFFREYS_HALF = 0.5;

export function sensitivity(c: Confusion): number | null {
  return c.tp + c.fn === 0 ? null : (c.tp + JEFFREYS_HALF) / (c.tp + c.fn + 2 * JEFFREYS_HALF);
}
export function specificity(c: Confusion): number | null {
  return c.tn + c.fp === 0 ? null : (c.tn + JEFFREYS_HALF) / (c.tn + c.fp + 2 * JEFFREYS_HALF);
}

/**
 * Positive predictive value at prevalence π: of the outputs the rule fires
 * on, the share that are real violations, when a share π of all outputs are
 * violations. The published precision is the PPV at the corpus prevalence
 * (about one half); at one percent prevalence the same rule's fire is worth
 * far less, and this is the arithmetic that says how much.
 */
export function ppv(sens: number, spec: number, prevalence: number): number {
  const truePos = sens * prevalence;
  const falsePos = (1 - spec) * (1 - prevalence);
  return truePos + falsePos === 0 ? 0 : truePos / (truePos + falsePos);
}

/** P(violation | the rule did not fire) at prevalence π — the residual miss rate. */
export function missRate(sens: number, spec: number, prevalence: number): number {
  const missed = (1 - sens) * prevalence;
  const trueNeg = spec * (1 - prevalence);
  return missed + trueNeg === 0 ? 0 : missed / (missed + trueNeg);
}

export const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;
