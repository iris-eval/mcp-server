/**
 * The human review scorer is the half of the blind-label tool that a reviewer
 * who has never read the code can actually feed. Its whole value is that the
 * four outcomes mean what they say, so each one is pinned to a real case whose
 * rule behaviour is fixed by the corpus and the registry.
 */
import { describe, it, expect } from 'vitest';
import { review, type AnswerSheet } from '../../proof/human-review.js';

const sheet: AnswerSheet = {
  answers: [
    // The rule fires and a reviewer would want to be told: agreement.
    { id: 'pii-035', verdict: 'fail' },
    // A placeholder token. The rule stays quiet and so would a reviewer.
    { id: 'pii-016', verdict: 'pass' },
    // JWT middleware that verifies nothing while claiming it does. The stub
    // rule misses it, so a reviewer flagging it is a GAP, not a mistake.
    { id: 'stub-084', verdict: 'fail' },
    // "how to hackathon-proof" contains the banned substring "how to hack".
    // The rule fires on a clean sentence: a FALSE ALARM.
    { id: 'blocklist-016', verdict: 'pass' },
    // Excluded from every count.
    { id: 'hall-001', verdict: 'unsure' },
  ],
};

describe('human review scoring', () => {
  it('classifies each outcome from what the shipped rule actually does', async () => {
    const r = await review(sheet);
    expect(r.answered).toBe(4);
    expect(r.unsure).toBe(1);
    const by = new Map(r.rows.map((row) => [row.id, row.outcome]));
    expect(by.get('pii-035')).toBe('agree-flag');
    expect(by.get('pii-016')).toBe('agree-quiet');
    expect(by.get('stub-084')).toBe('miss');
    expect(by.get('blocklist-016')).toBe('false-alarm');
  });

  it('counts agreement over answered cases only, excluding unsure', async () => {
    const r = await review(sheet);
    expect(r.agree).toBe(2);
    expect(r.misses.map((m) => m.id)).toEqual(['stub-084']);
    expect(r.falseAlarms.map((m) => m.id)).toEqual(['blocklist-016']);
  });

  it('refuses an answer sheet naming a case that is not in the corpus', async () => {
    await expect(review({ answers: [{ id: 'not-a-case', verdict: 'fail' }] })).rejects.toThrow(
      /unknown case id/,
    );
  });

  it('never reports a disagreement as the reviewer being wrong', async () => {
    const text = (await import('../../proof/human-review.js')).render(await review(sheet));
    expect(text).toContain('This is not a score for the reviewer');
    expect(text).not.toMatch(/incorrect|wrong answer|you got/i);
  });
});
