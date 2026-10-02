/*
 * Does the "95% interval over cases" hold the true rate 95 times in 100?
 *
 * The interval compare_traces printed was a percentile bootstrap over
 * cases. At 10 cases and a true pass rate of 95% it held the true rate two
 * times in five, and whenever every case passed it had no width at all.
 * This measures the interval that replaced it (clusterInterval) the way it
 * will be used: few cases, rates near 1, a case asked once or several
 * times, and cases that differ in how hard they are.
 *
 * Seeded, so the trials are the same on every run and the numbers below do
 * not flicker. The bar is 93% for a nominal 95%: the simulation's own
 * sampling error at 2,000 trials is about one point.
 */
import { describe, expect, it } from 'vitest';
import { beta, clusterInterval, fnv1a, mulberry32, percentile95 } from '../../../src/eval/stats.js';

/** The interval this replaced, as it was: resample the cases with replacement and read the 2.5th and 97.5th percentiles of the rate. */
function clusterBootstrap(cases: ReadonlyArray<{ passed: number; total: number }>, seed: string, draws: number): { lo: number; hi: number } {
  const rateOf = (sample: ReadonlyArray<{ passed: number; total: number }>): number => sample.reduce((p, c) => p + c.passed, 0) / sample.reduce((t, c) => t + c.total, 0);
  const rng = mulberry32(fnv1a(seed));
  const rates: number[] = [];
  for (let d = 0; d < draws; d += 1) rates.push(rateOf(cases.map(() => cases[Math.floor(rng() * cases.length)])));
  const [lo, hi] = percentile95(rates);
  return { lo, hi };
}

const TRIALS = 2000;

/** One run: `n` cases, each asked `m` times, the cases' own pass rates spread around `p`. */
function simulate(n: number, m: number, p: number, rng: () => number): Array<{ passed: number; total: number }> {
  const cases: Array<{ passed: number; total: number }> = [];
  for (let i = 0; i < n; i += 1) {
    // Asked once, a case passes with the population rate. Asked several times, it has a difficulty of its own (Beta with mean p).
    const own = m === 1 ? p : beta(p * 8, (1 - p) * 8, rng);
    let passed = 0;
    for (let j = 0; j < m; j += 1) if (rng() < own) passed += 1;
    cases.push({ passed, total: m });
  }
  return cases;
}

function coverage(n: number, m: number, p: number, interval: (cases: Array<{ passed: number; total: number }>, t: number) => { lo: number; hi: number } | null): { held: number; zeroWidth: number } {
  const rng = mulberry32(n * 100_003 + m * 1_009 + Math.round(p * 1000));
  let held = 0;
  let zeroWidth = 0;
  for (let t = 0; t < TRIALS; t += 1) {
    const i = interval(simulate(n, m, p, rng), t)!;
    if (i.lo <= p && p <= i.hi) held += 1;
    if (i.hi - i.lo === 0) zeroWidth += 1;
  }
  return { held: held / TRIALS, zeroWidth: zeroWidth / TRIALS };
}

describe('the interval over cases holds its level', () => {
  const rates = [0.5, 0.8, 0.9, 0.95, 0.99];
  for (const n of [10, 20, 50]) {
    for (const m of [1, 5]) {
      it(`${n} cases asked ${m === 1 ? 'once' : `${m} times`}: holds the true rate at least 93 times in 100 at every rate from 50% to 99%, and is never zero-width`, () => {
        for (const p of rates) {
          const c = coverage(n, m, p, (cases) => clusterInterval(cases));
          expect(c.held, `n=${n} m=${m} p=${p}`).toBeGreaterThanOrEqual(0.93);
          expect(c.zeroWidth, `n=${n} m=${m} p=${p}`).toBe(0);
        }
      }, 120_000);
    }
  }

  it('the bootstrap it replaced did not: at 10 cases and a 95% rate it held the true rate under half the time, mostly with no width', () => {
    const c = coverage(10, 1, 0.95, (cases, t) => clusterBootstrap(cases, `trial-${t}`, 400));
    expect(c.held).toBeLessThan(0.5);
    expect(c.zeroWidth).toBeGreaterThan(0.5);
  }, 120_000);
});
