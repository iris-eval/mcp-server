/*
 * The comparison vocabulary (D-5): the verdict word from the tool's booleans,
 * and the number formats.
 */
import { describe, it, expect } from 'vitest';
import { METHOD_TEXT, VERDICT_TEXT, comparisonVerdict, fmtDifference, fmtP, fmtRate, fmtSmallestDetectable } from '../../../src/components/runs/compareText';

describe('compareText (D-5)', () => {
  it('the verdict word follows the tool: not compared, worse, better, else not distinguishable', () => {
    const base = { comparable: true, forced: false, worse: false, better: false, method: 'paired-mcnemar' as const };
    expect(comparisonVerdict(base)).toBe('same');
    expect(comparisonVerdict({ ...base, worse: true })).toBe('worse');
    expect(comparisonVerdict({ ...base, better: true })).toBe('better');
    expect(comparisonVerdict({ ...base, comparable: false })).toBe('incomparable');
    expect(comparisonVerdict({ ...base, comparable: false, forced: true, worse: true })).toBe('worse');
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
    expect(fmtP(0.0004)).toBe('p < 0.001');
    expect(fmtP(0.25)).toBe('p = 0.250');
    expect(fmtSmallestDetectable(0.42)).toBe('42.0 pts');
    expect(fmtSmallestDetectable(null)).toBe('—');
  });
});
