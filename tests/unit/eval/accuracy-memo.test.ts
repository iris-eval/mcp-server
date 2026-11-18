/*
 * The published intervals are worked out once (src/eval/accuracy.ts): the
 * 2,000 pairs of draws once per rule and kind of interval, the interval
 * once per exact prevalence. Since the memo hands out a new object to each
 * caller, an object's identity no longer shows that; the work done does.
 * The statistics module is wrapped so that its calls can be counted, and
 * nothing it answers is changed.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/eval/stats.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../src/eval/stats.js')>();
  return { ...actual, beta: vi.fn(actual.beta), percentile95: vi.fn(actual.percentile95) };
});

const { beta, percentile95 } = await import('../../../src/eval/stats.js');
const { INTERVAL_DRAWS, missRateInterval, ppvInterval, resetAccuracyMemo } = await import('../../../src/eval/accuracy.js');

const draws = vi.mocked(beta);
const intervals = vi.mocked(percentile95);

beforeEach(() => {
  resetAccuracyMemo();
  draws.mockClear();
  intervals.mockClear();
});

describe('nothing is worked out twice', () => {
  it('the same rule and prevalence: one working-out, however often it is asked', () => {
    const first = ppvInterval('no_stub_output', 0.2);
    expect(draws).toHaveBeenCalledTimes(2 * INTERVAL_DRAWS);
    expect(intervals).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 50; i += 1) expect(ppvInterval('no_stub_output', 0.2)).toEqual(first);
    expect(draws).toHaveBeenCalledTimes(2 * INTERVAL_DRAWS);
    expect(intervals).toHaveBeenCalledTimes(1);
  });

  it('another prevalence of the same rule: a new interval from the same draws', () => {
    ppvInterval('no_stub_output', 0.2);
    const other = ppvInterval('no_stub_output', 0.05);
    expect(other).not.toEqual(ppvInterval('no_stub_output', 0.2));
    expect(draws).toHaveBeenCalledTimes(2 * INTERVAL_DRAWS);
    expect(intervals).toHaveBeenCalledTimes(2);
  });

  it('the other kind of interval, and another rule, draw their own', () => {
    ppvInterval('no_stub_output', 0.2);
    missRateInterval('no_stub_output', 0.2);
    expect(draws).toHaveBeenCalledTimes(4 * INTERVAL_DRAWS);
    ppvInterval('no_pii', 0.2);
    expect(draws).toHaveBeenCalledTimes(6 * INTERVAL_DRAWS);
    expect(intervals).toHaveBeenCalledTimes(3);
  });

  it('a rule with no published numbers is remembered as having none, and costs nothing to ask again', () => {
    expect(ppvInterval('no_such_rule', 0.2)).toBeNull();
    expect(ppvInterval('no_such_rule', 0.2)).toBeNull();
    expect(draws).not.toHaveBeenCalled();
    expect(intervals).not.toHaveBeenCalled();
  });
});
