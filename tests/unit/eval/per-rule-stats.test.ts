/*
 * The per-rule statistics (D-6b, plan §4.14): the normal CDF, the one-sided
 * tests, Benjamini–Hochberg, and the seeded simulation that proves the
 * correction bites — twenty null rules, a thousand comparisons.
 */
import { describe, it, expect } from 'vitest';
import {
  benjaminiHochberg,
  mcnemarOneSidedWorse,
  mcnemarExact,
  mulberry32,
  newcombeOneSidedWorse,
  normalCdf,
  Z_90,
} from '../../../src/eval/stats.js';
import { compareRuns } from '../../../src/eval/compare.js';
import type { RunResultRow } from '../../../src/storage/sqlite-adapter.js';

describe('normalCdf', () => {
  it('matches the table at the points a reader checks', () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.959964)).toBeCloseTo(0.975, 4);
    expect(normalCdf(-1.959964)).toBeCloseTo(0.025, 4);
    expect(normalCdf(Z_90)).toBeCloseTo(0.95, 4);
    expect(normalCdf(6)).toBeCloseTo(1, 6);
    expect(normalCdf(-6)).toBeCloseTo(0, 6);
  });
});

describe('the one-sided tests', () => {
  it('McNemar one-sided worse: only the pass→fail tail, half the two-sided p at the extreme', () => {
    // 6 discordant, all pass→fail: two-sided 2·(1/64) = 0.03125; one-sided 1/64.
    expect(mcnemarOneSidedWorse(6, 0)).toBeCloseTo(1 / 64, 8);
    expect(mcnemarExact(6, 0, 0).pValue).toBeCloseTo(2 / 64, 8);
    // All the other way: no evidence of worse at all.
    expect(mcnemarOneSidedWorse(0, 6)).toBeCloseTo(1, 8);
    expect(mcnemarOneSidedWorse(0, 0)).toBe(1);
  });

  it('Newcombe one-sided worse: small when the after rate fell, near one when it rose, null on an empty side', () => {
    expect(newcombeOneSidedWorse(45, 50, 30, 50)!).toBeLessThan(0.01);
    expect(newcombeOneSidedWorse(30, 50, 45, 50)!).toBeGreaterThan(0.99);
    expect(newcombeOneSidedWorse(25, 50, 25, 50)!).toBeCloseTo(0.5, 6);
    expect(newcombeOneSidedWorse(0, 0, 1, 2)).toBeNull();
  });
});

describe('Benjamini–Hochberg', () => {
  it('the textbook example: q-values are monotone in p and never below p', () => {
    const p = [0.01, 0.04, 0.03, 0.2, 0.5];
    const q = benjaminiHochberg(p);
    expect(q).toHaveLength(5);
    for (let i = 0; i < p.length; i += 1) expect(q[i]).toBeGreaterThanOrEqual(p[i]);
    // sorted p: .01 .03 .04 .2 .5 → m·p/rank: .05 .075 .0667 .25 .5 → running min from the top: .05 .0667 .0667 .25 .5
    expect(q[0]).toBeCloseTo(0.05, 6);
    expect(q[2]).toBeCloseTo(0.0667, 3);
    expect(q[1]).toBeCloseTo(0.0667, 3);
    expect(q[3]).toBeCloseTo(0.25, 6);
    expect(q[4]).toBeCloseTo(0.5, 6);
  });

  it('a single test is unchanged; an empty family is empty', () => {
    expect(benjaminiHochberg([0.03])).toEqual([0.03]);
    expect(benjaminiHochberg([])).toEqual([]);
  });
});

/*
 * The guard that proves the correction bites (plan §4.14): twenty rules that
 * did not change, paired runs of n cases, a thousand comparisons. Without
 * correction some rule reads "worse" in a large share of comparisons; with
 * Benjamini–Hochberg the share of comparisons with any false "worse" is held
 * near α. The per-rule test is exact on a small discordant count, so the raw
 * rate is below the continuous 0.64 — the assertion is the ordering and the
 * ceiling, both derived here rather than typed.
 */
describe('twenty null rules, a thousand comparisons', () => {
  const RULES = Array.from({ length: 20 }, (_, i) => `rule_${i}`);

  function pairedRuns(rng: () => number, n: number): { before: RunResultRow[]; after: RunResultRow[] } {
    const mk = (): RunResultRow[] =>
      Array.from({ length: n }, (_, i) => {
        const failed = RULES.filter(() => rng() < 0.2);
        return {
          evalId: `${i}-${rng()}`,
          traceId: `t-${i}-${rng()}`,
          caseKey: `case-${i}`,
          agentName: 'agent',
          passed: failed.length === 0,
          failedRules: failed,
          engineVersion: '0.13.0',
          rulesetHash: 'rs',
          configHash: 'cfg',
          createdAt: '2026-09-17T00:00:00.000Z',
        };
      });
    return { before: mk(), after: mk() };
  }

  it('any-rule false "worse" is at most α after correction, and the correction lowers it', () => {
    const rng = mulberry32(20260917);
    const N = 1000;
    let rawAny = 0;
    let correctedAny = 0;
    for (let k = 0; k < N; k += 1) {
      const { before, after } = pairedRuns(rng, 60);
      const c = compareRuns('before', before, 'after', after);
      const rows = [...c.regressions, ...c.improvements];
      if (rows.some((r) => r.p !== null && r.p <= 0.05)) rawAny += 1;
      if (rows.some((r) => r.worse)) correctedAny += 1;
    }
    const raw = rawAny / N;
    const corrected = correctedAny / N;
    expect(corrected).toBeLessThanOrEqual(0.05 + 0.02);
    expect(corrected).toBeLessThan(raw);
    expect(raw).toBeGreaterThan(0.2);
  }, 120_000);
});
