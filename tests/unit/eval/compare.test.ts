/*
 * compareRuns — the acceptance rows for arc 5's central question.
 *
 * C1 (the interval), C2 (a boundary refuses to pretend), C3 (the test and
 * the pair count are named), C6 (not enough evidence is an answer) and C7
 * (regressions per rule, worst first).
 *
 * The rows that matter most are C6's. A comparison that always returns a
 * verdict is more satisfying and less true, and a tool that says "worse" on
 * eight cases teaches its user to distrust it inside a week — after which
 * the honest answers are worthless too, because nobody reads them.
 */
import { describe, expect, it } from 'vitest';
import { compareRuns } from '../../../src/eval/compare.js';
import type { RunResultRow } from '../../../src/storage/sqlite-adapter.js';

const row = (over: Partial<RunResultRow> = {}): RunResultRow => ({
  evalId: Math.random().toString(36).slice(2),
  traceId: Math.random().toString(36).slice(2),
  caseKey: null,
  agentName: 'agent',
  passed: true,
  failedRules: [],
  engineVersion: '0.12.0',
  rulesetHash: 'rs-1',
  configHash: 'cfg-1',
  createdAt: '2026-09-07T00:00:00.000Z',
  ...over,
});

/** n rows, `pass` of them passing, keyed case-1..case-n when paired. */
const run = (n: number, pass: number, opts: { paired?: boolean; failWith?: string } = {}): RunResultRow[] =>
  Array.from({ length: n }, (_, i) =>
    row({
      caseKey: opts.paired ? `case-${i}` : null,
      passed: i < pass,
      failedRules: i < pass ? [] : [opts.failWith ?? 'no_pii'],
    }),
  );

describe('C2 — a comparison across a boundary refuses to pretend', () => {
  it('a different ruleset is not comparable, and the reason names it', () => {
    const c = compareRuns('before', run(10, 9), 'after', run(10, 5).map((r) => ({ ...r, rulesetHash: 'rs-2' })));
    expect(c.comparable).toBe(false);
    expect(c.incomparableBecause.join(' ')).toContain('ruleset differs');
    expect(c.worse).toBe(false);
    expect(c.summary).toContain('Pass force');
  });

  it('a different engine MINOR is not comparable; a patch is', () => {
    const patch = compareRuns('a', run(10, 9), 'b', run(10, 8).map((r) => ({ ...r, engineVersion: '0.12.3' })));
    expect(patch.comparable).toBe(true);
    const minor = compareRuns('a', run(10, 9), 'b', run(10, 8).map((r) => ({ ...r, engineVersion: '0.13.0' })));
    expect(minor.comparable).toBe(false);
    expect(minor.incomparableBecause.join(' ')).toContain('engine version differs');
  });

  it('two different agents are not one comparison', () => {
    const c = compareRuns('a', run(10, 9), 'b', run(10, 5).map((r) => ({ ...r, agentName: 'other' })));
    expect(c.comparable).toBe(false);
    expect(c.incomparableBecause.join(' ')).toContain('different agents');
  });

  it('a run containing two rulesets is not one measurement, and says so', () => {
    const mixed = [...run(5, 5), ...run(5, 2).map((r) => ({ ...r, rulesetHash: 'rs-2' }))];
    const c = compareRuns('mixed', mixed, 'after', run(10, 9));
    expect(c.comparable).toBe(false);
    expect(c.incomparableBecause.join(' ')).toContain('more than one ruleset');
  });

  it('force compares anyway AND still names what changed', () => {
    const after = run(10, 2).map((r) => ({ ...r, rulesetHash: 'rs-2' }));
    const c = compareRuns('before', run(10, 10), 'after', after, { force: true });
    expect(c.forced).toBe(true);
    expect(c.comparable).toBe(false);
    expect(c.method).not.toBe('none');
    expect(c.summary).toContain('not strictly comparable');
    expect(c.summary).toContain('ruleset differs');
  });
});

describe('C3 — a paired comparison names its test and its pair count', () => {
  it('pairs on case key, runs McNemar exact, and reports the discordant split', () => {
    const before = run(50, 44, { paired: true });
    const after = run(50, 38, { paired: true });
    const c = compareRuns('before', before, 'after', after);
    expect(c.method).toBe('paired-mcnemar');
    expect(c.paired).not.toBeNull();
    expect(c.paired!.method).toBe('mcnemar-exact');
    expect(c.paired!.pairs).toBe(50);
    expect(c.summary).toContain('McNemar exact');
    expect(c.summary).toContain('matched pairs');
  });

  it('sees a regression the unpaired reading of the same data cannot', () => {
    // 44/50 against 38/50: unpaired the interval straddles zero. Paired,
    // the six discordant cases all went the same way.
    const c = compareRuns('before', run(50, 44, { paired: true }), 'after', run(50, 38, { paired: true }));
    expect(c.difference!.significant).toBe(false);
    expect(c.paired!.significant).toBe(true);
    expect(c.worse).toBe(true);
  });

  it('falls back to the unpaired test when nothing pairs, and says why that is worse', () => {
    const c = compareRuns('before', run(50, 44), 'after', run(50, 38));
    expect(c.method).toBe('unpaired-newcombe');
    expect(c.paired).toBeNull();
    expect(c.summary).toContain('No case keys are shared');
    expect(c.summary).toContain('pairs them');
  });
});

