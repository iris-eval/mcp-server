/*
 * compareRuns — the acceptance rows for "did my change make it worse?".
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
import { MAX_DISCORDANT, compareRuns } from '../../../src/eval/compare.js';
import type { RunResultRow } from '../../../src/storage/sqlite-adapter.js';

const row = (over: Partial<RunResultRow> = {}): RunResultRow => ({
  evalId: Math.random().toString(36).slice(2),
  traceId: Math.random().toString(36).slice(2),
  caseKey: null,
  agentName: 'agent',
  passed: true,
  failedRules: [],
  // Every rule these tests name ran on every case, unless a test says otherwise.
  judgedRules: ['no_pii', 'no_tool_loop', 'min_output_length'],
  criticalFailed: [],
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
    // 44/50 against 38/50: as two independent samples the interval straddles
    // zero. Paired, the six discordant cases all went the same way.
    const unpaired = compareRuns('before', run(50, 44), 'after', run(50, 38));
    expect(unpaired.worse).toBe(false);
    expect(unpaired.difference!.significant).toBe(false);
    const c = compareRuns('before', run(50, 44, { paired: true }), 'after', run(50, 38, { paired: true }));
    expect(c.paired!.significant).toBe(true);
    expect(c.worse).toBe(true);
    // The interval reported is the paired one, and it agrees with the word.
    expect(c.difference!.significant).toBe(true);
    expect(c.difference!.hi).toBeLessThan(0);
    expect(c.paired).toMatchObject({ b: 6, c: 0, bothPass: 38, bothFail: 6 });
    expect(c.paired!.fell!.share).toBe(1);
    expect(c.paired!.fell!.lo).toBeGreaterThan(0.5);
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
    expect(c.summary).toContain('would have missed, more often than one time in five, a change smaller than about 72 points');
    expect(c.smallestDetectable).toBeCloseTo(0.7178, 3);
    expect(c.detectablePower).toBe(0.8);
    expect(c.call).toBe('undetermined');
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
    expect(c.summary).toContain('no_pii (3 of 20 → 9 of 20)');
    expect(c.regressions[0]).toMatchObject({ judgedBefore: 20, judgedAfter: 20 });
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

  it('C1 — the difference is the hand-computed Newcombe interval, at the level that matches the one-sided test', () => {
    const c = compareRuns('before', run(20, 12), 'after', run(20, 18));
    // after − before = 0.9 − 0.6, with the 90% interval: the two-sided interval a one-sided 5% test reads.
    expect(c.intervalLevel).toBe(0.9);
    expect(c.difference!.delta).toBeCloseTo(0.3, 10);
    expect(c.difference!.lo).toBeCloseTo(0.0742, 3);
    expect(c.difference!.hi).toBeCloseTo(0.4932, 3);
    expect(c.better).toBe(true);
    expect(c.summary).toContain('Difference in pass rate: +30.0 points, 90% interval [+7.4, +49.3] on two independent samples.');
  });
});

describe('the discordant cases are named', () => {
  const paired = (spec: Array<[string, boolean, string[]]>) => spec.map(([caseKey, passed, failedRules]) => row({ caseKey, passed, failedRules }));

  it('lists each paired case whose verdict flipped, regressions first, with the rules that flipped and both evaluations', () => {
    const before = paired([
      ['case-0', true, []],
      ['case-1', true, []],
      ['case-2', false, ['no_pii']],
      ['case-3', true, []],
      ['case-5', false, ['no_pii', 'no_tool_loop']],
    ]);
    const after = paired([
      ['case-0', true, []],
      ['case-1', false, ['min_output_length']],
      ['case-2', false, ['no_pii']],
      ['case-3', true, []],
      ['case-5', true, []],
    ]);
    const c = compareRuns('before', before, 'after', after);
    expect(c.paired).toMatchObject({ b: 1, c: 1, concordant: 3 });
    expect(c.discordantTotal).toBe(2);
    expect(c.discordant.map((d) => [d.caseKey, d.direction])).toEqual([
      ['case-1', 'regressed'],
      ['case-5', 'recovered'],
    ]);
    const [regressed, recovered] = c.discordant;
    expect(regressed.rules).toEqual([{ rule: 'min_output_length', before: true, after: false }]);
    expect(regressed.before).toEqual({ evalId: before[1].evalId, traceId: before[1].traceId, passed: true });
    expect(regressed.after).toEqual({ evalId: after[1].evalId, traceId: after[1].traceId, passed: false });
    expect(recovered.rules).toEqual([
      { rule: 'no_pii', before: false, after: true },
      { rule: 'no_tool_loop', before: false, after: true },
    ]);
    expect(recovered.notJudgedAfter).toEqual([]);
  });

  it('is empty when the runs do not pair, and the total says so', () => {
    const c = compareRuns('before', run(10, 8), 'after', run(10, 9));
    expect(c.method).toBe('unpaired-newcombe');
    expect(c.discordant).toEqual([]);
    expect(c.discordantTotal).toBe(0);
  });

  it('caps the list and reports the whole count', () => {
    const n = MAX_DISCORDANT + 50;
    const before = paired(Array.from({ length: n }, (_, i) => [`case-${String(i).padStart(4, '0')}`, true, []] as [string, boolean, string[]]));
    const after = paired(Array.from({ length: n }, (_, i) => [`case-${String(i).padStart(4, '0')}`, false, ['no_pii']] as [string, boolean, string[]]));
    const c = compareRuns('before', before, 'after', after);
    expect(c.discordant).toHaveLength(MAX_DISCORDANT);
    expect(c.discordantTotal).toBe(n);
    expect(c.discordant[0].caseKey).toBe('case-0000');
  });
});

/*
 * A rule that did not run on a case is neither a pass nor a failure there.
 * A run row once held only the rules that fired, so a skip read as a pass:
 * an after-run that stopped sending tool calls had every trajectory rule
 * "recover", and the summary said "This is an improvement".
 */
