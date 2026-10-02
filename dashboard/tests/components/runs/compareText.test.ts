/*
 * The comparison vocabulary: the verdict word from the tool's booleans,
 * and the number formats.
 */
import { describe, it, expect } from 'vitest';
import {
  EQUIVALENCE_TEXT,
  METHOD_TEXT,
  PER_RULE_TEXT,
  VERDICT_TEXT,
  comparisonVerdict,
  fmtDifference,
  fmtEquivalence,
  fmtFailedOfJudged,
  fmtFell,
  fmtP,
  fmtQ,
  fmtRate,
  fmtSmallestDetectable,
} from '../../../src/components/runs/compareText';

describe('compareText', () => {
  it('the verdict word follows the tool: not compared, worse, better, else not distinguishable', () => {
    const base = { comparable: true, forced: false, worse: false, better: false, method: 'paired-mcnemar' as const };
    expect(comparisonVerdict(base)).toBe('same');
    expect(comparisonVerdict({ ...base, worse: true })).toBe('worse');
    expect(comparisonVerdict({ ...base, better: true })).toBe('better');
    expect(comparisonVerdict({ ...base, comparable: false })).toBe('incomparable');
    expect(comparisonVerdict({ ...base, comparable: false, forced: true, worse: true })).toBe('worse');
    // A rise the tool would not call better, because the second run was judged on less.
    expect(comparisonVerdict({ ...base, improvement_withheld: true, call: 'undetermined' })).toBe('withheld');
    expect(comparisonVerdict({ ...base, call: 'equivalent' })).toBe('equivalent');
    expect(comparisonVerdict({ ...base, call: 'undetermined' })).toBe('same');
  });

  it('every method and every verdict has a sentence', () => {
    for (const s of [...Object.values(METHOD_TEXT), ...Object.values(VERDICT_TEXT)]) expect(s).toMatch(/\.$/);
    expect(Object.keys(METHOD_TEXT).sort()).toEqual(['none', 'paired-mcnemar', 'unpaired-newcombe']);
  });

  it('formats', () => {
    expect(fmtRate(0.8, { lo: 0.49, hi: 0.943 })).toBe('80.0% [49.0%, 94.3%]');
    expect(fmtRate(null, null)).toBe('no evaluations');
    expect(fmtDifference({ delta: -0.1, lo: -0.35, hi: 0.15, significant: false })).toBe('-10.0 pts [-35.0, 15.0]');
    expect(fmtDifference(null)).toBe('—');
    // Paired: the point alone; the interval the test read is on the share that fell.
    expect(fmtDifference({ delta: -0.1, lo: -0.1, hi: -0.02, significant: true }, true)).toBe('-10.0 pts');
    expect(fmtFell({ method: 'mcnemar-exact', b: 6, c: 0, concordant: 44, pairs: 50, p_value: 0.031, significant: true, fell: { share: 1, lo: 0.607, hi: 1 } })).toBe('6 of 6 changed cases fell [60.7%, 100.0%]');
    expect(fmtFell({ method: 'mcnemar-exact', b: 0, c: 0, concordant: 12, pairs: 12, p_value: 1, significant: false, fell: null })).toBe('no case changed');
    expect(fmtFailedOfJudged(3, 20)).toBe('3 of 20');
    expect(fmtFailedOfJudged(0, 0)).toBe('not run');
    expect(fmtFailedOfJudged(3, undefined)).toBe('3');
    expect(fmtP(0.0004)).toBe('p < 0.001');
    expect(fmtP(0.25)).toBe('p = 0.250');
    expect(fmtSmallestDetectable(0.42)).toBe('42.0 pts');
    expect(fmtSmallestDetectable(null)).toBe('—');
  });

  it('q prints like p, the equivalence chip names the margin, and the per-rule and equivalence sentences end', () => {
    expect(fmtQ(0.0004)).toBe('q < 0.001');
    expect(fmtQ(0.0667)).toBe('q = 0.067');
    expect(fmtQ(null)).toBe('—');
    expect(fmtEquivalence({ margin: 0.12, margin_source: 'caller', interval: { lo: -0.1, hi: 0.05 }, holds: true })).toBe('interval inside ±12.0 pts');
    expect(fmtEquivalence({ margin: 0.05, margin_source: 'caller', interval: { lo: -0.1, hi: 0.05 }, holds: false })).toBe('interval reaches outside ±5.0 pts');
    expect(fmtEquivalence(null)).toBe('—');
    for (const s of [PER_RULE_TEXT, ...Object.values(EQUIVALENCE_TEXT)]) expect(s).toMatch(/\.$/);
    expect(PER_RULE_TEXT).toContain('Benjamini–Hochberg');
  });
});