describe('C6 — not enough evidence is an answer, and it says what would be enough', () => {
  it('six against six cannot see a one-case difference, and does not pretend to', () => {
    const c = compareRuns('before', run(6, 5), 'after', run(6, 4));
    expect(c.worse).toBe(false);
    expect(c.better).toBe(false);
    expect(c.summary).toContain('Not enough evidence');
    expect(c.summary).toContain('could not have detected a change smaller than');
    expect(c.smallestDetectable).toBeGreaterThan(0.4);
  });

  it('the phrase "regression" appears ONLY when the evidence licenses it', () => {
    const weak = compareRuns('a', run(6, 5), 'b', run(6, 4));
    expect(weak.summary).not.toContain('regression');
    const strong = compareRuns('a', run(40, 40), 'b', run(40, 10));
    expect(strong.worse).toBe(true);
    expect(strong.summary).toContain('regression');
  });

  it('an improvement is reported as an improvement, not as an absence of regression', () => {
    const c = compareRuns('a', run(40, 10), 'b', run(40, 40));
    expect(c.better).toBe(true);
    expect(c.worse).toBe(false);
    expect(c.summary).toContain('improvement');
  });

  it('reports nothing rather than something when a run is empty', () => {
    const c = compareRuns('a', [], 'b', run(10, 5));
    expect(c.worse).toBe(false);
    expect(c.difference).toBeNull();
    expect(c.summary).toContain('no evaluations');
  });
});

describe('C7 — regressions per rule, worst first, and improvements kept separate', () => {
  it('leads with the rule that got worse and never lists an improved rule as a regression', () => {
    const before = [
      ...Array.from({ length: 3 }, () => row({ passed: false, failedRules: ['no_pii'] })),
      ...Array.from({ length: 5 }, () => row({ passed: false, failedRules: ['no_tool_loop'] })),
      ...Array.from({ length: 12 }, () => row({ passed: true })),
    ];
    const after = [
      ...Array.from({ length: 9 }, () => row({ passed: false, failedRules: ['no_pii'] })),
      ...Array.from({ length: 1 }, () => row({ passed: false, failedRules: ['no_tool_loop'] })),
      ...Array.from({ length: 10 }, () => row({ passed: true })),
    ];
    const c = compareRuns('before', before, 'after', after);
    expect(c.regressions[0].rule).toBe('no_pii');
    expect(c.regressions[0].delta).toBe(6);
    expect(c.regressions.map((r) => r.rule)).not.toContain('no_tool_loop');
    expect(c.improvements[0].rule).toBe('no_tool_loop');
    expect(c.improvements[0].delta).toBe(-4);
    expect(c.summary).toContain('no_pii (3 → 9)');
  });

  it('a skipped rule is not a failure, so it never appears as a regression', () => {
    // failedRules is built from rules that FIRED; a skip is not a failure,
    // and counting one would report a regression from evidence not judged.
    const c = compareRuns('a', [row({ passed: true })], 'b', [row({ passed: true })]);
    expect(c.regressions).toEqual([]);
  });
});

describe('the run summary carries what a reader needs to judge it', () => {
  it('reports both rates with Wilson intervals', () => {
    const c = compareRuns('before', run(20, 18), 'after', run(20, 12));
    expect(c.before.rate).toBeCloseTo(0.9, 10);
    expect(c.after.rate).toBeCloseTo(0.6, 10);
    expect(c.before.interval!.lo).toBeCloseTo(0.699, 2);
    expect(c.after.interval!.hi).toBeCloseTo(0.781, 2);
  });

  it('C1 — the difference is the hand-computed Newcombe interval', () => {
    const c = compareRuns('before', run(20, 12), 'after', run(20, 18));
    // after − before = 0.9 − 0.6, the interval from the statistics tests.
    expect(c.difference!.delta).toBeCloseTo(0.3, 10);
    expect(c.difference!.lo).toBeCloseTo(0.0294, 3);
    expect(c.difference!.hi).toBeCloseTo(0.5252, 3);
  });
});
