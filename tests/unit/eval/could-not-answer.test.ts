/*
 * A check that could not answer, through the engine.
 *
 * tests/unit/eval/verdict-path.test.ts holds the composer on rows built by
 * hand. This file holds the whole road: a rule throws inside an evaluation,
 * the engine catches it, the stamp says who had asked for the rule, and the
 * verdict is unknown where it used to pass clean.
 *
 * What makes a rule throw here is a BigInt in a call's input. No request
 * can carry one (JSON has none), and an embedder's own call can; the rules
 * that write an input out have no writing for it. It stands for any input
 * a rule fails on: until 0.22.0 an input built to make the loop check throw
 * turned a run that failed into one that passed (#1040).
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { EvalResult, EvalRuleResult } from '../../../src/types/eval.js';
import type { ToolCallRecord } from '../../../src/types/trace.js';

const engine = (overrides: Partial<typeof defaultConfig.eval> = {}, thresholds: Partial<typeof defaultConfig.eval.ruleThresholds> = {}): EvalEngine =>
  new EvalEngine(defaultConfig.eval.defaultThreshold, { ...defaultConfig.eval.ruleThresholds, ...thresholds }, { ...defaultConfig.eval, ...overrides });
const row = (result: EvalResult, name: string): EvalRuleResult => result.rule_results.find((r) => r.ruleName === name)!;
const threwIn = (result: EvalResult): string[] => result.rule_results.filter((r) => r.threw === true).map((r) => r.ruleName);
const sentences = (result: EvalResult): string => (result.interpretations ?? []).map((i) => i.text).join(' ');

const RUN = { input: 'Read the two source files and say what they export.', output: 'src/a.ts exports parse, and src/b.ts exports format.' };
const calls = (at: unknown): ToolCallRecord[] => [
  { tool_name: 'read_file', input: { path: 'src/a.ts', at } as ToolCallRecord['input'], output: 'export const parse = 1;' },
  { tool_name: 'read_file', input: { path: 'src/b.ts' }, output: 'export const format = 2;' },
];
/** The run with an input no rule can write out, and the same run with one every rule can. */
const unwritable = (): ToolCallRecord[] => calls(10n);
const writable = (): ToolCallRecord[] => calls(10);

describe('a rule that threw leaves the verdict unknown where its finding would have counted', () => {
  it('at the shipped settings, with nobody having asked: the run that passes clean is unknown when the loop check throws on it', async () => {
    const clean = await engine().evaluateAll({ ...RUN, toolCalls: writable() });
    expect(threwIn(clean)).toEqual([]);
    expect(clean.verdict).toMatchObject({ state: 'pass', basis: 'clean' });

    const result = await engine().evaluateAll({ ...RUN, toolCalls: unwritable() });
    expect(threwIn(result)).toContain('no_tool_loop');
    expect(row(result, 'no_tool_loop')).toMatchObject({ skipped: true, skipClass: 'defeated', threw: true });
    // Nobody asked for it and it is not critical: it is there because it threw.
    expect(row(result, 'no_tool_loop').asked).toBeUndefined();
    expect(row(result, 'no_tool_loop').critical).not.toBe(true);
    expect(result.verdict).toMatchObject({ state: 'unknown', passed: false, basis: 'critical_unknown' });
    expect(result.passed).toBe(false);
    expect(result.verdict!.by).toContain('no_tool_loop');
    // Every rule the verdict names threw, and none of them only reports.
    for (const name of result.verdict!.by) expect(threwIn(result), name).toContain(name);
    expect(sentences(result)).toContain('no_tool_loop, which failed while it judged this run');
    expect(sentences(result)).toContain('so this verdict is unknown rather than clean');
  });

  it('eval.onCriticalSkipped reads it as it reads a critical rule that could not answer', async () => {
    const failed = await engine({ onCriticalSkipped: 'fail' }).evaluateAll({ ...RUN, toolCalls: unwritable() });
    expect(failed.verdict).toMatchObject({ state: 'fail', passed: false, basis: 'critical_unknown' });
    const accepted = await engine({ onCriticalSkipped: 'pass' }).evaluateAll({ ...RUN, toolCalls: unwritable() });
    expect(threwIn(accepted)).toContain('no_tool_loop');
    expect(accepted.verdict!.basis).not.toBe('critical_unknown');
    expect(accepted.verdict!.state).toBe('pass');
  });

  it('a rule set to report only takes no part by its throw', async () => {
    const result = await engine().evaluateAll({ ...RUN, toolCalls: unwritable() });
    const named = result.verdict!.by;
    expect(named.length).toBeGreaterThan(0);
    // Each of them told to report: the verdict is the clean run's again, and the rows still say they threw.
    const reporting = await engine({ advisoryRules: named }).evaluateAll({ ...RUN, toolCalls: unwritable() });
    expect(threwIn(reporting)).toEqual(threwIn(result));
    for (const name of named) expect(row(reporting, name).asked, name).toBeUndefined();
    expect(reporting.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    // One of them told to report: the others still leave it unknown, and that one is not named.
    if (named.length > 1) {
      const one = await engine({ advisoryRules: [named[0]] }).evaluateAll({ ...RUN, toolCalls: unwritable() });
      expect(one.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
      expect(one.verdict!.by).toEqual(named.slice(1));
    }
  });
});

describe('a rule somebody asked for that could not answer leaves the verdict unknown, and the sentence says who asked', () => {
  it('the call asked: an expected trajectory whose comparison throws', async () => {
    // Both calls are expected, and the first expected input names the key that holds the BigInt, so the comparison reaches it.
    const expectedTrajectory = { tool_calls: [{ tool_name: 'read_file', input: { at: 10 } }, { tool_name: 'read_file' }] };
    const met = await engine().evaluateAll({ ...RUN, toolCalls: writable(), expectedTrajectory });
    expect(row(met, 'tool_sequence')).toMatchObject({ passed: true });
    expect(met.verdict).toMatchObject({ state: 'pass', basis: 'clean' });

    const result = await engine().evaluateAll({ ...RUN, toolCalls: unwritable(), expectedTrajectory });
    expect(row(result, 'tool_sequence')).toMatchObject({ skipped: true, skipClass: 'defeated', threw: true, asked: 'call' });
    expect(row(result, 'tool_sequence').critical).not.toBe(true);
    expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
    expect(result.verdict!.by).toContain('tool_sequence');
    expect(sentences(result)).toContain('tool_sequence, which this call asked for');
  });

  it('the deployment asked: a threshold it set on the rule that throws', async () => {
    const configured = engine({ configuredThresholdKeys: ['max_tool_repeats'] } as Partial<typeof defaultConfig.eval>, { max_tool_repeats: 2 });
    const result = await configured.evaluateAll({ ...RUN, toolCalls: unwritable() });
    expect(row(result, 'no_tool_loop')).toMatchObject({ skipped: true, skipClass: 'defeated', threw: true, asked: 'config' });
    expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
    expect(sentences(result)).toContain('no_tool_loop, which this deployment asked for');
    // Told to report only, the same rule is asked for by nobody, whatever threshold stands beside it.
    const reporting = engine({ configuredThresholdKeys: ['max_tool_repeats'], advisoryRules: ['no_tool_loop'] } as Partial<typeof defaultConfig.eval>, { max_tool_repeats: 2 });
    const silent = await reporting.evaluateAll({ ...RUN, toolCalls: unwritable() });
    expect(row(silent, 'no_tool_loop')).toMatchObject({ skipped: true, threw: true });
    expect(row(silent, 'no_tool_loop').asked).toBeUndefined();
    expect(silent.verdict!.by ?? []).not.toContain('no_tool_loop');
  });
});
