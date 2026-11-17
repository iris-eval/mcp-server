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
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { loadPlugins } from '../../../src/eval/plugins.js';
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
    // The bundle that holds a rule the verdict names is not a pass either, and one that holds none of them is.
    expect(result.categories?.cost).toMatchObject({ state: 'unknown', passed: null });
    expect(result.categories?.relevance).toMatchObject({ state: 'pass', passed: true });
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
    // Its row says it reports: that is what a stored row is read back by.
    for (const name of named) expect(row(reporting, name), name).toMatchObject({ skipped: true, threw: true, advisory: true });
    expect(reporting.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    // A rule set to report that skipped for want of something to judge took no part either way, and its row carries no standing, as before.
    const idle = await engine({ advisoryRules: named }).evaluateAll({ ...RUN });
    for (const name of named) {
      expect(row(idle, name), name).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
      expect(row(idle, name).advisory, name).toBeUndefined();
    }
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

describe('a gate that could not answer leaves the verdict unknown, whoever asked for it', () => {
  const REPORT = { input: 'Summarise the quarterly report in two sentences.', output: 'Revenue grew four percent on the quarter, led by the services line. Costs were flat and the margin widened by one point.' };
  // An embedder's own call: a cost that is text. The cost policy's sentence formats a number, and has no writing for it.
  const TEXT_COST = '0.25' as unknown as number;

  it('a built-in policy at its shipped threshold, where the deployment made shipped thresholds gate', async () => {
    const strict = engine({ defaultsGate: true });
    // Its fire decides here: the run that costs more than the shipped ceiling fails.
    const over = await strict.evaluateAll({ ...REPORT, costUsd: 0.25 });
    expect(row(over, 'cost_under_threshold')).toMatchObject({ passed: false, role: 'gate' });
    expect(over.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate', by: ['cost_under_threshold'] });
    // And so does its silence: the same rule, thrown.
    const threw = await strict.evaluateAll({ ...REPORT, costUsd: TEXT_COST });
    expect(row(threw, 'cost_under_threshold')).toMatchObject({ skipped: true, skipClass: 'defeated', threw: true, role: 'gate' });
    expect(row(threw, 'cost_under_threshold').asked).toBeUndefined();
    expect(threw.verdict).toMatchObject({ state: 'unknown', passed: false, basis: 'critical_unknown', by: ['cost_under_threshold'] });
    expect(sentences(threw)).toContain('cost_under_threshold, which failed while it judged this run');
    // The bundle that holds it is not a pass either.
    expect(threw.categories?.cost).toMatchObject({ state: 'unknown', passed: null });
  });

  it('the same policy at the shipped settings only reports, by its fire and by its throw, and its row says so both times', async () => {
    const over = await engine().evaluateAll({ ...REPORT, costUsd: 0.25 });
    expect(row(over, 'cost_under_threshold')).toMatchObject({ passed: false, role: 'advisory' });
    expect(over.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    const threw = await engine().evaluateAll({ ...REPORT, costUsd: TEXT_COST });
    // Read by its evidence alone, a row that threw has no threshold on it and was stamped a gate.
    expect(row(threw, 'cost_under_threshold')).toMatchObject({ skipped: true, threw: true, role: 'advisory' });
    expect(threw.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    // Where the deployment set the ceiling, it gates and has to answer.
    const set = await engine({ configuredThresholdKeys: ['cost_threshold'] } as Partial<typeof defaultConfig.eval>).evaluateAll({ ...REPORT, costUsd: TEXT_COST });
    expect(row(set, 'cost_under_threshold')).toMatchObject({ skipped: true, threw: true, asked: 'config', role: 'gate' });
    expect(set.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['cost_under_threshold'] });
    expect(sentences(set)).toContain('cost_under_threshold, which this deployment asked for');
  });

  it("a deployment's own policy, loaded as a plugin: one that throws, and one that answers in no shape a result has", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-plugin-gate-'));
    try {
      // A policy written in an afternoon: it reads the ask without checking that one was sent.
      const throwing = join(dir, 'no-refund-promise.mjs');
      writeFileSync(
        throwing,
        [
          "export default { name: 'no_refund_promise', kind: 'policy', mechanism: 'pattern', version: 1, needs: ['output', 'input'],",
          "  description: 'The answer must not promise a refund the ask did not mention.',",
          '  evaluate(ctx) {',
          "    const promised = ctx.output.toLowerCase().includes('refund') && !ctx.input.toLowerCase().includes('refund');",
          "    return { ruleName: 'no_refund_promise', passed: !promised, score: promised ? 0 : 1, message: promised ? 'The answer promises a refund the ask did not mention' : 'No refund promised' };",
          '  } };',
          '',
        ].join('\n'),
      );
      const shapeless = join(dir, 'always-shrugs.mjs');
      writeFileSync(shapeless, "export default { name: 'always_shrugs', kind: 'policy', mechanism: 'pattern', version: 1, needs: ['output'], evaluate() { return { passed: 'perhaps' }; } };\n");
      const loaded = async (path: string): Promise<EvalEngine> => {
        const e = engine();
        for (const p of await loadPlugins([{ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }])) e.registerRule(p.evalType, p.rule, p.id);
        return e;
      };
      const answer = 'You will get a full refund within five days, and the store opens at nine tomorrow morning.';
      // Its fire gates: the answer promises a refund nobody asked about.
      const fired = await (await loaded(throwing)).evaluateAll({ input: 'When does the store open tomorrow morning?', output: answer });
      expect(row(fired, 'no_refund_promise')).toMatchObject({ passed: false, role: 'gate', origin: 'plugin' });
      expect(fired.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate', by: ['no_refund_promise'] });
      // The same answer with no ask sent: the plugin throws, its own guard reports a broken rule, and the verdict is not a pass.
      const threw = await (await loaded(throwing)).evaluateAll({ output: answer });
      expect(row(threw, 'no_refund_promise')).toMatchObject({ skipped: true, skipClass: 'config_invalid', role: 'gate' });
      expect(row(threw, 'no_refund_promise').critical).not.toBe(true);
      expect(threw.verdict).toMatchObject({ state: 'unknown', passed: false, basis: 'critical_unknown', by: ['no_refund_promise'] });
      expect(sentences(threw)).toContain('no_refund_promise, which gates here');
      const shrugged = await (await loaded(shapeless)).evaluateAll({ output: answer });
      expect(row(shrugged, 'always_shrugs')).toMatchObject({ skipped: true, skipClass: 'config_invalid', role: 'gate' });
      expect(shrugged.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['always_shrugs'] });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });

  it('a custom rule below gating severity whose pattern does not compile: no part at the shipped settings, unknown where the deployment made defaults gate', async () => {
    const text = { ...REPORT, output: `${REPORT.output} Internal draft, do not circulate.` };
    const fires = { name: 'no_internal_draft', type: 'regex_no_match' as const, config: { pattern: 'internal draft', flags: 'i' } };
    const broken = { name: 'no_internal_draft', type: 'regex_no_match' as const, config: { pattern: '(internal draft', flags: 'i' } };
    // At the shipped settings such a rule advises, so neither its fire nor its broken pattern decides anything.
    const advises = await engine().evaluateAll({ ...text }, [fires]);
    expect(row(advises, 'no_internal_draft')).toMatchObject({ passed: false, role: 'advisory' });
    expect(advises.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    const quiet = await engine().evaluateAll({ ...text }, [broken]);
    expect(row(quiet, 'no_internal_draft')).toMatchObject({ skipped: true, skipClass: 'config_invalid', role: 'advisory' });
    expect(quiet.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    // Where the deployment made defaults gate, its fire gates, and so its broken pattern leaves the verdict unknown.
    const gated = await engine({ defaultsGate: true }).evaluateAll({ ...text }, [fires]);
    expect(row(gated, 'no_internal_draft')).toMatchObject({ passed: false, role: 'gate' });
    expect(gated.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate' });
    expect(gated.verdict!.by).toContain('no_internal_draft');
    const unknown = await engine({ defaultsGate: true }).evaluateAll({ ...text }, [broken]);
    expect(row(unknown, 'no_internal_draft')).toMatchObject({ skipped: true, skipClass: 'config_invalid', role: 'gate' });
    expect(unknown.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
    expect(unknown.verdict!.by).toContain('no_internal_draft');
  });
});

describe('a rule whose fire only reports', () => {
  const REPORT = { input: 'Summarise the quarterly report in two sentences.', output: 'Revenue grew four percent on the quarter, led by the services line. Costs were flat and the margin widened by one point.' };
  // An embedder's own call: a token count no rule can divide.
  const UNCOUNTABLE = { prompt_tokens: 100n as unknown as number, completion_tokens: 900 };

  it('a measurement nobody asked for takes no part by its throw; one the deployment set a threshold on has to answer, as it does when it lacks what it reads', async () => {
    const shipped = await engine().evaluateAll({ ...REPORT, tokenUsage: UNCOUNTABLE });
    expect(row(shipped, 'verbosity_ratio')).toMatchObject({ skipped: true, threw: true, role: 'advisory' });
    expect(row(shipped, 'verbosity_ratio').asked).toBeUndefined();
    expect(shipped.verdict!.by).not.toContain('verbosity_ratio');
    expect(shipped.verdict).toMatchObject({ state: 'pass', basis: 'clean' });

    const configured = (): EvalEngine => engine({ configuredThresholdKeys: ['max_token_ratio'] } as Partial<typeof defaultConfig.eval>, { max_token_ratio: 2 });
    // Its fire decides nothing, by the deployment's own threshold.
    const fired = await configured().evaluateAll({ ...REPORT, tokenUsage: { prompt_tokens: 100, completion_tokens: 900 } });
    expect(row(fired, 'verbosity_ratio')).toMatchObject({ passed: false, role: 'advisory' });
    expect(fired.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    // Asked for and thrown: unknown, as it is when the call leaves the token counts out.
    const threw = await configured().evaluateAll({ ...REPORT, tokenUsage: UNCOUNTABLE });
    expect(row(threw, 'verbosity_ratio')).toMatchObject({ skipped: true, threw: true, asked: 'config' });
    expect(threw.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['verbosity_ratio'] });
    expect(sentences(threw)).toContain('verbosity_ratio, which this deployment asked for');
    const lacking = await configured().evaluateAll({ ...REPORT });
    expect(row(lacking, 'verbosity_ratio')).toMatchObject({ skipped: true, asked: 'config', lacked: ['tokens'] });
    expect(lacking.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing' });
  });

  it('a rule the deployment set to report is asked for by nobody, whatever threshold stands beside it: it takes no part when it lacks what it reads', async () => {
    const thresholds = { configuredThresholdKeys: ['max_tool_repeats'] } as Partial<typeof defaultConfig.eval>;
    // With the threshold set and the rule weighed, a call that sends no tool calls is not checked: the deployment asked for the loop check.
    const asked = await engine(thresholds, { max_tool_repeats: 2 }).evaluateAll({ ...REPORT });
    expect(row(asked, 'no_tool_loop')).toMatchObject({ skipped: true, skipClass: 'not_applicable', asked: 'config', lacked: ['tool_calls'] });
    expect(asked.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    // Set to report as well, its fire would change no verdict, and neither does its having nothing to read.
    const reporting = await engine({ ...thresholds, advisoryRules: ['no_tool_loop'] }, { max_tool_repeats: 2 }).evaluateAll({ ...REPORT });
    expect(row(reporting, 'no_tool_loop')).toMatchObject({ skipped: true, skipClass: 'not_applicable', lacked: ['tool_calls'] });
    expect(row(reporting, 'no_tool_loop').asked).toBeUndefined();
    expect(reporting.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    // The same for a threshold the call sets, and for the other weighed rule that carries one.
    const byCall = await engine({ advisoryRules: ['no_tool_loop'] }).evaluateAll({ ...REPORT, customConfig: { max_tool_repeats: 2 } });
    expect(row(byCall, 'no_tool_loop').asked).toBeUndefined();
    expect(byCall.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    const choice = { configuredThresholdKeys: ['tool_choice_margin'] } as Partial<typeof defaultConfig.eval>;
    expect((await engine(choice).evaluateAll({ ...REPORT })).verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing' });
    expect((await engine({ ...choice, advisoryRules: ['tool_choice'] }).evaluateAll({ ...REPORT })).verdict).toMatchObject({ state: 'pass', basis: 'clean' });
  });
});
