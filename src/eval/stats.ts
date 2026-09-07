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

/* ------------------------------------------------------------------ *
 * Wilson, owned here (arc 5)
 * ------------------------------------------------------------------ */

/**
 * Wilson score interval for a binomial proportion.
 *
 * Why Wilson and not the textbook ±1.96·sqrt(p(1-p)/n): the sets this
 * product reasons about are small and their proportions sit near 0 or 1,
 * which is exactly where the normal approximation collapses — it happily
 * reports an interval of [0.97, 1.03] for 35 of 36. Wilson stays inside
 * [0, 1], is asymmetric where the data are, and behaves at k = 0 and k = n.
 * Reference: Wilson, E. B. (1927), J. Amer. Statist. Assoc. 22:209.
 *
 * IT LIVES HERE, not in proof/, and the direction is the point: `src/`
 * ships inside the package and `proof/` does not, so the shipped server
 * cannot depend on the harness. Before arc 5 only the harness needed an
 * interval; now `compare_runs` returns one to a user, and a second copy
 * would be two definitions of the same number waiting to disagree.
 * proof/judge/lib/wilson.ts re-exports this, so every existing importer
 * there keeps working and there is still exactly one implementation.
 */
export interface WilsonInterval {
  lo: number;
  hi: number;
}

/** Two-sided 95% quantile of the standard normal. */
export const Z_95 = 1.959963984540054;

export function wilson(k: number, n: number, z: number = Z_95): WilsonInterval | null {
  if (!Number.isInteger(k) || !Number.isInteger(n)) {
    throw new TypeError(`wilson(k, n) needs integers, got k=${k} n=${n}`);
  }
  if (n < 0 || k < 0 || k > n) {
    throw new RangeError(`wilson(k, n) needs 0 <= k <= n, got k=${k} n=${n}`);
  }
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return { lo: Math.max(0, centre - half), hi: Math.min(1, centre + half) };
}
/* ------------------------------------------------------------------ *
 * Comparing two runs (arc 5)
 * ------------------------------------------------------------------ */

/**
 * The difference between two independent proportions, by Newcombe's hybrid
 * score method (method 10 of Newcombe 1998).
 *
 * NOT the textbook ±z·sqrt(p₁q₁/n₁ + p₂q₂/n₂). That interval is built on a
 * normal approximation to each proportion, and the proportions this tool
 * compares live where that approximation is worst: pass rates near 1, on
 * runs of a few dozen cases. It cheerfully reports bounds outside [-1, 1]
 * and its coverage collapses exactly when a user most wants to be told
 * "not enough evidence".
 *
 * Newcombe's method builds the difference interval from each proportion's
 * own WILSON limits, which are already the right shape near the boundaries.
 * The result is asymmetric where the data are asymmetric, stays inside
 * [-1, 1] by construction, and behaves at 0 successes and at n successes.
 *
 * Reference: Newcombe, R. G. (1998), Statistics in Medicine 17:873-890.
 */
export interface Difference {
  /** p₁ − p₂, the observed difference. */
  delta: number;
  lo: number;
  hi: number;
  /** True when the interval excludes zero — the only condition under which this tool says "worse". */
  significant: boolean;
}

export function newcombeDifference(k1: number, n1: number, k2: number, n2: number, z: number = Z_95): Difference | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const w1 = wilson(k1, n1, z);
  const w2 = wilson(k2, n2, z);
  if (!w1 || !w2) return null;
  const p1 = k1 / n1;
  const p2 = k2 / n2;
  const delta = p1 - p2;
  // The hybrid: pair each proportion's far limit with the other's near one.
  const lo = delta - Math.sqrt((p1 - w1.lo) ** 2 + (w2.hi - p2) ** 2);
  const hi = delta + Math.sqrt((w1.hi - p1) ** 2 + (p2 - w2.lo) ** 2);
  const clamp = (x: number): number => Math.max(-1, Math.min(1, x));
  const lower = clamp(lo);
  const upper = clamp(hi);
  return { delta, lo: lower, hi: upper, significant: lower > 0 || upper < 0 };
}

/**
 * The smallest difference this much data could have detected.
 *
 * The number that turns "no significant difference" from a shrug into
 * information. A user told only "not significant" learns nothing about
 * whether to trust the result; a user told "this many cases could not have
 * seen a drop smaller than 22 points" knows exactly what to do next, which
 * is run more cases. It is the half-width of the interval at the observed
 * rates, which is what "how close would the two have to be for this to be
 * called a tie" means in practice.
 */
