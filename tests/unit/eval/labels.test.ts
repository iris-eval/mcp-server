/*
 * Labels on the user's own traffic — the arithmetic.
 *
 * Local precision is right / (right + wrong) with a Wilson interval and is
 * in force at LOCAL_LABEL_MIN; the prior estimate is f · p̂ / sens with the
 * interval that follows from p̂'s; the sampling suggestion is the
 * traffic-weighted narrowing of the interval; the evidence signature names
 * what a rule found so two fires of one pattern are one issue.
 */
import { describe, expect, it } from 'vitest';
import {
  LOCAL_LABEL_MIN,
  estimatedPrior,
  evidenceSignature,
  halfwidthAt,
  issueKey,
  localPrecision,
  samplingSuggestion,
} from '../../../src/eval/labels.js';
import { wilson } from '../../../src/eval/stats.js';

describe('local precision', () => {
  it('is right / (right + wrong) with the Wilson interval, and null below one label', () => {
    const none = localPrecision({ ruleName: 'r', right: 0, wrong: 0 });
    expect(none.n).toBe(0);
    expect(none.precision).toBeNull();
    expect(none.local).toBe(false);

    const some = localPrecision({ ruleName: 'r', right: 3, wrong: 1 });
    expect(some.n).toBe(4);
    expect(some.precision!.point).toBe(0.75);
    const w = wilson(3, 4)!;
    expect(some.precision!.lo).toBe(w.lo);
    expect(some.precision!.hi).toBe(w.hi);
  });

  it('is in force at exactly LOCAL_LABEL_MIN labels, not one fewer', () => {
    expect(LOCAL_LABEL_MIN).toBe(20);
    expect(localPrecision({ ruleName: 'r', right: 10, wrong: 9 }).local).toBe(false);
    expect(localPrecision({ ruleName: 'r', right: 10, wrong: 10 }).local).toBe(true);
    expect(localPrecision({ ruleName: 'r', right: 0, wrong: 20 }).local).toBe(true);
  });

  it('the half-width narrows with n and is half a point wide at n = 0', () => {
    expect(halfwidthAt(0.5, 0)).toBe(0.5);
    expect(halfwidthAt(0.5, 10)).toBeGreaterThan(halfwidthAt(0.5, 20));
    expect(halfwidthAt(0.5, 20)).toBeGreaterThan(halfwidthAt(0.5, 200));
  });
});

describe('the estimated prior', () => {
  const twenty = localPrecision({ ruleName: 'no_stub_output', right: 12, wrong: 8 });

  it('is f · p̂ / sens, with the interval from p̂’s Wilson interval', () => {
    const e = estimatedPrior(twenty, 0.25, 0.8)!;
    expect(e.pi).toBeCloseTo((0.25 * 0.6) / 0.8, 6);
    expect(e.lo).toBeCloseTo((0.25 * twenty.precision!.lo) / 0.8, 6);
    expect(e.hi).toBeCloseTo((0.25 * twenty.precision!.hi) / 0.8, 6);
    expect(e.ruleName).toBe('no_stub_output');
    expect(e.fireRate).toBe(0.25);
    expect(e.sensitivity).toBe(0.8);
  });

  it('is clamped to (0.01, 0.99)', () => {
    expect(estimatedPrior(twenty, 1, 0.1)!.pi).toBe(0.99);
    expect(estimatedPrior(localPrecision({ ruleName: 'r', right: 0, wrong: 20 }), 0.5, 0.9)!.pi).toBe(0.01);
  });

  it('is null below LOCAL_LABEL_MIN, with no fires, or with no published sensitivity', () => {
    expect(estimatedPrior(localPrecision({ ruleName: 'r', right: 10, wrong: 9 }), 0.25, 0.8)).toBeNull();
    expect(estimatedPrior(twenty, 0, 0.8)).toBeNull();
    expect(estimatedPrior(twenty, 0.25, 0)).toBeNull();
  });
});

describe('the sampling suggestion', () => {
  it('names the rule whose next label buys the most traffic-weighted narrowing, and says so in words', () => {
    const s = samplingSuggestion([
      { precision: localPrecision({ ruleName: 'rare', right: 0, wrong: 0 }), fireRate: 0.01 },
      { precision: localPrecision({ ruleName: 'common', right: 2, wrong: 2 }), fireRate: 0.3 },
      { precision: localPrecision({ ruleName: 'settled', right: 150, wrong: 50 }), fireRate: 0.5 },
    ])!;
    // Four labels on a rule that fires on 30% of traffic beats none on one that fires on 1%, and beats 200 on one that fires on 50%.
    expect(s.ruleName).toBe('common');
    expect(s.n).toBe(4);
    expect(s.fireRate).toBe(0.3);
    expect(s.sentence).toBe(`label a common fire next: 4 labelled, ±${s.halfwidthPoints} points, fires on 30% of your traffic`);
  });

  it('is null when no rule fires', () => {
    expect(samplingSuggestion([{ precision: localPrecision({ ruleName: 'r', right: 0, wrong: 0 }), fireRate: 0 }])).toBeNull();
    expect(samplingSuggestion([])).toBeNull();
  });
});

describe('the evidence signature and the issue key', () => {
  it('names what the rule found, by evidence type', () => {
    expect(evidenceSignature({ evidence: [{ type: 'pattern', name: 'marker TODO', count: 2 }], message: 'x' })).toBe('pattern:marker TODO');
    expect(evidenceSignature({ evidence: [{ type: 'toolCall', index: 0, toolName: 'search', label: 'returned an error' }], message: 'x' })).toBe('tool:search:returned an error');
    expect(evidenceSignature({ evidence: [{ type: 'count', stat: 'cost_usd', unit: 'USD', value: 1.2, threshold: 0.5 }], message: 'x' })).toBe('count:cost_usd');
    expect(evidenceSignature({ evidence: [{ type: 'span', source: 'output', start: 0, end: 4, label: 'marker TODO' }], message: 'x' })).toBe('span:marker TODO');
    expect(evidenceSignature({ evidence: [{ type: 'citation', url: 'https://x', status: 'dead' }], message: 'x' })).toBe('citation:dead');
  });

  it('falls back to the message with its numbers masked, so "3 sentences" and "7 sentences" are one issue', () => {
    expect(evidenceSignature({ evidence: [], message: 'Output has 3 sentences, 5 needed' })).toBe('message:Output has # sentences, # needed');
    expect(evidenceSignature({ message: 'Output has 7 sentences, 5 needed' })).toBe('message:Output has # sentences, # needed');
  });

  it('the key is twelve hex characters of sha256(rule|signature), stable and distinct by rule', () => {
    const a = issueKey('no_stub_output', 'pattern:marker TODO');
    expect(a).toMatch(/^[0-9a-f]{12}$/);
    expect(issueKey('no_stub_output', 'pattern:marker TODO')).toBe(a);
    expect(issueKey('no_pii', 'pattern:marker TODO')).not.toBe(a);
    expect(issueKey('no_stub_output', 'pattern:marker FIXME')).not.toBe(a);
  });
});