describe('what was not checked is not counted as a pass', () => {
  const TEXT = ['no_pii', 'min_output_length'];
  const ALL = [...TEXT, 'no_tool_loop', 'no_silent_tool_failure'];
  /** 12 paired cases. Before: every rule ran, and the two trajectory rules fired on `trajectoryFails` of them. */
  const instrumented = (trajectoryFails: number): RunResultRow[] =>
    Array.from({ length: 12 }, (_, i) =>
      row({ caseKey: `case-${String(i).padStart(2, '0')}`, passed: i >= trajectoryFails, judgedRules: ALL, failedRules: i < trajectoryFails ? ['no_silent_tool_failure'] : [] }),
    );
  /** The same 12 cases with no tool calls sent: the trajectory rules skipped, so nothing fired. */
  const withheld = (): RunResultRow[] => Array.from({ length: 12 }, (_, i) => row({ caseKey: `case-${String(i).padStart(2, '0')}`, passed: true, judgedRules: TEXT, failedRules: [] }));

  it('a run that stops sending evidence is not called an improvement, and the response says what it was judged on', () => {
    const c = compareRuns('before', instrumented(7), 'after', withheld());
    // Seven cases "recovered", which a one-sided test reads as a rise.
    expect(c.paired).toMatchObject({ b: 0, c: 7 });
    expect(c.better).toBe(false);
    expect(c.improvementWithheld).toBe(true);
    expect(c.call).toBe('undetermined');
    expect(c.worse).toBe(false);
    expect(c.coverage.lost.map((l) => l.rule)).toEqual(['no_silent_tool_failure', 'no_tool_loop']);
    expect(c.coverage.lost[0]).toEqual({ rule: 'no_silent_tool_failure', judgedBefore: 12, ofBefore: 12, judgedAfter: 0, ofAfter: 12, onShared: 12 });
    expect(c.coverage.gained).toEqual([]);
    expect(c.summary).toContain('The second run was judged on less: 2 rules ran on fewer cases than before: no_silent_tool_failure (ran on 12 of 12 before, 0 of 12 after), no_tool_loop (ran on 12 of 12 before, 0 of 12 after).');
    expect(c.summary).toContain('this is not called an improvement');
    expect(c.summary).not.toContain('This is an improvement');
    // The coverage sentence comes before the verdict sentence.
    expect(c.summary.indexOf('judged on less')).toBeLessThan(c.summary.indexOf('not called an improvement'));
  });

  it('the rule that stopped running is not a recovery: it has no difference and no test', () => {
    const c = compareRuns('before', instrumented(7), 'after', withheld());
    const rule = c.improvements.find((r) => r.rule === 'no_silent_tool_failure')!;
    expect(rule).toMatchObject({ failedBefore: 7, failedAfter: 0, judgedBefore: 12, judgedAfter: 0, difference: null, test: null, p: null, q: null, worse: false });
    expect(c.rulesTested).toBe(0);
    // Each recovered case names the checks that did not run on it.
    expect(c.discordant).toHaveLength(7);
    expect(c.discordant[0]).toMatchObject({ direction: 'recovered', notJudgedAfter: ['no_silent_tool_failure', 'no_tool_loop'] });
  });

  it('the same evidence in both runs and fewer failures is an improvement, as before', () => {
    const fixed = instrumented(0);
    const c = compareRuns('before', instrumented(7), 'after', fixed);
    expect(c.better).toBe(true);
    expect(c.improvementWithheld).toBe(false);
    expect(c.call).toBe('better');
    expect(c.coverage).toEqual({ lost: [], gained: [] });
    expect(c.summary).toContain('This is an improvement');
  });

  it('a regression is declared even when the second run was judged on less', () => {
    const before = instrumented(0);
    const after = Array.from({ length: 12 }, (_, i) => row({ caseKey: `case-${String(i).padStart(2, '0')}`, passed: i >= 8, judgedRules: TEXT, failedRules: i < 8 ? ['no_pii'] : [] }));
    const c = compareRuns('before', before, 'after', after);
    expect(c.worse).toBe(true);
    expect(c.call).toBe('worse');
    expect(c.coverage.lost).toHaveLength(2);
    expect(c.summary).toContain('This is a regression');
    expect(c.summary).toContain('judged on less');
  });

  it('a rule is tested only over the cases it ran on in both runs', () => {
    // no_tool_loop ran on the first six cases in both runs and fired on five of them after; on the other six it ran in neither.
    const make = (fails: number): RunResultRow[] =>
      Array.from({ length: 12 }, (_, i) =>
        row({ caseKey: `case-${i}`, passed: !(i < fails), judgedRules: i < 6 ? ['no_pii', 'no_tool_loop'] : ['no_pii'], failedRules: i < fails ? ['no_tool_loop'] : [] }),
      );
    const c = compareRuns('before', make(0), 'after', make(5));
    const rule = c.regressions.find((r) => r.rule === 'no_tool_loop')!;
    expect(rule).toMatchObject({ failedBefore: 0, failedAfter: 5, judgedBefore: 6, judgedAfter: 6, test: 'mcnemar-exact' });
    // Its pass rate fell from 6 of 6 to 1 of 6, not from 12 of 12 to 7 of 12.
    expect(rule.difference!.delta).toBeCloseTo(-5 / 6, 10);
    expect(rule.p).toBeCloseTo(0.03125, 6);
    expect(c.coverage).toEqual({ lost: [], gained: [] });
  });

  it('gained coverage is reported and does not withhold anything', () => {
    const c = compareRuns('before', withheld(), 'after', instrumented(0));
    expect(c.coverage.lost).toEqual([]);
    expect(c.coverage.gained.map((g) => g.rule)).toEqual(['no_silent_tool_failure', 'no_tool_loop']);
    expect(c.improvementWithheld).toBe(false);
  });

  it('unpaired: a rule that ran on a clearly smaller share of cases is lost coverage; an ordinary difference in the mix of cases is not', () => {
    const sample = (n: number, withTrajectory: number): RunResultRow[] => Array.from({ length: n }, (_, i) => row({ passed: true, judgedRules: i < withTrajectory ? ALL : TEXT }));
    const dropped = compareRuns('before', sample(40, 40), 'after', sample(40, 0));
    expect(dropped.method).toBe('unpaired-newcombe');
    expect(dropped.coverage.lost.map((l) => l.rule)).toEqual(['no_silent_tool_failure', 'no_tool_loop']);
    expect(dropped.coverage.lost[0].onShared).toBeNull();
    const mix = compareRuns('before', sample(40, 30), 'after', sample(40, 27));
    expect(mix.coverage).toEqual({ lost: [], gained: [] });
  });
});

