/*
 * The three things a comparison can say: worse,
 * not distinguishable, and — new — equivalent within a margin. Plus the
 * per-rule rows that now carry a test: one-sided p, corrected q, and worse
 * only when q survives. And the tool's own shape, through the handler
 * `POST /api/v1/compare` shares, so both doors carry the new fields.
 */
import { describe, expect, it } from 'vitest';
import { compareRuns, RULE_ALPHA } from '../../../src/eval/compare.js';
import { compareRunsOutputSchema, compareStoredRuns } from '../../../src/tools/compare-runs.js';
import { newcombeDifference, smallestDetectableDifference, Z_90 } from '../../../src/eval/stats.js';
import type { RunResultRow } from '../../../src/storage/sqlite-adapter.js';
import type { IStorageAdapter } from '../../../src/types/query.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

let seq = 0;
function row(over: Partial<RunResultRow> = {}): RunResultRow {
  seq += 1;
  return {
    evalId: `e${seq}`,
    traceId: `t${seq}`,
    caseKey: null,
    agentName: 'bot',
    passed: true,
    failedRules: [],
    engineVersion: '0.13.0',
    rulesetHash: 'rs',
    configHash: 'cfg',
    createdAt: '2026-09-19T00:00:00.000Z',
    ...over,
  };
}

/** n rows, `fails` of them failing on `rule`, keyed case-i so two such runs pair. */
function run(n: number, fails: number, rule = 'no_pii', keyed = true): RunResultRow[] {
  return Array.from({ length: n }, (_, i) => row({ caseKey: keyed ? `case-${i}` : null, passed: i >= fails, failedRules: i < fails ? [rule] : [] }));
}

describe('equivalent within a margin — the third answer', () => {
  it('holds when the 90% interval on the difference sits inside ±δ, with δ defaulting to the smallest detectable difference', () => {
    const before = run(200, 20);
    const after = run(200, 22);
    const c = compareRuns('a', before, 'b', after);
    expect(c.worse).toBe(false);
    expect(c.better).toBe(false);
    const e = c.equivalentWithin!;
    expect(e.marginSource).toBe('smallest-detectable');
    expect(e.margin).toBe(smallestDetectableDifference(200, 200));
    const d90 = newcombeDifference(178, 200, 180, 200, Z_90)!;
    expect(e.interval).toEqual({ lo: d90.lo, hi: d90.hi });
    expect(e.holds).toBe(true);
    expect(c.summary).toContain('Equivalent within');
    expect(c.summary).toContain('the smallest difference these sizes could detect');
  });

  it('a supplied margin is honoured and named, and a tight one fails where the default held', () => {
    const before = run(200, 20);
    const after = run(200, 22);
    const loose = compareRuns('a', before, 'b', after, { equivalenceMargin: 0.2 });
    expect(loose.equivalentWithin).toMatchObject({ margin: 0.2, marginSource: 'caller', holds: true });
    const tight = compareRuns('a', before, 'b', after, { equivalenceMargin: 0.005 });
    expect(tight.equivalentWithin).toMatchObject({ margin: 0.005, marginSource: 'caller', holds: false });
    expect(tight.summary).toContain('Not equivalent within 0.5 points');
    expect(tight.summary).toContain('the margin you supplied');
    expect(tight.summary).toContain('a different statement from "not distinguishable"');
  });

  it('is distinct from "not distinguishable": six against six is neither worse nor equivalent', () => {
    const c = compareRuns('a', run(6, 1), 'b', run(6, 2));
    expect(c.worse).toBe(false);
    expect(c.smallestDetectable).toBeGreaterThan(0.4);
    // The default δ IS the smallest detectable difference, and six cases
    // cannot even establish that: the 90% interval is wider than the 95%
    // half-width at the observed rates.
    expect(c.equivalentWithin!.holds).toBe(false);
  });

  it('is null when a run is empty, like everything else', () => {
    expect(compareRuns('a', [], 'b', run(10, 1)).equivalentWithin).toBeNull();
  });
});

