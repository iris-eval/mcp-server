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
 * The constants a Gamma(shape, 1) draw needs, worked out once. A caller that
 * draws the same shape thousands of times (the risk estimate's 2,000 draws)
 * keeps these and calls drawGamma; gamma() below works them out per call.
 * Either way it is this one sampler, so the two cannot drift apart.
 */
export interface GammaShape {
  /** Marsaglia–Tsang's d and c, for shape ≥ 1 (for shape < 1, those of shape + 1). */
  d: number;
  c: number;
  /** 1 / shape when shape < 1 (the boost), else 0. */
  boost: number;
}

export function gammaShape(shape: number): GammaShape {
  if (!(shape > 0)) throw new Error(`gamma: shape must be positive, got ${shape}`);
  const s = shape < 1 ? shape + 1 : shape;
  const d = s - 1 / 3;
  return { d, c: 1 / Math.sqrt(9 * d), boost: shape < 1 ? 1 / shape : 0 };
}

/**
 * Gamma(shape, 1) by Marsaglia–Tsang. For shape < 1 the standard boost:
 * draw U, then Gamma(shape + 1), and scale by U^(1/shape).
 */
export function drawGamma(g: GammaShape, rng: () => number): number {
  // The boost's uniform is drawn before the Gamma(shape + 1) it scales.
  let u0 = 0;
  if (g.boost !== 0) while (u0 === 0) u0 = rng();
  const { d, c } = g;
  for (;;) {
    let x: number;
    let v: number;
    do {
      x = normal(rng);
      v = 1 + c * x;
    } while (v <= 0);
    v = v * v * v;
    const u = rng();
    if (u < 1 - 0.0331 * x * x * x * x || Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) {
      return g.boost !== 0 ? d * v * Math.pow(u0, g.boost) : d * v;
    }
  }
}

export function gamma(shape: number, rng: () => number): number {
  return drawGamma(gammaShape(shape), rng);
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
 * 0.10.0 put these half-counts into the RISK arithmetic and stopped there,
 * and 0.11.0's response-shape test caught what that left behind: the
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
 * Wilson, owned here
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
 * cannot depend on the harness. Before 0.12.0 only the harness needed an
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
 * Comparing two runs
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

/** The power the detectable difference is stated at: four times in five. */
export const DETECTABLE_POWER = 0.8;
/** z for 80% power. */
const Z_POWER_80 = 0.8416212335729143;

/**
 * The smallest difference this much data would have detected four times in
 * five.
 *
 * The number that turns "no significant difference" from a shrug into
 * information. A user told only "not significant" learns nothing about
 * whether to trust the result; a user told "this many cases would have
 * missed a drop smaller than 35 points" knows exactly what to do next,
 * which is run more cases.
 *
 * It is the difference a test on two independent samples detects with 80%
 * power, at a pass rate of one half, where a difference is hardest to see:
 * (z_α + z₀.₈₀) · √(p(1−p)(1/n₁ + 1/n₂)). `zAlpha` is the test's own
 * critical value: z₀.₉₅ for the one-sided 5% test a run comparison makes
 * (the default), z₀.₉₇₅ for the two-sided one the drift view makes.
 * It used to be the half-width of the 95% interval at that rate, which is
 * the difference detected about half the time, and a reader told "could not
 * have detected less than X" took it for the stronger statement.
 */
export function smallestDetectableDifference(n1: number, n2: number, rate: number = 0.5, zAlpha: number = Z_90): number | null {
  if (n1 <= 0 || n2 <= 0) return null;
  return Math.min(1, (zAlpha + Z_POWER_80) * Math.sqrt(rate * (1 - rate) * (1 / n1 + 1 / n2)));
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

/** z for a one-sided test at 5%, which is the two-sided 90% interval: equivalence by two one-sided tests at α = 0.05 reads this interval. */
export const Z_90 = 1.6448536269514722;

/**
 * The standard normal distribution function Φ(z), through the complementary
 * error function (the Chebyshev fit in Numerical Recipes; fractional error
 * below 1.2e-7 everywhere). Enough for a p-value a reader compares with 0.05.
 */
export function normalCdf(z: number): number {
  return 0.5 * erfc(-z / Math.SQRT2);
}

function erfc(x: number): number {
  const t = 1 / (1 + 0.5 * Math.abs(x));
  const poly =
    -x * x -
    1.26551223 +
    t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277))))))));
  const r = t * Math.exp(poly);
  return x >= 0 ? r : 2 - r;
}

