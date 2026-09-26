/*
 * The significance order (#409): score descending, newest first among
 * equals, trace id last so the order is total and a page boundary never
 * moves between two reads of the same data.
 */
import { describe, expect, it } from 'vitest';
import { compareBySignificance, rankBySignificance } from '../../../src/eval/moment-rank.js';
import type { DecisionMoment, MomentSignificanceKind } from '../../../src/types/decision-moment.js';

function moment(id: string, timestamp: string, kind: MomentSignificanceKind, score: number): DecisionMoment {
  return {
    id,
    traceId: id,
    agentName: 'a',
    timestamp,
    verdict: 'pass',
    overallScore: 1,
    evalCount: 1,
    ruleSnapshot: { failed: [], skipped: [], passedCount: 1, totalCount: 1 },
    significance: { kind, score, label: kind, reason: kind },
  };
}

describe('rankBySignificance', () => {
  it('orders by score, then newest first, then id', () => {
    const input = [
      moment('pass-new', '2026-09-02T00:00:00Z', 'normal-pass', 0.05),
      moment('fail-old', '2026-09-01T00:00:00Z', 'normal-fail', 0.5),
      moment('safety-old', '2026-08-01T00:00:00Z', 'safety-violation', 1),
      moment('fail-new', '2026-09-02T00:00:00Z', 'normal-fail', 0.5),
      moment('b-tie', '2026-09-01T12:00:00Z', 'first-failure', 0.8),
      moment('a-tie', '2026-09-01T12:00:00Z', 'first-failure', 0.8),
    ];
    expect(rankBySignificance(input).map((m) => m.id)).toEqual(['safety-old', 'a-tie', 'b-tie', 'fail-new', 'fail-old', 'pass-new']);
  });

  it('leaves its input as it was', () => {
    const input = [moment('x', '2026-09-01T00:00:00Z', 'normal-pass', 0.05), moment('y', '2026-09-01T00:00:00Z', 'safety-violation', 1)];
    rankBySignificance(input);
    expect(input.map((m) => m.id)).toEqual(['x', 'y']);
  });

  it('compares timestamps as instants, not strings', () => {
    // The same instant written with and without milliseconds, and an offset form.
    const a = moment('a', '2026-09-01T00:00:00.000Z', 'normal-fail', 0.5);
    const b = moment('b', '2026-09-01T02:00:00+02:00', 'normal-fail', 0.5);
    expect(compareBySignificance(a, b)).toBeLessThan(0);
    expect(compareBySignificance(b, a)).toBeGreaterThan(0);
  });
});
