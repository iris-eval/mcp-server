/*
 * The exact intervals the comparisons print, and the rule that a printed
 * word and a printed interval never disagree.
 *
 * Three statements a comparison made did not match their own numbers:
 * "This is a regression" beside a 95% interval that contained zero (the
 * test was one-sided at 5%, which is a 90% interval); "could not have
 * detected a change smaller than X" where X was the difference seen about
 * half the time; and a "95% interval" of [100%, 100%] whenever every case
 * passed.
 */
import { describe, expect, it } from 'vitest';
import {
  betaInc,
  betaQuantile,
  clopperPearson,
  clusterInterval,
  logGamma,
  mcnemarDifference,
  mcnemarOneSidedWorse,
  newcombeDifference,
  mulberry32,
  newcombeOneSidedWorse,
  newcombePairedDifference,
  smallestDetectableDifference,
  Z_90,
} from '../../../src/eval/stats.js';

describe('the beta function the exact intervals are built on', () => {
  it('logGamma matches known values', () => {
    expect(logGamma(1)).toBeCloseTo(0, 12);
    expect(logGamma(5)).toBeCloseTo(Math.log(24), 12);
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 12);
    expect(logGamma(101)).toBeCloseTo(363.73937555556347, 9);
  });

  it('betaInc matches the binomial tail it stands for, and its own symmetry', () => {
    // I_p(k, n − k + 1) = P(X ≥ k) for X ~ Binomial(n, p).
    const tail = (k: number, n: number, p: number): number => {
      let s = 0;
      for (let i = k; i <= n; i += 1) {
        let choose = 1;
        for (let j = 0; j < i; j += 1) choose = (choose * (n - j)) / (j + 1);
        s += choose * p ** i * (1 - p) ** (n - i);
      }
      return s;
    };
    for (const [k, n, p] of [[1, 10, 0.3], [5, 10, 0.5], [9, 10, 0.95], [3, 50, 0.02], [40, 60, 0.7]] as const) {
      expect(betaInc(p, k, n - k + 1)).toBeCloseTo(tail(k, n, p), 10);
    }
    expect(betaInc(0.3, 2.5, 4)).toBeCloseTo(1 - betaInc(0.7, 4, 2.5), 12);
    expect(betaInc(0, 2, 3)).toBe(0);
    expect(betaInc(1, 2, 3)).toBe(1);
  });

  it('betaQuantile inverts it', () => {
    for (const [p, a, b] of [[0.025, 3, 8], [0.5, 1, 1], [0.975, 10, 1], [0.05, 0.8, 9.2]] as const) {
      expect(betaInc(betaQuantile(p, a, b), a, b)).toBeCloseTo(p, 10);
    }
  });
});

describe('the exact interval for a proportion', () => {
  it('matches the published Clopper–Pearson limits', () => {
    // 0 of 10, 10 of 10 (the "rule of three" neighbourhood), and an interior case.
    expect(clopperPearson(0, 10)).toEqual({ lo: 0, hi: expect.closeTo(0.3085, 4) });
    expect(clopperPearson(10, 10)).toEqual({ lo: expect.closeTo(0.6915, 4), hi: 1 });
    const mid = clopperPearson(7, 20)!;
    expect(mid.lo).toBeCloseTo(0.1539, 4);
    expect(mid.hi).toBeCloseTo(0.5922, 4);
    expect(clopperPearson(0, 0)).toBeNull();
  });

  it('takes a fractional count, between its integer neighbours', () => {
    const below = clopperPearson(7, 10)!;
    const half = clopperPearson(7.5, 10)!;
    const above = clopperPearson(8, 10)!;
    expect(half.lo).toBeGreaterThan(below.lo);
    expect(half.lo).toBeLessThan(above.lo);
    expect(half.hi).toBeGreaterThan(below.hi);
    expect(half.hi).toBeLessThan(above.hi);
  });
});