/**
 * McNemar, one-sided in the regression direction: the probability, when
 * nothing changed, of at least b pass→fail pairs among the b + c that
 * disagreed. The question a comparison asks per rule is "worse", not
 * "different", so only that tail is summed. No discordant pairs is no
 * evidence, and p is 1.
 */
export function mcnemarOneSidedWorse(b: number, c: number): number {
  const n = b + c;
  if (n === 0) return 1;
  let tail = 0;
  for (let i = b; i <= n; i += 1) tail += binomialPmfHalf(i, n);
  return Math.min(1, tail);
}

/**
 * Two independent proportions, one-sided in the regression direction: did
 * the after rate fall?
 *
 * The p is the Newcombe interval inverted: the level at which the interval
 * on (after − before) just reaches zero. So "p ≤ 0.05" and "the 90%
 * Newcombe interval lies below zero" are one statement, exactly, and a
 * summary that prints the word from one and the interval from the other
 * cannot contradict itself. It used to read z off the 95% interval's
 * half-width, which is close to that and not the same, and the summary
 * printed a 95% interval beside a one-sided 5% test: "This is a regression"
 * beside an interval that included zero. Null when either side is empty.
 */
export function newcombeOneSidedWorse(kBefore: number, nBefore: number, kAfter: number, nAfter: number): number | null {
  if (nBefore <= 0 || nAfter <= 0) return null;
  const delta = kAfter / nAfter - kBefore / nBefore;
  if (delta === 0) return 0.5;
  // The bound that has to reach zero: the upper one when the rate fell, the lower one when it rose.
  const bound = (z: number): number => {
    const d = newcombeDifference(kAfter, nAfter, kBefore, nBefore, z)!;
    return delta < 0 ? d.hi : d.lo;
  };
  const crosses = (z: number): boolean => (delta < 0 ? bound(z) >= 0 : bound(z) <= 0);
  let lo = 0;
  let hi = 12;
  if (!crosses(hi)) return delta < 0 ? 0 : 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (crosses(mid)) hi = mid;
    else lo = mid;
  }
  const tail = 1 - normalCdf(hi);
  return delta < 0 ? tail : 1 - tail;
}

/* ------------------------------------------------------------------ *
 * Exact intervals
 * ------------------------------------------------------------------ */

/** ln Γ(x), Lanczos (g = 7, nine terms): relative error under 1e-14 for x > 0. */
export function logGamma(x: number): number {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const y = x - 1;
  let a = c[0];
  const t = y + 7.5;
  for (let i = 1; i < 9; i += 1) a += c[i] / (y + i);
  return 0.5 * Math.log(2 * Math.PI) + (y + 0.5) * Math.log(t) - t + Math.log(a);
}

/** The regularized incomplete beta function I_x(a, b), by the continued fraction (modified Lentz). */
export function betaInc(x: number, a: number, b: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const front = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x));
  // The fraction converges fast for x below (a + 1) / (a + b + 2); above it, use the symmetry.
  if (x > (a + 1) / (a + b + 2)) return 1 - betaInc(1 - x, b, a);
  const tiny = 1e-300;
  let c = 1;
  let d = 1 - ((a + b) * x) / (a + 1);
  if (Math.abs(d) < tiny) d = tiny;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= 400; m += 1) {
    const m2 = 2 * m;
    let num = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2));
    d = 1 + num * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + num / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    h *= d * c;
    num = (-(a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1));
    d = 1 + num * d;
    if (Math.abs(d) < tiny) d = tiny;
    c = 1 + num / c;
    if (Math.abs(c) < tiny) c = tiny;
    d = 1 / d;
    const step = d * c;
    h *= step;
    if (Math.abs(step - 1) < 1e-14) break;
  }
  return (front * h) / a;
}