export function smallestDetectableDifference(n1: number, n2: number, rate: number = 0.5, z: number = Z_95): number | null {
  if (n1 <= 0 || n2 <= 0) return null;
  const k1 = Math.round(rate * n1);
  const k2 = Math.round(rate * n2);
  const d = newcombeDifference(k1, n1, k2, n2, z);
  return d === null ? null : (d.hi - d.lo) / 2;
}

/**
 * McNemar's exact test on matched pairs.
 *
 * Once two runs share case keys they are not two independent samples; they
 * are one sample measured twice, and treating them as independent throws
 * away the pairing. McNemar looks only at the DISCORDANT pairs — the cases
 * that passed in one run and failed in the other — because the cases that
 * agreed carry no information about which run is better. That is why a
 * paired test sees a regression an unpaired one cannot: the variance
 * between cases is removed and only the variance from the change is left.
 *
 * EXACT rather than the chi-square approximation, because the discordant
 * count is usually small, which is precisely where chi-square is wrong. The
 * exact test is a two-sided binomial test on b successes in b + c trials at
 * p = 0.5, and it is computed here in closed form.
 */
export interface McNemarResult {
  /** Passed in run 1, failed in run 2. */
  b: number;
  /** Failed in run 1, passed in run 2. */
  c: number;
  /** Pairs where both runs agreed; carried because a reader needs the denominator. */
  concordant: number;
  pairs: number;
  pValue: number;
  significant: boolean;
}

export function mcnemarExact(b: number, c: number, concordant: number, alpha: number = 0.05): McNemarResult {
  const n = b + c;
  const pairs = n + concordant;
  if (n === 0) return { b, c, concordant, pairs, pValue: 1, significant: false };
  // Two-sided exact binomial at p = 0.5: sum the tail at least as extreme.
  const smaller = Math.min(b, c);
  let tail = 0;
  for (let i = 0; i <= smaller; i += 1) tail += binomialPmfHalf(i, n);
  const pValue = Math.min(1, 2 * tail);
  return { b, c, concordant, pairs, pValue, significant: pValue < alpha };
}

/** C(n, k) · 0.5^n, in log space so a large n cannot overflow the factorial. */
function binomialPmfHalf(k: number, n: number): number {
  return Math.exp(logChoose(n, k) - n * Math.LN2);
}

function logChoose(n: number, k: number): number {
  return logFactorial(n) - logFactorial(k) - logFactorial(n - k);
}

/** Lanczos-free log-factorial: exact for the small n this test sees, cached. */
const LOG_FACT: number[] = [0];
function logFactorial(n: number): number {
  for (let i = LOG_FACT.length; i <= n; i += 1) LOG_FACT[i] = LOG_FACT[i - 1] + Math.log(i);
  return LOG_FACT[n];
}

/**
 * A run-level pass rate when one case was run several times.
 *
 * Repeats of one case are NOT independent observations — an agent that
 * fails a hard question five times has told you about one question, not
 * five. Pooling them inflates n and shrinks the interval to a width the
 * data never earned. The cluster bootstrap resamples CASES rather than
 * runs, so the interval reflects how many distinct questions were asked.
 *
 * Seeded, so the same input always produces the same interval — an
 * interval that moved between two identical calls would be indefensible in
 * a report.
 */
export function clusterBootstrap(
  cases: ReadonlyArray<{ passed: number; total: number }>,
  seed: string,
  draws: number = 2_000,
): { rate: number; lo: number; hi: number } | null {
  const usable = cases.filter((c) => c.total > 0);
  if (usable.length === 0) return null;
  const rateOf = (sample: ReadonlyArray<{ passed: number; total: number }>): number => {
    let p = 0;
    let t = 0;
    for (const c of sample) {
      p += c.passed;
      t += c.total;
    }
    return t === 0 ? 0 : p / t;
  };
  const rng = mulberry32(fnv1a(seed));
  const rates: number[] = [];
  for (let d = 0; d < draws; d += 1) {
    const sample: Array<{ passed: number; total: number }> = [];
    for (let i = 0; i < usable.length; i += 1) sample.push(usable[Math.floor(rng() * usable.length)]);
    rates.push(rateOf(sample));
  }
  const [lo, hi] = percentile95(rates);
  return { rate: rateOf(usable), lo, hi };
}