describe('the pass rate over cases', () => {
  it('is never zero-width: every case passing reads an interval that says how many cases there were', () => {
    const ten = clusterInterval(Array.from({ length: 10 }, () => ({ passed: 1, total: 1 })))!;
    expect(ten.rate).toBe(1);
    expect(ten.lo).toBeCloseTo(0.6915, 4);
    expect(ten.hi).toBe(1);
    const fifty = clusterInterval(Array.from({ length: 50 }, () => ({ passed: 3, total: 3 })))!;
    expect(fifty.lo).toBeCloseTo(0.9289, 4);
    const none = clusterInterval(Array.from({ length: 10 }, () => ({ passed: 0, total: 2 })))!;
    expect(none).toEqual({ rate: 0, lo: 0, hi: expect.closeTo(0.3085, 4) });
  });

  it('counts each case once, at its own rate: repeats do not add cases', () => {
    const once = clusterInterval([{ passed: 1, total: 1 }, { passed: 0, total: 1 }, { passed: 1, total: 1 }, { passed: 1, total: 1 }])!;
    const repeated = clusterInterval([{ passed: 10, total: 10 }, { passed: 0, total: 10 }, { passed: 10, total: 10 }, { passed: 10, total: 10 }])!;
    expect(repeated).toEqual(once);
    // A case answered both ways is a fraction of a success, and the rate is the mean over cases, not over attempts.
    const mixed = clusterInterval([{ passed: 1, total: 1 }, { passed: 2, total: 8 }])!;
    expect(mixed.rate).toBeCloseTo(0.625, 12);
    expect(clusterInterval([])).toBeNull();
    expect(clusterInterval([{ passed: 0, total: 0 }])).toBeNull();
  });
});

