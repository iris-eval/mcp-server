/*
 * The statistics behind compare_runs (arc 5).
 *
 * These numbers get shown to a person deciding whether to ship, so the
 * tests check them against values computed independently rather than
 * against whatever the implementation happens to produce. Acceptance row C1
 * is the first block: a hand-computed Newcombe interval.
 *
 * The row that matters most is the LAST one. A comparison that always
 * returns a verdict is more satisfying and less true, and the whole design
 * turns on being able to say "I cannot tell".
 */
import { describe, expect, it } from 'vitest';
import {
  clusterBootstrap,
  mcnemarExact,
  newcombeDifference,
  smallestDetectableDifference,
  wilson,
  Z_95,
} from '../../../src/eval/stats.js';

describe('Wilson, owned by src/ so the shipped server can use it', () => {
  it('matches the published interval for a textbook case', () => {
    // Wilson (1927) worked example shape: 35 of 36.
    const w = wilson(35, 36)!;
    expect(w.lo).toBeCloseTo(0.8583, 3);
    expect(w.hi).toBeCloseTo(0.9951, 3);
  });

  it('stays inside [0, 1] where the normal approximation does not', () => {
    const w = wilson(36, 36)!;
    expect(w.hi).toBeLessThanOrEqual(1);
    expect(w.lo).toBeGreaterThan(0.88);
    const zero = wilson(0, 20)!;
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeLessThan(0.17);
  });

  it('returns null at n = 0 and throws on a malformed pair', () => {
    expect(wilson(0, 0)).toBeNull();
    expect(() => wilson(5, 3)).toThrow(RangeError);
    expect(() => wilson(1.5, 3)).toThrow(TypeError);
  });
});

describe('C1 — the two-run difference is the interval a statistician computes by hand', () => {
  it('Newcombe hybrid score on 18/20 versus 12/20', () => {
    /*
     * Computed independently from Newcombe (1998) method 10:
     *   p1 = 0.9,  Wilson(18,20) = [0.6990, 0.9721]
     *   p2 = 0.6,  Wilson(12,20) = [0.3866, 0.7812]
     *   delta = 0.3
     *   lo = delta - sqrt((p1-l1)^2 + (u2-p2)^2)
     *      = 0.3 - sqrt(0.2010^2 + 0.1812^2) = 0.3 - 0.2706 = 0.0294
     *   hi = delta + sqrt((u1-p1)^2 + (p2-l2)^2)
     *      = 0.3 + sqrt(0.0721^2 + 0.2134^2) = 0.3 + 0.2252 = 0.5252
     */
    const d = newcombeDifference(18, 20, 12, 20)!;
    expect(d.delta).toBeCloseTo(0.3, 10);
    expect(d.lo).toBeCloseTo(0.0294, 3);
    expect(d.hi).toBeCloseTo(0.5252, 3);
    expect(d.significant).toBe(true);
  });

  it('is built from each proportion\'s own Wilson limits', () => {
    // The property that distinguishes Newcombe from the textbook interval:
    // the bounds are asymmetric about delta wherever the rates are.
    const d = newcombeDifference(19, 20, 10, 20)!;
    const w1 = wilson(19, 20)!;
    const w2 = wilson(10, 20)!;
    expect(d.lo).toBeCloseTo(d.delta - Math.hypot(19 / 20 - w1.lo, w2.hi - 10 / 20), 10);
    expect(d.hi).toBeCloseTo(d.delta + Math.hypot(w1.hi - 19 / 20, 10 / 20 - w2.lo), 10);
  });

  it('never reports a difference outside [-1, 1], where the normal approximation does', () => {
    const d = newcombeDifference(20, 20, 0, 20)!;
    expect(d.lo).toBeGreaterThanOrEqual(-1);
    expect(d.hi).toBeLessThanOrEqual(1);
  });

  it('returns null when either run is empty, rather than a difference from nothing', () => {
    expect(newcombeDifference(0, 0, 5, 10)).toBeNull();
    expect(newcombeDifference(5, 10, 0, 0)).toBeNull();
  });
});