/** The x at which I_x(a, b) = p, by bisection: 60 halvings is past double precision. */
export function betaQuantile(p: number, a: number, b: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 60; i += 1) {
    const mid = (lo + hi) / 2;
    if (betaInc(mid, a, b) < p) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * The exact (Clopper–Pearson) interval for a proportion: k successes in n.
 *
 * Exact means its coverage is never below the stated level, at any n and
 * any true rate, which no approximate interval can say at n = 10 with a
 * rate of 95%. The price is that it is wider than Wilson. It takes a
 * fractional k, through the beta quantiles it is defined by, which is what
 * a run of cases each answered several times needs (clusterInterval).
 */
export function clopperPearson(k: number, n: number, level: number = 0.95): WilsonInterval | null {
  if (!(n > 0) || k < 0 || k > n) return null;
  const alpha = 1 - level;
  return {
    lo: k <= 0 ? 0 : betaQuantile(alpha / 2, k, n - k + 1),
    hi: k >= n ? 1 : betaQuantile(1 - alpha / 2, k + 1, n - k),
  };
}

/**
 * The difference between two proportions measured on the SAME cases, after
 * minus before, by Newcombe's score method for paired data (method 10 of
 * Newcombe 1998, Statistics in Medicine 17:2635-2650).
 *
 * This is the interval on how far the pass rate moved, over every pair,
 * the ones that did not change included. It is what an equivalence claim
 * has to read: the interval McNemar's test implies (mcnemarDifference,
 * below) is conditional on how many pairs changed, so with one changed pair
 * in six it is narrow, and says nothing about how many would change in the
 * next six.
 *
 * Built like the unpaired method from each proportion's own Wilson limits,
 * with a term for how strongly the two measurements agree: the more the
 * runs agree case by case, the tighter the interval.
 */
export function newcombePairedDifference(bothPass: number, passThenFail: number, failThenPass: number, bothFail: number, z: number = Z_95): Difference | null {
  const n = bothPass + passThenFail + failThenPass + bothFail;
  if (n <= 0) return null;
  const kBefore = bothPass + passThenFail;
  const kAfter = bothPass + failThenPass;
  const before = wilson(kBefore, n, z)!;
  const after = wilson(kAfter, n, z)!;
  const pBefore = kBefore / n;
  const pAfter = kAfter / n;
  const delta = pAfter - pBefore;
  const a = kBefore * (n - kBefore) * kAfter * (n - kAfter);
  let phi = 0;
  if (a > 0) {
    const cross = bothPass * bothFail - passThenFail * failThenPass;
    // Newcombe's continuity adjustment: only agreement beyond n/2 tightens the interval.
    phi = cross > n / 2 ? (cross - n / 2) / Math.sqrt(a) : cross >= 0 ? 0 : cross / Math.sqrt(a);
  }
  const dLo = pAfter - after.lo;
  const dHi = after.hi - pAfter;
  const bLo = pBefore - before.lo;
  const bHi = before.hi - pBefore;
  const clamp = (x: number): number => Math.max(-1, Math.min(1, x));
  const lo = clamp(delta - Math.sqrt(Math.max(0, dLo * dLo - 2 * phi * dLo * bHi + bHi * bHi)));
  const hi = clamp(delta + Math.sqrt(Math.max(0, dHi * dHi - 2 * phi * dHi * bLo + bLo * bLo)));
  return { delta, lo, hi, significant: lo > 0 || hi < 0 };
}

/**
 * The paired difference in pass rate, after minus before, with the interval
 * that matches McNemar's exact one-sided test.
 *
 * McNemar reads only the pairs that disagreed: b passed before and failed
 * after, c the other way. The share of them that fell, π = b / (b + c), has
 * an exact 90% interval, and the difference in pass rate over all N pairs is
 * (c − b) / N = ((b + c) / N) · (1 − 2π). Carrying π's interval through
 * that gives an interval on the difference that lies below zero exactly
 * when the one-sided exact p for "worse" is at most 0.05, and above zero
 * exactly when the one for "better" is. It is conditional on how many pairs
 * disagreed, as the test is: it answers "which way did the changed cases
 * go", and is the wrong interval for "how far apart are the runs"
 * (newcombePairedDifference, above).
 */
export function mcnemarDifference(b: number, c: number, concordant: number, level: number = 0.9): Difference | null {
  const pairs = b + c + concordant;
  if (pairs <= 0) return null;
  const discordant = b + c;
  const delta = (c - b) / pairs;
  if (discordant === 0) return { delta: 0, lo: 0, hi: 0, significant: false };
  const share = clopperPearson(b, discordant, level)!;
  const scale = discordant / pairs;
  const lo = scale * (1 - 2 * share.hi);
  const hi = scale * (1 - 2 * share.lo);
  return { delta, lo, hi, significant: lo > 0 || hi < 0 };
}

/**
 * Benjamini–Hochberg: q-values, in the order the p-values came.
 *
 * Twenty one-sided tests at α = 0.05 on twenty rules that did not change
 * read "worse" somewhere in 1 − 0.95²⁰ ≈ 64% of comparisons, and a
 * dashboard that manufactures a regression most weeks teaches its user to
 * ignore regressions. Sort p₍₁₎ ≤ … ≤ p₍ₘ₎; q₍ᵢ₎ = min over j ≥ i of
 * m·p₍ⱼ₎/j, capped at 1. Calling a row at q ≤ α holds the expected share of
 * false calls among the calls to α — and under the global null, the chance
 * of any false call at all.
 */
export function benjaminiHochberg(p: readonly number[]): number[] {
  const m = p.length;
  if (m === 0) return [];
  const order = p.map((v, i) => ({ v, i })).sort((x, y) => x.v - y.v);
  const q = new Array<number>(m);
  let running = 1;
  for (let rank = m; rank >= 1; rank -= 1) {
    const { v, i } = order[rank - 1];
    running = Math.min(running, (m * v) / rank);
    q[i] = Math.min(1, Math.max(v, running));
  }
  return q;
}

/**
 * A run-level pass rate over CASES, with an interval that holds its level.
 *
 * Repeats of one case are NOT independent observations — an agent that
 * fails a hard question five times has told you about one question, not
 * five. Pooling them inflates n and shrinks the interval to a width the
 * data never earned.
 *
 * Each case counts once, at its own pass rate: a case answered five times
 * and passed four is 0.8 of a success in n cases, and the interval is the
 * exact one for that many successes in that many cases (clopperPearson).
 * So the width is what the number of distinct questions earns, repeats add
 * precision about each question and none about the others, and the
 * interval cannot be narrower than the data: 10 of 10 cases passing reads
 * [69.2%, 100%], not [100%, 100%].
 *
 * It replaces a percentile bootstrap over cases. Resampling cases that
 * all passed returns "all passed" every time, so the bootstrap printed a
 * zero-width 95% interval in the commonest case there is, and at 10 cases
 * and a true rate of 95% its interval held the true rate two times in
 * five. This one holds it at least 95 times in 100 when a case is
 * asked once, and more often than that when cases are repeated
 * (tests/unit/eval/cluster-interval-coverage.test.ts measures both).
 */
export function clusterInterval(cases: ReadonlyArray<{ passed: number; total: number }>, level: number = 0.95): { rate: number; lo: number; hi: number } | null {
  const usable = cases.filter((c) => c.total > 0);
  if (usable.length === 0) return null;
  let successes = 0;
  for (const c of usable) successes += c.passed / c.total;
  const n = usable.length;
  // Sum of n fractions each in [0, 1]: floating-point noise must not push it past n.
  const k = Math.min(n, Math.max(0, successes));
  const interval = clopperPearson(k, n, level)!;
  return { rate: k / n, lo: interval.lo, hi: interval.hi };
}