describe('a word and its interval say one thing', () => {
  it('unpaired: the one-sided p is at most 0.05 exactly when the 90% interval lies off zero', () => {
    let checked = 0;
    for (const n of [8, 12, 20, 50]) {
      for (let before = 0; before <= n; before += 1) {
        for (let after = 0; after <= n; after += 1) {
          const p = newcombeOneSidedWorse(before, n, after, n)!;
          const d90 = newcombeDifference(after, n, before, n, Z_90)!;
          expect(p <= 0.05, `n=${n} ${before}->${after} p=${p} hi=${d90.hi}`).toBe(d90.hi < 0);
          const better = newcombeOneSidedWorse(after, n, before, n)!;
          expect(better <= 0.05, `n=${n} ${before}->${after} better`).toBe(d90.lo > 0);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(3000);
  });

  it('unpaired: 45 of 50 against 38 of 50 is a regression at one-sided 5%, and the interval printed beside it excludes zero', () => {
    const p = newcombeOneSidedWorse(45, 50, 38, 50)!;
    expect(p).toBeLessThan(0.05);
    const d90 = newcombeDifference(38, 50, 45, 50, Z_90)!;
    expect(d90.hi).toBeLessThan(0);
    // The 95% interval the summary used to print beside the word.
    expect(newcombeDifference(38, 50, 45, 50)!.hi).toBeGreaterThan(0);
  });

  it('unpaired: equal rates read 0.5, an empty side reads null, and the two directions sum to one', () => {
    expect(newcombeOneSidedWorse(5, 10, 5, 10)).toBe(0.5);
    expect(newcombeOneSidedWorse(5, 0, 5, 10)).toBeNull();
    expect(newcombeOneSidedWorse(9, 10, 6, 10)! + newcombeOneSidedWorse(6, 10, 9, 10)!).toBeCloseTo(1, 9);
    expect(newcombeOneSidedWorse(10, 10, 0, 10)).toBeLessThan(0.001);
  });

  it('paired: the interval on the difference lies below zero exactly when McNemar\'s one-sided p is at most 0.05', () => {
    let checked = 0;
    for (let b = 0; b <= 14; b += 1) {
      for (let c = 0; c <= 14; c += 1) {
        const d = mcnemarDifference(b, c, 30)!;
        if (b + c === 0) {
          expect(d).toEqual({ delta: 0, lo: 0, hi: 0, significant: false });
          continue;
        }
        expect(mcnemarOneSidedWorse(b, c) <= 0.05, `b=${b} c=${c}`).toBe(d.hi < 0);
        expect(mcnemarOneSidedWorse(c, b) <= 0.05, `b=${b} c=${c} better`).toBe(d.lo > 0);
        expect(d.delta).toBeCloseTo((c - b) / (b + c + 30), 12);
        expect(d.lo).toBeLessThanOrEqual(d.delta);
        expect(d.hi).toBeGreaterThanOrEqual(d.delta);
        checked += 1;
      }
    }
    expect(checked).toBe(224);
    expect(mcnemarDifference(0, 0, 0)).toBeNull();
  });
});

describe('the detectable difference', () => {
  it('is the difference a one-sided 5% test finds four times in five, at a pass rate of one half', () => {
    expect(smallestDetectableDifference(8, 8)).toBeCloseTo(0.6217, 3);
    expect(smallestDetectableDifference(50, 50)).toBeCloseTo(0.2487, 3);
    expect(smallestDetectableDifference(1000, 1000)).toBeCloseTo(0.0556, 3);
    expect(smallestDetectableDifference(2, 2)).toBe(1);
    expect(smallestDetectableDifference(0, 8)).toBeNull();
  });

  it('holds its stated power: a true difference of that size is declared about four times in five', () => {
    // Seeded, so the same trials every run.
    let state = 20261002;
    const rng = (): number => {
      state = (state * 1664525 + 1013904223) >>> 0;
      return state / 2 ** 32;
    };
    const draw = (n: number, p: number): number => {
      let k = 0;
      for (let i = 0; i < n; i += 1) if (rng() < p) k += 1;
      return k;
    };
    const n = 100;
    const d = smallestDetectableDifference(n, n)!;
    let found = 0;
    const trials = 2000;
    for (let t = 0; t < trials; t += 1) {
      const before = draw(n, 0.5 + d / 2);
      const after = draw(n, 0.5 - d / 2);
      if (newcombeOneSidedWorse(before, n, after, n)! <= 0.05) found += 1;
    }
    expect(found / trials).toBeGreaterThan(0.74);
    expect(found / trials).toBeLessThan(0.88);
  });
});

describe('how far apart two paired runs are', () => {
  it('is symmetric, holds its point estimate, and tightens as the runs agree case by case', () => {
    const d = newcombePairedDifference(30, 6, 2, 12, Z_90)!;
    expect(d.delta).toBeCloseTo((2 - 6) / 50, 12);
    expect(d.lo).toBeLessThan(d.delta);
    expect(d.hi).toBeGreaterThan(d.delta);
    // Swapping the runs negates it.
    const swapped = newcombePairedDifference(30, 2, 6, 12, Z_90)!;
    expect(swapped.delta).toBeCloseTo(-d.delta, 12);
    expect(swapped.lo).toBeCloseTo(-d.hi, 12);
    expect(swapped.hi).toBeCloseTo(-d.lo, 12);
    // The same two pass rates with nothing in common case by case give a wider interval than with strong agreement.
    const agree = newcombePairedDifference(30, 2, 2, 16, Z_90)!;
    const disagree = newcombePairedDifference(18, 14, 14, 4, Z_90)!;
    expect(agree.hi - agree.lo).toBeLessThan(disagree.hi - disagree.lo);
    expect(newcombePairedDifference(0, 0, 0, 0)).toBeNull();
    // One changed pair in six is not a narrow interval: this is the case the conditional interval got wrong for equivalence.
    const six = newcombePairedDifference(4, 1, 0, 1, Z_90)!;
    expect(six.lo).toBeLessThan(-0.3);
  });

  it('holds its level: the 90% interval contains the true difference at least 87 times in 100, at 12, 20 and 50 pairs', () => {
    for (const n of [12, 20, 50]) {
      for (const [pBoth, pFell, pRose] of [[0.8, 0.05, 0.05], [0.6, 0.2, 0.1], [0.9, 0.06, 0.02], [0.3, 0.2, 0.2], [0.5, 0.3, 0.05]] as const) {
        const rng = mulberry32(n * 7919 + Math.round(pBoth * 100) * 31 + Math.round(pFell * 100));
        const truth = pRose - pFell;
        let held = 0;
        const trials = 2000;
        for (let t = 0; t < trials; t += 1) {
          let e = 0;
          let f = 0;
          let g = 0;
          let h = 0;
          for (let i = 0; i < n; i += 1) {
            const u = rng();
            if (u < pBoth) e += 1;
            else if (u < pBoth + pFell) f += 1;
            else if (u < pBoth + pFell + pRose) g += 1;
            else h += 1;
          }
          const d = newcombePairedDifference(e, f, g, h, Z_90)!;
          if (d.lo <= truth && truth <= d.hi) held += 1;
        }
        expect(held / trials, `n=${n} both=${pBoth} fell=${pFell} rose=${pRose}`).toBeGreaterThanOrEqual(0.87);
      }
    }
  }, 120_000);
});
