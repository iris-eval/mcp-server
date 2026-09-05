/*
 * Intervals beyond Wilson: the Dirichlet credible interval stays honest at
 * zero errors, Newcombe matches a reference, calibration arithmetic is
 * right on a known table.
 */
import { describe, expect, it } from 'vitest';
import { calibration, credibleIntervals, gammaVariate, newcombeDifference } from '../../proof/lib/intervals.js';
import { mulberry32, fnv1a } from '../../proof/lib/materialise.js';

describe('Dirichlet credible intervals', () => {
  it('a zero-error family gets an F1 lower bound below 1, deterministic across runs', () => {
    const a = credibleIntervals({ tp: 13, fp: 0, fn: 0, tn: 16 }, 'min_output_length');
    const b = credibleIntervals({ tp: 13, fp: 0, fn: 0, tn: 16 }, 'min_output_length');
    expect(a).toEqual(b);
    expect(a.f1![0]).toBeLessThan(1);
    expect(a.f1![0]).toBeGreaterThan(0.75);
    expect(a.f1![1]).toBeGreaterThan(0.99); // the Dirichlet's half-count prior keeps every draw a hair below 1
    expect(a.precision![0]).toBeLessThan(1);
    expect(a.recall![0]).toBeLessThan(1);
  });

  it('brackets the point estimate on a mixed family and stays inside [0, 1]', () => {
    const c = { tp: 34, fp: 5, fn: 11, tn: 40 };
    const i = credibleIntervals(c, 'no_pii');
    const precision = c.tp / (c.tp + c.fp);
    const recall = c.tp / (c.tp + c.fn);
    expect(i.precision![0]).toBeLessThan(precision);
    expect(i.precision![1]).toBeGreaterThan(precision);
    expect(i.recall![0]).toBeLessThan(recall);
    expect(i.recall![1]).toBeGreaterThan(recall);
    for (const k of ['precision', 'recall', 'f1'] as const) {
      expect(i[k]![0]).toBeGreaterThanOrEqual(0);
      expect(i[k]![1]).toBeLessThanOrEqual(1);
    }
  });

  it('is null where the rate has no denominator', () => {
    expect(credibleIntervals({ tp: 0, fp: 0, fn: 0, tn: 10 }, 'x').precision).toBeNull();
    expect(credibleIntervals({ tp: 0, fp: 0, fn: 0, tn: 10 }, 'x').recall).toBeNull();
    expect(credibleIntervals({ tp: 0, fp: 0, fn: 0, tn: 0 }, 'x').f1).toBeNull();
  });

  it('the gamma variate has the right mean', () => {
    const rng = mulberry32(fnv1a('gamma-test'));
    for (const shape of [0.5, 2, 7.5]) {
      let sum = 0;
      const n = 20_000;
      for (let i = 0; i < n; i++) sum += gammaVariate(shape, rng);
      expect(Math.abs(sum / n - shape) / shape).toBeLessThan(0.05);
    }
  });
});

describe('Newcombe difference', () => {
  it('matches the reference for 56/70 vs 48/80 (Newcombe 1998, method 10)', () => {
    const d = newcombeDifference(56, 70, 48, 80)!;
    expect(d.delta).toBeCloseTo(0.2, 4);
    expect(d.lo).toBeCloseTo(0.0524, 2);
    expect(d.hi).toBeCloseTo(0.3339, 2);
  });
  it('an interval that includes zero when the proportions are close', () => {
    const d = newcombeDifference(30, 50, 28, 50)!;
    expect(d.lo).toBeLessThan(0);
    expect(d.hi).toBeGreaterThan(0);
  });
  it('is null without trials', () => {
    expect(newcombeDifference(0, 0, 3, 5)).toBeNull();
  });
});

describe('calibration', () => {
  it('Brier and ECE on a known table', () => {
    const c = calibration([
      { p: 0.9, bad: true },
      { p: 0.9, bad: true },
      { p: 0.1, bad: false },
      { p: 0.1, bad: true },
    ])!;
    expect(c.n).toBe(4);
    expect(c.brier).toBeCloseTo((0.01 + 0.01 + 0.01 + 0.81) / 4, 4);
    // bins: [0.1,0.2) holds two with mean 0.1 and observed 0.5 → |0.4| weighted 0.5; [0.9,1] holds two, mean 0.9, observed 1 → 0.1 weighted 0.5
    expect(c.ece).toBeCloseTo(0.25, 4);
    expect(c.bins.filter((b) => b.n > 0).length).toBe(2);
  });
  it('is null on no pairs', () => {
    expect(calibration([])).toBeNull();
  });
});
