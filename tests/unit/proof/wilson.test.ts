import { describe, it, expect } from 'vitest';
import { wilson, Z_95 } from '../../../proof/judge/lib/wilson.js';
import { summarise, tally, emptyConfusion } from '../../../proof/judge/lib/metrics.js';

// Reference values computed independently (SciPy / by hand) for the Wilson
// score interval at z = 1.959963984540054 (two-sided 95%). If the runner's
// intervals ever drift from these, the published CI widths are wrong.
const REFERENCE: Array<[number, number, number, number]> = [
  // k, n, lo, hi
  [0, 10, 0.0, 0.277533],
  [10, 10, 0.722467, 1.0],
  [5, 10, 0.236593, 0.763407],
  [7, 10, 0.396778, 0.892209],
  [1, 1, 0.206549, 1.0],
  [0, 1, 0.0, 0.793451],
  [30, 36, 0.681092, 0.921296],
  [17, 18, 0.742427, 0.990125],
  [95, 100, 0.88825, 0.978456],
];

describe('wilson', () => {
  it('matches known reference values to 5 decimals', () => {
    for (const [k, n, lo, hi] of REFERENCE) {
      const ci = wilson(k, n);
      expect(ci, `wilson(${k}, ${n})`).not.toBeNull();
      expect(ci!.lo).toBeCloseTo(lo, 5);
      expect(ci!.hi).toBeCloseTo(hi, 5);
    }
  });

  it('uses the documented 95% z by default', () => {
    expect(Z_95).toBeCloseTo(1.959963984540054, 12);
    // Passing z explicitly reproduces the default.
    expect(wilson(5, 10, Z_95)).toEqual(wilson(5, 10));
  });

  it('stays inside [0, 1] at the boundaries', () => {
    const lo = wilson(0, 25)!;
    expect(lo.lo).toBeCloseTo(0, 12); // clamped to ~0 within float epsilon
    expect(lo.hi).toBeGreaterThan(0);
    const hi = wilson(25, 25)!;
    expect(hi.hi).toBeCloseTo(1, 12);
    expect(hi.lo).toBeLessThan(1);
  });

  it('returns null for n = 0', () => {
    expect(wilson(0, 0)).toBeNull();
  });

  it('rejects malformed pairs', () => {
    expect(() => wilson(3, 2)).toThrow(RangeError);
    expect(() => wilson(-1, 5)).toThrow(RangeError);
    expect(() => wilson(1.5, 5)).toThrow(TypeError);
  });
});

describe('confusion summarise', () => {
  it('computes precision, recall and F1 for a known matrix', () => {
    const c = emptyConfusion();
    // 8 actual positives: 6 caught (tp), 2 missed (fn).
    for (let i = 0; i < 6; i++) tally(c, true, true);
    for (let i = 0; i < 2; i++) tally(c, true, false);
    // 10 actual negatives: 1 wrongly flagged (fp), 9 correct (tn).
    tally(c, false, true);
    for (let i = 0; i < 9; i++) tally(c, false, false);
    const s = summarise(c);
    expect(s).toMatchObject({ tp: 6, fp: 1, fn: 2, tn: 9, n: 18 });
    // summarise() rounds the published metrics to 4 decimals on purpose.
    expect(s.precision).toBeCloseTo(6 / 7, 3);
    expect(s.recall).toBeCloseTo(6 / 8, 4);
    expect(s.f1).toBeCloseTo((2 * (6 / 7) * (6 / 8)) / (6 / 7 + 6 / 8), 4);
    expect(s.ci95.precision).not.toBeNull();
  });

  it('returns null metrics when a denominator is empty', () => {
    const s = summarise(emptyConfusion());
    expect(s.precision).toBeNull();
    expect(s.recall).toBeNull();
    expect(s.f1).toBeNull();
    expect(s.ci95.precision).toBeNull();
  });
});
