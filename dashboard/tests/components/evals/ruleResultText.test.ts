/*
 * The vocabulary table: every kind, role and skip class has a sentence;
 * every evidence type and every uncertainty basis has a short form.
 */
import { describe, it, expect } from 'vitest';
import {
  KIND_TEXT,
  ROLE_TEXT,
  SKIP_CLASS_TEXT,
  describeEvidence,
  describeUncertainty,
  isPreStamp,
  ruleState,
} from '../../../src/components/evals/ruleResultText';
import type { Evidence } from '../../../src/api/types';

describe('ruleResultText', () => {
  it('every kind, role and skip class has its own sentence, ending in a full stop', () => {
    const all = [...Object.values(KIND_TEXT), ...Object.values(ROLE_TEXT), ...Object.values(SKIP_CLASS_TEXT)];
    expect(all).toHaveLength(6 + 4 + 3);
    for (const s of all) expect(s).toMatch(/\.$/);
    expect(new Set(all).size).toBe(all.length);
  });

  it('state: skipped wins over passed', () => {
    expect(ruleState({ passed: true, skipped: true })).toBe('skipped');
    expect(ruleState({ passed: true })).toBe('passed');
    expect(ruleState({ passed: false })).toBe('failed');
  });

  it('evidence: each type has a short form; a span is quoted only when its text is at hand', () => {
    const cases: Array<[Evidence, string]> = [
      [{ type: 'span', source: 'output', start: 0, end: 5, label: 'stub' }, 'output[0–5] · stub'],
      [{ type: 'pattern', name: 'api_key', count: 2 }, 'pattern api_key ×2'],
      [{ type: 'toolCall', index: 1, toolName: 'fetch', label: 'repeat' }, 'call #1 fetch · repeat'],
      [{ type: 'citation', url: 'https://x.test/a', status: 'dead' }, 'https://x.test/a · dead'],
      [{ type: 'count', stat: 'cost', unit: 'usd', value: 1.33, threshold: 0.1, thresholdSource: 'default' }, 'cost 1.33 usd (threshold 0.1, default)'],
      [{ type: 'count', stat: 'steps', unit: 'n', value: 7 }, 'steps 7 n'],
      [{ type: 'sample', score: 0.4, rationaleHash: 'abc' }, 'sample · score 0.4 · rationaleHash abc'],
    ];
    for (const [e, text] of cases) expect(describeEvidence(e).text).toBe(text);

    const span: Evidence = { type: 'span', source: 'tool_outputs[1]', start: 2, end: 9, label: 'secret' };
    expect(describeEvidence(span).quote).toBeUndefined();
    expect(describeEvidence(span, { toolOutputs: ['', 'a secret   token'] }).quote).toBe('secret');
    expect(describeEvidence(span, { output: 'irrelevant' }).quote).toBeUndefined();
  });

  it('a long quote is cut with an ellipsis and collapsed to one line', () => {
    const text = 'x'.repeat(50) + '\n\n' + 'y'.repeat(200);
    const q = describeEvidence({ type: 'span', source: 'output', start: 0, end: 252, label: 'long' }, { output: text }).quote!;
    expect(q.length).toBe(140);
    expect(q.endsWith('…')).toBe(true);
    expect(q).not.toMatch(/\n/);
  });

  it('uncertainty: each basis has a label and a sentence, and the interval prints to two places', () => {
    const corpus = { n: 141, tp: 20, fp: 8, fn: 5, tn: 108, version: 'v', release: '0.13.0', labelling: 'same-model' as const };
    const prior = { pi: 0.05, source: 'default' as const };
    const fired = describeUncertainty({ basis: 'published_accuracy', fired: true, ppv: { point: 0.7123, lo: 0.58, hi: 0.82 }, prior, corpus })!;
    expect(fired.label).toBe('PPV 0.71 [0.58, 0.82]');
    expect(fired.sentence).toContain('71% of the time');
    expect(fired.sentence).toContain('141 labelled cases');
    const quiet = describeUncertainty({ basis: 'published_accuracy', fired: false, missRate: { point: 0.2, lo: 0.1, hi: 0.3 }, prior, corpus })!;
    expect(quiet.label).toBe('miss rate 0.20 [0.10, 0.30]');
    expect(quiet.sentence).toContain('slips past 20% of the time');
    expect(describeUncertainty({ basis: 'policy' })!.sentence).toContain('no error rate');
    expect(describeUncertainty({ basis: 'unmeasured', why: 'no family' })!.sentence).toBe('No published error rate: no family');
    expect(describeUncertainty(undefined)).toBeNull();
  });

  it('a row is pre-stamp only when none of the composer fields is present', () => {
    expect(isPreStamp({ ruleName: 'a', passed: true, score: 1, message: '' })).toBe(true);
    expect(isPreStamp({ ruleName: 'a', passed: true, score: 1, message: '', kind: 'policy' })).toBe(false);
    expect(isPreStamp({ ruleName: 'a', passed: true, score: 1, message: '', uncertainty: { basis: 'policy' } })).toBe(false);
  });
});