describe('per rule: a one-sided test behind every row, corrected together', () => {
  it('paired: McNemar exact on the rule\'s own discordant pairs; the rule that regressed survives, the one that wobbled does not', () => {
    // 60 paired cases. no_pii: 2 fails before, 14 after (12 pass→fail, 0 the
    // other way). no_tool_loop: 5 before, 6 after (one case each way plus one).
    const before = Array.from({ length: 60 }, (_, i) =>
      row({ caseKey: `case-${i}`, passed: i >= 5, failedRules: [...(i < 2 ? ['no_pii'] : []), ...(i < 5 ? ['no_tool_loop'] : [])] }),
    );
    const after = Array.from({ length: 60 }, (_, i) =>
      row({ caseKey: `case-${i}`, passed: i >= 14, failedRules: [...(i < 14 ? ['no_pii'] : []), ...(i >= 1 && i < 7 ? ['no_tool_loop'] : [])] }),
    );
    const c = compareRuns('before', before, 'after', after);
    expect(c.method).toBe('paired-mcnemar');
    expect(c.rulesTested).toBe(2);
    const pii = c.regressions.find((r) => r.rule === 'no_pii')!;
    expect(pii.test).toBe('mcnemar-exact');
    expect(pii.p).toBeCloseTo(1 / 4096, 8); // 12 pass→fail, 0 fail→pass: (1/2)^12
    expect(pii.q).toBeLessThanOrEqual(RULE_ALPHA);
    expect(pii.worse).toBe(true);
    expect(pii.difference!.delta).toBeCloseTo((60 - 14) / 60 - (60 - 2) / 60, 10);
    const loop = c.regressions.find((r) => r.rule === 'no_tool_loop')!;
    expect(loop.test).toBe('mcnemar-exact');
    expect(loop.p).toBeGreaterThan(RULE_ALPHA);
    expect(loop.worse).toBe(false);
    expect(loop.q).toBeGreaterThanOrEqual(loop.p!);
    // The surviving rule leads, whatever the raw deltas say.
    expect(c.regressions[0].rule).toBe('no_pii');
    expect(c.summary).toContain('2 rules tested one-sided');
    expect(c.summary).toContain(`worse at q ≤ ${RULE_ALPHA}: no_pii (q = `);
  });

  it('unpaired: the z from the rule\'s Newcombe difference; the correction is over every rule tested, and a rule with no evidence says so', () => {
    const before = [...run(40, 2, 'no_pii', false), ...run(40, 20, 'min_output_length', false)];
    const after = [...run(40, 20, 'no_pii', false), ...run(40, 2, 'min_output_length', false)];
    const c = compareRuns('before', before, 'after', after);
    expect(c.method).toBe('unpaired-newcombe');
    expect(c.rulesTested).toBe(2);
    const pii = c.regressions[0];
    expect(pii.rule).toBe('no_pii');
    expect(pii.test).toBe('newcombe-z');
    expect(pii.p).toBeLessThan(0.001);
    expect(pii.worse).toBe(true);
    const len = c.improvements[0];
    expect(len.rule).toBe('min_output_length');
    expect(len.p).toBeGreaterThan(0.999);
    expect(len.worse).toBe(false);
    expect(c.summary).toContain(`worse at q ≤ ${RULE_ALPHA}: no_pii (q = `);
  });

  it('a comparison where nothing moved tests nothing and says so with a zero, not a sentence', () => {
    const c = compareRuns('a', run(10, 0), 'b', run(10, 0));
    expect(c.rulesTested).toBe(0);
    expect(c.regressions).toEqual([]);
    expect(c.summary).not.toContain('Per rule');
  });
});

describe('the tool\'s shape carries the new fields on both doors', () => {
  const rows: Record<string, RunResultRow[]> = { before: run(60, 3), after: run(60, 15) };
  const storage = { getRunResults: async (_tenant: unknown, id: string) => rows[id] ?? [] } as unknown as IStorageAdapter;

  it('rules_tested, equivalent_within, and p / q / test / worse / difference per rule, all inside the output schema', async () => {
    const out = await compareStoredRuns(storage, LOCAL_TENANT, { before: 'before', after: 'after', equivalence_margin: 0.1 });
    expect(compareRunsOutputSchema.safeParse(out).success).toBe(true);
    expect(out.rules_tested).toBe(1);
    expect(out.equivalent_within).toMatchObject({ margin: 0.1, margin_source: 'caller', holds: false });
    expect(out.regressions[0]).toMatchObject({ rule: 'no_pii', test: 'mcnemar-exact', worse: true });
    expect(out.regressions[0].p).toBeCloseTo(1 / 4096, 8);
    expect(out.regressions[0].q).toBeCloseTo(1 / 4096, 8); // one test: q = p
    expect(out.regressions[0].difference).toMatchObject({ significant: true });
    expect(out.worse).toBe(true);
  });

  it('without a margin the response names the default', async () => {
    const out = await compareStoredRuns(storage, LOCAL_TENANT, { before: 'before', after: 'after' });
    expect(out.equivalent_within?.margin_source).toBe('smallest-detectable');
    expect(out.equivalent_within?.margin).toBe(smallestDetectableDifference(60, 60));
  });
});

/*
 * 2026-09-23 review (ADOPT-4, ADOPT-10). The top line tested two-sided while
 * every per-rule row tested one-sided, so 12/12 -> 7/12 on paired cases
 * (five regressed, none recovered: two-sided exact p = 0.0625) answered
 * worse: false and "not enough evidence" while its own per-rule row read
 * worse. And comparing against a run with no evaluations said comparable.
 */
describe('the top line asks the same one-sided question as the per-rule rows', () => {
  it('12/12 -> 7/12 on paired cases is a regression, and its per-rule row agrees', () => {
    const c = compareRuns('before', run(12, 0), 'after', run(12, 5));
    expect(c.method).toBe('paired-mcnemar');
    expect(c.worse).toBe(true);
    expect(c.better).toBe(false);
    expect(c.regressions[0]?.worse).toBe(true);
    expect(c.summary).toContain('This is a regression');
    expect(c.summary).toContain('one-sided p (worse) = 0.0313');
  });

  it('the mirror image is an improvement', () => {
    const c = compareRuns('before', run(12, 5), 'after', run(12, 0));
    expect(c.better).toBe(true);
    expect(c.worse).toBe(false);
  });

  it('an undecided paired comparison does not advise pairing runs that are already paired', () => {
    const c = compareRuns('before', run(12, 0), 'after', run(12, 1));
    expect(c.worse).toBe(false);
    expect(c.summary).toContain('Run more cases.');
    expect(c.summary).not.toContain('pair them with case keys');
  });

  it(`still holds a one-change-in-many to "not enough evidence" at α = ${RULE_ALPHA}`, () => {
    const c = compareRuns('before', run(200, 20), 'after', run(200, 22));
    expect(c.worse).toBe(false);
    expect(c.better).toBe(false);
  });

  it('a run with no evaluations is not comparable, and says why', () => {
    const c = compareRuns('before', [], 'after', run(12, 0));
    expect(c.comparable).toBe(false);
    expect(c.incomparableBecause.join(' ')).toContain('has no evaluations');
  });
});