/*
 * A critical rule firing on a case it did not fire on before is one output
 * that must not ship. Five of those among twelve cases is not a question of
 * significance, and it must never sit under the word "equivalent".
 */
describe('a critical failure is counted, not tested', () => {
  const leak = (i: number, leaks: boolean): RunResultRow =>
    row({ caseKey: `case-${String(i).padStart(2, '0')}`, passed: false, failedRules: ['min_output_length', ...(leaks ? ['no_pii'] : [])], criticalFailed: leaks ? ['no_pii'] : [] });

  it('a fivefold rise in leaks is named with its cases, whatever the pass rate did', () => {
    // Every case fails in both runs on an unrelated rule, so no pair disagrees and no test sees anything.
    const before = Array.from({ length: 12 }, (_, i) => leak(i, i === 0));
    const after = Array.from({ length: 12 }, (_, i) => leak(i, i < 5));
    const c = compareRuns('before', before, 'after', after, { equivalenceMargin: 0.3 });
    expect(c.paired).toMatchObject({ b: 0, c: 0, concordant: 12 });
    expect(c.worse).toBe(false);
    expect(c.criticalRises).toEqual([{ rule: 'no_pii', before: 1, after: 5, newOn: ['case-01', 'case-02', 'case-03', 'case-04'] }]);
    expect(c.summary).toContain('Critical: no_pii fires on 5 cases in the second run and 1 in the first, newly on 4 cases: case-01, case-02, case-03, case-04.');
    // The pass-rate interval sits inside the margin, and the runs are still not called equivalent.
    expect(c.equivalentWithin!.holds).toBe(true);
    expect(c.call).toBe('undetermined');
    expect(c.summary).toContain('the runs are not called equivalent: a critical rule fires on cases it did not before');
    expect(c.summary).not.toMatch(/^Equivalent within| Equivalent within/);
  });

  it('a critical rule that fires on the same cases, or fewer, is not a rise', () => {
    const before = Array.from({ length: 12 }, (_, i) => leak(i, i < 5));
    expect(compareRuns('before', before, 'after', before.map((r) => ({ ...r }))).criticalRises).toEqual([]);
    const fewer = Array.from({ length: 12 }, (_, i) => leak(i, i < 2));
    expect(compareRuns('before', before, 'after', fewer).criticalRises).toEqual([]);
  });

  it('unpaired: more fires than before is a rise, with no cases to name', () => {
    const sample = (n: number, leaks: number): RunResultRow[] => Array.from({ length: n }, (_, i) => row({ passed: i >= leaks, failedRules: i < leaks ? ['no_pii'] : [], criticalFailed: i < leaks ? ['no_pii'] : [] }));
    expect(compareRuns('before', sample(20, 1), 'after', sample(20, 3)).criticalRises).toEqual([{ rule: 'no_pii', before: 1, after: 3, newOn: [] }]);
  });
});