describe('C3 — McNemar exact, on the pairs that disagree', () => {
  it('uses only the discordant pairs, because the agreeing ones carry no information', () => {
    // 10 discordant one way, 1 the other: a clear regression.
    const r = mcnemarExact(10, 1, 89);
    expect(r.pairs).toBe(100);
    expect(r.concordant).toBe(89);
    expect(r.pValue).toBeCloseTo(0.0117, 3);
    expect(r.significant).toBe(true);
  });

  it('a balanced split is not evidence of anything', () => {
    const r = mcnemarExact(5, 5, 40);
    expect(r.pValue).toBe(1);
    expect(r.significant).toBe(false);
  });

  it('no discordant pairs means no evidence, not a perfect score', () => {
    const r = mcnemarExact(0, 0, 30);
    expect(r.pValue).toBe(1);
    expect(r.significant).toBe(false);
    expect(r.pairs).toBe(30);
  });

  it('sees a difference an unpaired test of the same data would miss', () => {
    /*
     * The reason pairing is worth carrying a case key for. 44 of 50 against
     * 38 of 50: unpaired the interval is [-0.033, 0.269] and straddles zero,
     * so the honest answer is "cannot tell". Paired, the same six-case gap
     * is six discordant cases that ALL went the same way, p = 0.031, and
     * that is decisive. Identical data, and only the pairing sees it.
     */
    const unpaired = newcombeDifference(44, 50, 38, 50)!;
    expect(unpaired.significant).toBe(false);
    expect(unpaired.lo).toBeLessThan(0);
    // Same six-case gap, but every discordant case went the same way.
    const paired = mcnemarExact(6, 0, 44);
    expect(paired.pValue).toBeCloseTo(0.0313, 3);
    expect(paired.significant).toBe(true);
  });
});

describe('repeats of one case are one question, not many', () => {
  it('the cluster bootstrap resamples CASES, so repeats cannot shrink the interval', () => {
    /*
     * Five questions, asked ten times each. Pooling them would claim n = 50
     * and report an interval built on fifty independent observations, which
     * is a claim the data never made: an agent that fails one hard question
     * ten times has told you about one question.
     */
    const cases = [
      { passed: 10, total: 10 },
      { passed: 8, total: 10 },
      { passed: 5, total: 10 },
      { passed: 9, total: 10 },
      { passed: 2, total: 10 },
    ];
    const b = clusterBootstrap(cases, 'seed-a')!;
    expect(b.rate).toBeCloseTo(0.68, 10);
    const pooled = wilson(34, 50)!;
    // Twice as wide as the pooled interval, and that width is the honesty.
    expect(b.hi - b.lo).toBeGreaterThan(2 * (pooled.hi - pooled.lo));
  });

  it('five identical cases carry no between-case variance, and the interval says so', () => {
    // Not a degenerate result: five cases that behave identically really do
    // pin the rate. The width is zero because the resampling has nothing to
    // vary, which is the correct reading of that evidence.
    const same = Array.from({ length: 5 }, () => ({ passed: 8, total: 10 }));
    const b = clusterBootstrap(same, 'seed-a')!;
    expect(b.rate).toBeCloseTo(0.8, 10);
    expect(b.hi - b.lo).toBe(0);
  });

  it('is seeded, so the same input always gives the same interval', () => {
    const cases = [{ passed: 3, total: 5 }, { passed: 5, total: 5 }, { passed: 1, total: 5 }];
    expect(clusterBootstrap(cases, 'k')).toEqual(clusterBootstrap(cases, 'k'));
  });

  it('returns null when there is nothing to resample', () => {
    expect(clusterBootstrap([], 's')).toBeNull();
    expect(clusterBootstrap([{ passed: 0, total: 0 }], 's')).toBeNull();
  });
});

describe('C6 — not enough evidence is an answer, and it says how much would be enough', () => {
  it('six cases against six cannot see a one-case difference', () => {
    const d = newcombeDifference(5, 6, 4, 6)!;
    expect(d.significant).toBe(false);
  });

  it('reports the smallest drop this much data could have detected', () => {
    const small = smallestDetectableDifference(6, 6)!;
    const large = smallestDetectableDifference(500, 500)!;
    // The number that turns a shrug into an instruction: run more cases.
    expect(small).toBeGreaterThan(0.4);
    expect(large).toBeLessThan(0.07);
    expect(small).toBeGreaterThan(large);
  });

  it('has no answer when there is no data', () => {
    expect(smallestDetectableDifference(0, 10)).toBeNull();
  });

  it('the significance flag is the ONLY thing that licenses the word worse', () => {
    // Every direction claim in the tool reads this flag, so it is checked
    // here rather than trusted at the call sites.
    expect(newcombeDifference(10, 10, 0, 10)!.significant).toBe(true);
    expect(newcombeDifference(6, 10, 5, 10)!.significant).toBe(false);
    expect(newcombeDifference(5, 10, 5, 10)!.significant).toBe(false);
  });
});

describe('z is a parameter, not a constant nobody can move', () => {
  it('a wider confidence demands a wider interval', () => {
    const at95 = newcombeDifference(18, 20, 12, 20, Z_95)!;
    const at99 = newcombeDifference(18, 20, 12, 20, 2.5758293035489)!;
    expect(at99.hi - at99.lo).toBeGreaterThan(at95.hi - at95.lo);
  });
});