/*
 * "This is a regression" once sat beside "95% interval [−28.6, +0.9]" and a
 * field `significant: false`: the test was one-sided at 5% and the interval
 * printed was the two-sided 95% one. The interval is now the one the test
 * implies, so the word and the interval cannot disagree.
 */
describe('every word matches its number', () => {
  it('45 of 50 against 38 of 50: the word, the field and the interval all say regression', () => {
    const c = compareRuns('before', run(50, 45), 'after', run(50, 38));
    expect(c.worse).toBe(true);
    expect(c.difference!.significant).toBe(true);
    expect(c.difference!.hi).toBeLessThan(0);
    expect(c.summary).toContain('This is a regression');
    expect(c.summary).toMatch(/Difference in pass rate: -14\.0 points, 90% interval \[-26\.2, -1\.[56]\] on two independent samples\./);
  });

  it('over every pair of rates at four sizes, paired and not: worse, better and the interval never disagree', () => {
    let checked = 0;
    for (const n of [8, 12, 20, 50]) {
      for (let before = 0; before <= n; before += 2) {
        for (let after = 0; after <= n; after += 1) {
          for (const paired of [false, true]) {
            const c = compareRuns('before', run(n, before, { paired }), 'after', run(n, after, { paired }));
            const d = c.difference!;
            expect(c.worse, `n=${n} ${before}->${after} paired=${paired}`).toBe(d.hi < 0);
            expect(c.better, `n=${n} ${before}->${after} paired=${paired}`).toBe(d.lo > 0);
            expect(d.significant).toBe(c.worse || c.better);
            expect(c.summary.includes('This is a regression')).toBe(c.worse);
            expect(c.summary.includes('This is an improvement')).toBe(c.better);
            expect(c.summary).not.toContain('**');
            checked += 1;
          }
        }
      }
    }
    expect(checked).toBeGreaterThan(1500);
  });

  it('paired: the number beside the word is the one the test read, which way the changed cases went', () => {
    const c = compareRuns('before', run(50, 44, { paired: true }), 'after', run(50, 38, { paired: true }));
    expect(c.difference!.delta).toBeCloseTo(-0.12, 10);
    expect(c.difference!.hi).toBeCloseTo(-0.0257, 3);
    expect(c.paired!.fell!.lo).toBeCloseTo(0.607, 3);
    expect(c.summary).toContain('Difference in pass rate on the matched cases: -12.0 points. Of the 6 cases that changed, 100.0% fell, 90% exact interval [60.7%, 100.0%]');
  });

  it('paired: the share that fell excludes one half exactly when the word is used', () => {
    let checked = 0;
    for (const n of [8, 12, 20, 50]) {
      for (let before = 0; before <= n; before += 2) {
        for (let after = 0; after <= n; after += 1) {
          const c = compareRuns('before', run(n, before, { paired: true }), 'after', run(n, after, { paired: true }));
          const f = c.paired!.fell;
          if (f === null) {
            expect(c.worse || c.better).toBe(false);
            expect(c.summary).toContain('No case changed.');
            continue;
          }
          expect(c.worse, `n=${n} ${before}->${after}`).toBe(f.lo > 0.5);
          expect(c.better, `n=${n} ${before}->${after}`).toBe(f.hi < 0.5);
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(700);
  });
});
