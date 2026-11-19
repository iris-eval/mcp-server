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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import type { RelevanceJudge } from '../../../src/eval/llm-judge/relevance-judge.js';
import { loadPlugins } from '../../../src/eval/plugins.js';
import { noUnusualAction } from '../../../src/eval/rules/case-history.js';
import { noToolLoop } from '../../../src/eval/rules/cost.js';
import { rulesByType } from '../../../src/eval/rules/index.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { CaseRun, EvalContext, EvalResult, EvalRule, EvalRuleResult, RuleAnswer } from '../../../src/types/eval.js';
import type { ToolCallRecord, ToolDescriptor } from '../../../src/types/trace.js';

afterEach(() => {
  vi.restoreAllMocks();
});

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
    // A rule set to report says so on every row, one that had nothing to judge among them: it is a fact about the rule here, and the role reads it.
    const idle = await engine({ advisoryRules: named }).evaluateAll({ ...RUN });
    for (const name of named) expect(row(idle, name), name).toMatchObject({ skipped: true, skipClass: 'not_applicable', advisory: true, role: 'advisory' });
    // Not set to report, a row that had nothing to judge carries no such mark.
    const plain = await engine().evaluateAll({ ...RUN });
    for (const name of named) expect(row(plain, name).advisory, name).toBeUndefined();
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


/*
 * The role of a row that could not answer is read from the row, as an
 * answered row's is. An answer carries two facts the composer reads: that
 * the result only reports, and why; and whose number a policy compared
 * against. A row with no answer has no answer to carry them, so the engine
 * writes them on the row from the rule in hand. Each test below is a place
 * where, read from the answer alone, a rule's silence counted and its fire
 * did not, or the other way about.
 */
describe('a rule that only reports for a reason of its own says so when it could not answer, and takes no part then either', () => {
  // no_unusual_action is weighed from five earlier runs of the case. Read against fewer it reports, a fire as much as a pass.
  const REFUND = {
    input: 'Refund order 1182 and tell the customer it is done.',
    output: 'The refund for order 1182 was issued today, and the customer was sent an email that confirms it.',
    toolCalls: [
      { tool_name: 'get_order', input: { id: 1182 }, output: '{"id":1182,"status":"paid","total":40}' },
      { tool_name: 'send_email', input: { to: 'customer@example.com', subject: 'Your refund', body: 'The refund for order 1182 was issued today.' }, output: 'sent' },
    ],
  };
  const earlier = (n: number): CaseRun[] => Array.from({ length: n }, () => ({ tools: ['get_order'] }));
  // An earlier run whose list of tools holds a number where a name belongs: an embedder's own history can carry one, the store's cannot. From four earlier runs on, each is read against the rest, and the rule fails on it.
  const withANumber = (n: number): CaseRun[] => [...earlier(n - 1), { tools: ['get_order', 7 as unknown as string] }];
  const why = (n: number): string => `the case has ${n} earlier runs by this agent, and the rule is weighed in the verdict from 5`;

  it('read against four earlier runs: its fire reports and takes no part, and so does its throw', async () => {
    const fired = await engine().evaluateAll({ ...REFUND, caseHistory: earlier(4) });
    expect(row(fired, 'no_unusual_action')).toMatchObject({ passed: false, advisory: true, advisoryWhy: why(4), role: 'advisory' });
    expect(fired.verdict).toMatchObject({ state: 'pass', basis: 'clean' });

    const threw = await engine().evaluateAll({ ...REFUND, caseHistory: withANumber(4) });
    // The row has no answer to carry the reason: the engine asked the rule's declaration for it.
    expect(row(threw, 'no_unusual_action')).toMatchObject({ skipped: true, skipClass: 'defeated', threw: true, advisory: true, advisoryWhy: why(4), role: 'advisory' });
    expect(threw.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    expect(threw.verdict!.by).not.toContain('no_unusual_action');
    expect(threw.categories?.completeness).toMatchObject({ state: 'pass', passed: true });
    // A deployment that fails an unanswered check is not failed by this one either.
    const strict = await engine({ onCriticalSkipped: 'fail' }).evaluateAll({ ...REFUND, caseHistory: withANumber(4) });
    expect(row(strict, 'no_unusual_action')).toMatchObject({ threw: true, role: 'advisory' });
    expect(strict.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
  });

  it('read against five: its fire is weighed and fails the verdict, and its throw leaves the verdict unknown', async () => {
    const fired = await engine().evaluateAll({ ...REFUND, caseHistory: earlier(5) });
    expect(row(fired, 'no_unusual_action')).toMatchObject({ passed: false, role: 'risk' });
    expect(row(fired, 'no_unusual_action').advisory).toBeUndefined();
    expect(fired.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });

    const threw = await engine().evaluateAll({ ...REFUND, caseHistory: withANumber(5) });
    expect(row(threw, 'no_unusual_action')).toMatchObject({ skipped: true, threw: true, role: 'risk' });
    expect(row(threw, 'no_unusual_action').advisory).toBeUndefined();
    expect(row(threw, 'no_unusual_action').advisoryWhy).toBeUndefined();
    expect(threw.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['no_unusual_action'] });
    expect(sentences(threw)).toContain('no_unusual_action, which failed while it judged this run');
  });

  it('the declaration and the answer give the same words, from zero earlier runs to the first at which the rule is weighed', async () => {
    for (const n of [0, 1, 2, 3, 4]) expect(noUnusualAction.reportsOnly!({ ...REFUND, caseHistory: earlier(n) } as EvalContext), `${n} earlier runs`).toBe(n === 1 ? 'the case has 1 earlier run by this agent, and the rule is weighed in the verdict from 5' : why(n));
    for (const n of [5, 6, 20, 40]) expect(noUnusualAction.reportsOnly!({ ...REFUND, caseHistory: earlier(n) } as EvalContext), `${n} earlier runs`).toBeUndefined();
    // A call with no stored case behind it has no earlier run to read against.
    expect(noUnusualAction.reportsOnly!({ ...REFUND } as EvalContext)).toBe(why(0));
    // A run whose calls were not recorded is not one of them.
    expect(noUnusualAction.reportsOnly!({ ...REFUND, caseHistory: [...earlier(4), { tools: null }, { tools: null }] } as EvalContext)).toBe(why(4));
    // And where the rule answers, its result carries the declaration's words: three and four earlier runs.
    for (const n of [3, 4]) {
      const answered = await engine().evaluateAll({ ...REFUND, caseHistory: earlier(n) });
      expect(row(answered, 'no_unusual_action').advisoryWhy, `${n} earlier runs`).toBe(noUnusualAction.reportsOnly!({ ...REFUND, caseHistory: earlier(n) } as EvalContext));
    }
  });

  it('a declaration that throws, or that gives no words, gives no reason: the row is read as the rule is weighed', async () => {
    for (const broken of [
      (): string => {
        throw new Error('the declaration itself failed');
      },
      (): string => '   ',
      (): string => 7 as unknown as string,
    ]) {
      vi.spyOn(noUnusualAction, 'reportsOnly').mockImplementation(broken);
      const threw = await engine().evaluateAll({ ...REFUND, caseHistory: withANumber(4) });
      expect(row(threw, 'no_unusual_action')).toMatchObject({ skipped: true, threw: true, role: 'risk' });
      expect(row(threw, 'no_unusual_action').advisory).toBeUndefined();
      expect(threw.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['no_unusual_action'] });
      vi.restoreAllMocks();
    }
  });

  it('a call the rule had nothing to judge in carries no mark: the reason goes with an answer, or with a silence where there was something to judge', async () => {
    // No tool calls were sent, so the rule has nothing to read, against four earlier runs as against none.
    const nothing = await engine().evaluateAll({ input: REFUND.input, output: REFUND.output, caseHistory: earlier(4) });
    expect(row(nothing, 'no_unusual_action')).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
    expect(row(nothing, 'no_unusual_action').advisory).toBeUndefined();
    expect(row(nothing, 'no_unusual_action').advisoryWhy).toBeUndefined();
    expect(nothing.verdict!.by).not.toContain('no_unusual_action');
  });

  it('a deployment that made the rule critical has said every fire of it decides: its reason gives way on a silence as on an answer', async () => {
    const promoted = await engine({ criticalRules: ['no_unusual_action'] }).evaluateAll({ ...REFUND, caseHistory: withANumber(4) });
    expect(row(promoted, 'no_unusual_action')).toMatchObject({ skipped: true, threw: true, critical: true, role: 'veto' });
    expect(row(promoted, 'no_unusual_action').advisory).toBeUndefined();
    expect(promoted.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['no_unusual_action'] });
  });
});

describe('a rule the deployment set to report says so however it came to give no answer', () => {
  const ASK = 'Which file defines the retry policy, and what is the limit it sets?';
  const ANSWER = 'The retry policy is defined in src/payments/retry.ts, and it sets a limit of five attempts with a doubling delay between them.';
  const READ = { tool_name: 'read_file', input: { path: 'src/payments/retry.ts' }, output: 'export const RETRY_LIMIT = 5; // src/payments/retry.ts doubles the delay' };
  // Three reads that together carry 60,000 distinct identifiers, where grounded_in_reads indexes 50,000: its record is cut.
  const names = (from: number, n: number): string => Array.from({ length: n }, (_, i) => `mod_${String(from + i).padStart(6, '0')}.ts`).join('\n');
  const manyReads = (): ToolCallRecord[] => [0, 1, 2].map((k) => ({ tool_name: 'list_files', input: { page: k }, output: names(k * 20_000, 20_000) }));
  // A catalogue whose one schema carries a pattern that does not compile: valid_tool_arguments has a broken definition for the tool that was called.
  const brokenCatalogue: ToolDescriptor[] = [{ name: 'read_file', description: 'Read a file from the repository by its path.', inputSchema: { type: 'object', properties: { path: { type: 'string', pattern: '(' } }, required: ['path'] } }];

  const WAYS: Array<{ way: string; rule: string; context: () => EvalContext; flag: Partial<EvalRuleResult> }> = [
    { way: 'it threw', rule: 'no_tool_loop', context: () => ({ input: ASK, output: ANSWER, toolCalls: [{ ...READ, input: { path: 'src/payments/retry.ts', size: 10n } as ToolCallRecord['input'] }] }), flag: { threw: true, skipClass: 'defeated' } },
    { way: 'its record was cut', rule: 'grounded_in_reads', context: () => ({ input: ASK, output: ANSWER, toolCalls: manyReads() }), flag: { evidenceIncomplete: true, skipClass: 'defeated' } },
    { way: 'its definition is broken', rule: 'valid_tool_arguments', context: () => ({ input: ASK, output: ANSWER, toolCalls: [READ], tools: brokenCatalogue }), flag: { configInvalid: true, skipClass: 'config_invalid' } },
  ];

  it.each(WAYS)('$rule, where $way: a weighed rule as shipped, and one that reports where the deployment said so', async ({ rule, context, flag }) => {
    const shipped = await engine().evaluateAll(context());
    expect(row(shipped, rule)).toMatchObject({ skipped: true, ...flag, role: 'risk' });
    expect(row(shipped, rule).advisory).toBeUndefined();

    const reporting = await engine({ advisoryRules: [rule] }).evaluateAll(context());
    expect(row(reporting, rule)).toMatchObject({ skipped: true, ...flag, advisory: true, role: 'advisory' });
    // The deployment's list is the standing reason: no reason of the rule's own is written beside it.
    expect(row(reporting, rule).advisoryWhy).toBeUndefined();
    expect(row(reporting, rule).asked).toBeUndefined();
    expect(reporting.verdict!.by).not.toContain(rule);
    expect((reporting.verdict!.also ?? []).flatMap((l) => l.by)).not.toContain(rule);
  });

  it('stopped at a limit of work, which no built-in detection meets by itself: the mark is there for it too', async () => {
    // The fourth way, forced: a detection's regex killed at the sandbox budget. Custom rules meet it, and they are policies; this stands a built-in detection in that place for one evaluation.
    vi.spyOn(noToolLoop, 'evaluate').mockReturnValue({ ruleName: 'no_tool_loop', passed: false, score: 0, message: 'Not judged: the matching budget ran out on this output', skipped: true, skipClass: 'defeated', skipReason: 'regex budget exceeded', budgetExceeded: true });
    const shipped = await engine().evaluateAll({ input: ASK, output: ANSWER, toolCalls: [READ] });
    expect(row(shipped, 'no_tool_loop')).toMatchObject({ skipped: true, budgetExceeded: true, skipClass: 'defeated', role: 'risk' });
    expect(row(shipped, 'no_tool_loop').advisory).toBeUndefined();
    const reporting = await engine({ advisoryRules: ['no_tool_loop'] }).evaluateAll({ input: ASK, output: ANSWER, toolCalls: [READ] });
    expect(row(reporting, 'no_tool_loop')).toMatchObject({ skipped: true, budgetExceeded: true, advisory: true, role: 'advisory' });
  });
});

describe('a weighed rule that could not answer counts when it threw, and takes no part stopped any other way', () => {
  const REFUND_TOOL = (pattern: string): ToolDescriptor[] => [
    { name: 'issue_refund', description: 'Issue a refund for an order, by order id and amount in cents.', inputSchema: { type: 'object', properties: { order_id: { type: 'string', pattern }, amount_cents: { type: 'integer' } }, required: ['order_id', 'amount_cents'] } },
  ];
  // The call lacks a required argument, amount_cents.
  const RUN_ONE = {
    input: 'Issue a refund for order A-1182 of the full amount.',
    output: 'The refund for order A-1182 was issued for the full amount, and the order now shows as refunded.',
    toolCalls: [{ tool_name: 'issue_refund', input: { order_id: 'A-1182' }, output: 'ok' }],
  };

  it('valid_tool_arguments with a schema that does not compile: no part as shipped, and has to answer where the deployment made it critical', async () => {
    const fired = await engine().evaluateAll({ ...RUN_ONE, tools: REFUND_TOOL('^A-') });
    expect(row(fired, 'valid_tool_arguments')).toMatchObject({ passed: false, role: 'risk' });
    expect(fired.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
    // The same call, with a pattern in the tool's schema that does not compile: the rule cannot check the call, and says so on its row.
    const broken = await engine().evaluateAll({ ...RUN_ONE, tools: REFUND_TOOL('(') });
    expect(row(broken, 'valid_tool_arguments')).toMatchObject({ skipped: true, skipClass: 'config_invalid', configInvalid: true, role: 'risk' });
    // It is weighed, and it did not throw: the third layer does not name it, here or where an unanswered check is a failure.
    expect(broken.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    expect((await engine({ onCriticalSkipped: 'fail' }).evaluateAll({ ...RUN_ONE, tools: REFUND_TOOL('(') })).verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    // Made critical by the deployment, it has to answer, as on every earlier release.
    const promoted = await engine({ criticalRules: ['valid_tool_arguments'] }).evaluateAll({ ...RUN_ONE, tools: REFUND_TOOL('(') });
    expect(promoted.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['valid_tool_arguments'] });
  });
});

describe('whose number a rule stood at is written on a row that could not answer, by the rule in hand', () => {
  const REPORT = { input: 'Summarise the quarterly report in two sentences.', output: 'Revenue grew four percent on the quarter, led by the services line. Costs were flat and the margin widened by one point.' };
  const TEXT_COST = '0.25' as unknown as number;

  it('a built-in policy that threw carries it: the number Iris ships, or one somebody set', async () => {
    const shipped = await engine().evaluateAll({ ...REPORT, costUsd: TEXT_COST });
    expect(row(shipped, 'cost_under_threshold')).toMatchObject({ skipped: true, threw: true, thresholdSource: 'default', role: 'advisory' });
    expect(row(shipped, 'cost_under_threshold').asked).toBeUndefined();
    const byConfig = await engine({ configuredThresholdKeys: ['cost_threshold'] } as Partial<typeof defaultConfig.eval>).evaluateAll({ ...REPORT, costUsd: TEXT_COST });
    expect(row(byConfig, 'cost_under_threshold')).toMatchObject({ skipped: true, threw: true, thresholdSource: 'config', asked: 'config', role: 'gate' });
    const byCall = await engine().evaluateAll({ ...REPORT, costUsd: TEXT_COST, customConfig: { cost_threshold: 0.1 } });
    expect(row(byCall, 'cost_under_threshold')).toMatchObject({ skipped: true, threw: true, thresholdSource: 'config', asked: 'call', role: 'gate' });
    expect(byCall.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['cost_under_threshold'] });
  });

  it('the rules that carry it are the ones that declare a threshold, and the published schema names each of them', () => {
    const declare = [...new Set(Object.values(rulesByType).flatMap((rules) => rules.filter((r) => (r.thresholdKeys ?? []).length > 0).map((r) => r.name)))].sort();
    expect(declare).toEqual(['answers_the_ask', 'cost_under_threshold', 'max_steps', 'no_tool_loop', 'tool_choice', 'verbosity_ratio']);
    // The file a client reads (website/public/response-schema-v1.json), not the source it is rendered from.
    const published = readFileSync(join(__dirname, '..', '..', '..', 'website', 'public', 'response-schema-v1.json'), 'utf8');
    const named = /of a rule that declares the threshold it compares against \(([^)]+) do\)/.exec(published);
    expect(named?.[1].split(/, | and /).sort()).toEqual(declare);
  });

  it('an answered row says it on its evidence and carries no such field, and neither does a row that had nothing to judge', async () => {
    const answered = await engine().evaluateAll({ ...REPORT, costUsd: 0.25 });
    expect(row(answered, 'cost_under_threshold').thresholdSource).toBeUndefined();
    expect(row(answered, 'cost_under_threshold').evidence).toContainEqual(expect.objectContaining({ type: 'count', thresholdSource: 'default' }));
    const idle = await engine().evaluateAll({ ...REPORT });
    expect(row(idle, 'cost_under_threshold')).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
    expect(row(idle, 'cost_under_threshold').thresholdSource).toBeUndefined();
  });

  it('a weighed rule with a threshold carries it too: it is a fact about the rule and the call', async () => {
    const shipped = await engine().evaluateAll({ ...RUN, toolCalls: unwritable() });
    expect(row(shipped, 'no_tool_loop')).toMatchObject({ threw: true, thresholdSource: 'default' });
    const set = await engine({ configuredThresholdKeys: ['max_tool_repeats'] } as Partial<typeof defaultConfig.eval>, { max_tool_repeats: 2 }).evaluateAll({ ...RUN, toolCalls: unwritable() });
    expect(row(set, 'no_tool_loop')).toMatchObject({ threw: true, thresholdSource: 'config', asked: 'config' });
  });

  /*
   * A rule object of an embedder's own, registered in code, may carry any
   * name: a built-in policy's among them. It declares no threshold, so its
   * row carries none, and it is read as the policy it is. Looked up by its
   * name among the built-in policies, it was read as the step ceiling at
   * its shipped number: it gated by its fire and passed clean by its throw.
   */
  const namesItsTicket = (name: string): EvalRule => ({
    name,
    description: 'The answer names the ticket it closes.',
    evalType: 'custom',
    weight: 1,
    critical: false,
    kind: 'policy',
    mechanism: 'pattern',
    needs: ['output'],
    version: 1,
    evaluate(ctx: EvalContext): RuleAnswer {
      // It reads a field of the embedder's own metadata without checking that it is there.
      const ticket = String((ctx.metadata as { ticket: string }).ticket).toUpperCase();
      const passed = ctx.output.toUpperCase().includes(ticket);
      return { ruleName: name, passed, score: passed ? 1 : 0, message: passed ? 'The answer names its ticket' : `The answer does not name ${ticket}` };
    },
  });
  const CLOSE = { input: 'Close the ticket and say what was done.', output: 'The retry limit was raised to five and the test for it was added; the change is merged.' };
  const own = (result: EvalResult, name: string): EvalRuleResult => result.rule_results.find((r) => r.ruleName === name && r.category === 'custom')!;

  it.each([['names_its_ticket'], ['max_steps'], ['cost_under_threshold'], ['answers_the_ask']])("an embedder's own policy named %s gates by its fire, and leaves the verdict unknown by its throw", async (name) => {
    const e = engine();
    e.registerRule('custom', namesItsTicket(name), `embedder:${name}`);
    const fired = await e.evaluateAll({ ...CLOSE, metadata: { ticket: 'ops-482' } });
    expect(own(fired, name)).toMatchObject({ passed: false, role: 'gate' });
    expect(fired.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate', by: [name] });
    const threw = await e.evaluateAll({ ...CLOSE });
    expect(own(threw, name)).toMatchObject({ skipped: true, threw: true, role: 'gate' });
    expect(own(threw, name).thresholdSource).toBeUndefined();
    expect(threw.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: [name] });
    // The sentence is of the row the layer named, not of the first row that carries the name: the built-in of that name skipped beside it.
    expect(sentences(threw)).toContain(`${name}, which failed while it judged this run`);
  });

  it('a rule that writes the field on its own result does not keep it: the standing of a row is the engine\'s to say', async () => {
    const e = engine();
    e.registerRule(
      'custom',
      {
        ...namesItsTicket('names_its_ticket'),
        evaluate: (): RuleAnswer => ({ ruleName: 'names_its_ticket', passed: false, score: 0, message: 'Not judged', skipped: true, skipClass: 'config_invalid', skipReason: 'broken', configInvalid: true, thresholdSource: 'default' }),
      },
      'embedder:names_its_ticket',
    );
    const result = await e.evaluateAll({ ...CLOSE });
    expect(own(result, 'names_its_ticket')).toMatchObject({ skipped: true, skipClass: 'config_invalid', role: 'gate' });
    expect(own(result, 'names_its_ticket').thresholdSource).toBeUndefined();
    expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['names_its_ticket'] });
  });
});

describe("a plugin's policy that could not answer is read as a gate, whatever its fire carries", () => {
  /*
   * When a plugin's policy fires, the composer reads its standing off the
   * evidence it returns: a count against a threshold that names no source
   * is read as a number Iris ships, and advises. A row with no answer has
   * no evidence, and a policy that declares no threshold of its own is a
   * gate. So for a plugin that returns such a count the two disagree: its
   * fire is told that it did not decide, and its silence leaves the verdict
   * unknown. This holds both, as they are, so that whichever reading of a
   * plugin's policy is settled on changes them knowingly.
   */
  it('a plugin whose count names no source: its fire advises, and its throw leaves the verdict unknown', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-plugin-advises-'));
    try {
      const path = join(dir, 'answer-length-floor.mjs');
      writeFileSync(
        path,
        [
          "export default { name: 'answer_length_floor', kind: 'policy', mechanism: 'formula', version: 1, needs: ['output', 'input'],",
          "  description: 'An answer to an ask of more than 40 characters must be at least 80 characters.',",
          '  evaluate(ctx) {',
          '    const long = ctx.input.length > 40;',
          '    const passed = !long || ctx.output.length >= 80;',
          "    return { ruleName: 'answer_length_floor', passed, score: passed ? 1 : 0, message: passed ? 'Long enough' : 'Too short for its ask',",
          "      evidence: [{ type: 'count', stat: 'length', unit: 'chars', value: ctx.output.length, threshold: 80 }] };",
          '  } };',
          '',
        ].join('\n'),
      );
      const e = engine();
      for (const p of await loadPlugins([{ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }])) e.registerRule(p.evalType, p.rule, p.id);
      const short = 'It opens at nine.';
      const fired = await e.evaluateAll({ input: 'When does the store on the high street open tomorrow morning?', output: short });
      expect(row(fired, 'answer_length_floor')).toMatchObject({ passed: false, role: 'advisory', origin: 'plugin' });
      expect(fired.verdict!.by).not.toContain('answer_length_floor');
      // The same answer with no ask sent: the plugin throws, and its row has no evidence to be read by.
      const threw = await e.evaluateAll({ output: short });
      expect(row(threw, 'answer_length_floor')).toMatchObject({ skipped: true, skipClass: 'config_invalid', role: 'gate' });
      expect(row(threw, 'answer_length_floor').thresholdSource).toBeUndefined();
      expect(threw.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['answer_length_floor'] });
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});


/*
 * A request can send an inline rule under the name of a rule Iris ships.
 * Who asked for a rule, and which rows the estimate rests on, are asked of
 * the rule in hand and of the row, never of a name; and what a row says of
 * who asked is the engine's to say, like the rest of its standing.
 */
describe('a rule a request sends under the name of a rule Iris ships is read as what it is', () => {
  // A stand-in for the relevance judge: an object with the interface the engine calls. No model is called and no key is read.
  const standIn = (): RelevanceJudge =>
    ({
      provider: 'anthropic',
      model: 'stand-in-judge',
      problem: null,
      budget: {},
      maxCallsPerRequest: 100,
      redact: true,
      notes: [],
      judge: async () => ({ template: 'relevance', provider: 'anthropic', model: 'stand-in-judge', costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 1, score: 0.9, passThreshold: 0.7, passed: true, rationale: 'on the subject' }),
    }) as unknown as RelevanceJudge;
  const judged = (overrides: Partial<typeof defaultConfig.eval> = {}): EvalEngine => {
    const e = engine(overrides);
    e.setRelevanceJudge(standIn());
    return e;
  };
  const REPORT = { input: 'Summarise the quarterly report in two sentences.', output: 'Revenue grew four percent on the quarter, led by the services line. Costs were flat and the margin widened by one point.' };
  const custom = (result: EvalResult, name: string): EvalRuleResult => result.rule_results.find((r) => r.ruleName === name && r.origin === 'custom')!;
  const builtIn = (result: EvalResult, name: string): EvalRuleResult => result.rule_results.find((r) => r.ruleName === name && r.origin !== 'custom')!;

  it('an installed judge asks for the rule it answers for, and not for an inline rule called answers_the_ask', async () => {
    // No gating severity, and a pattern that does not compile: the rule could not answer, and its fire would have taken no part.
    const broken = { name: 'answers_the_ask', type: 'regex_no_match' as const, config: { pattern: '(margin widened', flags: 'i' } };
    const result = await judged().evaluateAll({ ...REPORT }, [broken]);
    expect(custom(result, 'answers_the_ask')).toMatchObject({ skipped: true, skipClass: 'config_invalid', role: 'advisory' });
    expect(custom(result, 'answers_the_ask').asked).toBeUndefined();
    // The rule the judge answers for answered, as a judgment.
    expect(builtIn(result, 'answers_the_ask')).toMatchObject({ passed: true, kind: 'judgment', role: 'gate' });
    expect(result.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
    expect(sentences(result)).not.toContain('which this deployment asked for');
    expect(result.categories?.relevance).toMatchObject({ state: 'pass', passed: true });
    // A deployment that fails an unanswered check is not failed by this one.
    expect((await judged({ onCriticalSkipped: 'fail' }).evaluateAll({ ...REPORT }, [broken])).verdict).toMatchObject({ state: 'pass', basis: 'clean' });
  });

  it('nor for one of that name that lacks what it reads, which the name alone used to ask for', async () => {
    // A cost ceiling of the call's own, under that name, on a call that sent no cost.
    const ceiling = { name: 'answers_the_ask', type: 'cost_threshold' as const, config: { max_cost: 0.5 } };
    const result = await judged().evaluateAll({ ...REPORT }, [ceiling]);
    expect(custom(result, 'answers_the_ask')).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
    expect(custom(result, 'answers_the_ask').asked).toBeUndefined();
    expect(result.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
  });

  it('the rule the judge answers for is still asked for by the deployment: with no ask sent, the verdict is not checked', async () => {
    const result = await judged().evaluateAll({ output: REPORT.output });
    expect(builtIn(result, 'answers_the_ask')).toMatchObject({ skipped: true, skipClass: 'not_applicable', asked: 'config' });
    expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing' });
  });

  it('nor for a rule registered in code under that name: the judge answers for the rule Iris ships, whatever else is called by its name', async () => {
    // A deployment's own measurement, registered under the name, that reads a cost. The call sends none.
    const own: EvalRule = {
      name: 'answers_the_ask',
      description: "A measurement of the deployment's own, under the name of the rule the judge answers for.",
      evalType: 'custom',
      weight: 1,
      critical: false,
      kind: 'measurement',
      mechanism: 'formula',
      needs: ['output', 'cost'],
      version: 1,
      evaluate: (ctx): RuleAnswer =>
        typeof ctx.costUsd === 'number'
          ? { ruleName: 'answers_the_ask', passed: true, score: 1, message: 'Measured' }
          : { ruleName: 'answers_the_ask', passed: true, score: 1, message: 'No cost to measure', skipped: true, skipClass: 'not_applicable', skipReason: 'no cost provided' },
    };
    const e = judged();
    e.registerRule('custom', own, 'embedder:answers_the_ask');
    const result = await e.evaluateAll({ ...REPORT });
    const rows = result.rule_results.filter((r) => r.ruleName === 'answers_the_ask');
    expect(rows).toHaveLength(2);
    const registered = rows.find((r) => r.kind === 'measurement')!;
    expect(registered).toMatchObject({ skipped: true, skipClass: 'not_applicable', lacked: ['cost'] });
    expect(registered.asked).toBeUndefined();
    // The rule the judge answers for answered, and nothing the deployment asked for is missing.
    expect(rows.find((r) => r.kind === 'judgment')).toMatchObject({ passed: true, role: 'gate' });
    expect(result.verdict).toMatchObject({ state: 'pass', basis: 'clean' });
  });

  it('the note beside a failed risk estimate names the weighed fire once, whatever custom rule carries its name', async () => {
    // An unfilled template: no_stub_output fires, and at the shipped settings the estimate fails the verdict on it.
    const TEMPLATE = { output: 'TODO: write the summary.' };
    const ONE = 'rests on no_stub_output. If its fires are not failures on your traffic';
    const alone = await engine().evaluateAll({ ...TEMPLATE });
    expect(alone.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['stub'] });
    expect(sentences(alone)).toContain(ONE);
    // An inline rule of that name that passes, and one that fires: a policy the estimate does not read.
    const passes = { name: 'no_stub_output', type: 'regex_no_match' as const, config: { pattern: 'internal draft', flags: 'i' } };
    const fires = { name: 'no_stub_output', type: 'regex_no_match' as const, config: { pattern: 'write the summary', flags: 'i' } };
    for (const [what, rule] of [['passes', passes], ['fires', fires]] as const) {
      const result = await engine().evaluateAll({ ...TEMPLATE }, [rule]);
      expect(custom(result, 'no_stub_output'), what).toMatchObject({ passed: what === 'passes', kind: 'policy', role: 'advisory' });
      expect(result.verdict, what).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['stub'] });
      expect(sentences(result), what).toContain(ONE);
      expect(sentences(result), what).not.toContain('no_stub_output, no_stub_output');
    }
  });

  it('a result that says who asked for its rule, or what it lacked, is not taken at its word', async () => {
    // A deployment's own detection, registered in code, stopped at a limit of work of its own. It has no published accuracy: its fire takes no part.
    const scan = (said: Partial<EvalRuleResult>): EvalRule => ({
      name: 'limit_scan',
      description: 'A scan that stops at a limit of work.',
      evalType: 'custom',
      weight: 1,
      critical: false,
      kind: 'detection',
      mechanism: 'pattern',
      needs: ['output'],
      version: 1,
      evaluate: (): RuleAnswer => ({ ruleName: 'limit_scan', passed: false, score: 0, message: 'Stopped at its limit', skipped: true, skipClass: 'defeated', skipReason: 'stopped at its limit', budgetExceeded: true, ...said }),
    });
    for (const said of [{}, { asked: 'config' as const }, { asked: 'call' as const }, { lacked: ['cost' as const] }, { asked: 'config' as const, lacked: ['cost' as const] }]) {
      const e = engine();
      e.registerRule('custom', scan(said), 'embedder:limit_scan');
      const result = await e.evaluateAll({ ...REPORT });
      const own = row(result, 'limit_scan');
      expect(own, JSON.stringify(said)).toMatchObject({ skipped: true, skipClass: 'defeated', role: 'advisory' });
      expect(own.asked, JSON.stringify(said)).toBeUndefined();
      expect(own.lacked, JSON.stringify(said)).toBeUndefined();
      expect(result.verdict, JSON.stringify(said)).toMatchObject({ state: 'pass', basis: 'clean' });
    }
  });

  it('a context with a step list of its own and no tool calls: the rows and the evidence record say one thing, that no tool call was carried', async () => {
    // The engine derives the list it hands the rules from the calls and the spans, and the rules saw no call.
    const steps = [{ index: 0, kind: 'tool', name: 'get_order', source: 'tool_call', status: 'ok', input: { id: 1182 }, output: 'paid' }] as unknown as EvalContext['steps'];
    const e = engine({ configuredThresholdKeys: ['max_tool_repeats', 'max_steps'] } as Partial<typeof defaultConfig.eval>, { max_tool_repeats: 2, max_steps: 6 });
    const result = await e.evaluateAll({ ...REPORT, steps });
    expect(row(result, 'no_tool_loop')).toMatchObject({ skipped: true, skipClass: 'not_applicable', lacked: ['tool_calls'], asked: 'config' });
    expect(result.provenance?.evidence?.carried).not.toContain('tool_calls');
    expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
  });
});

/*
 * What a call carried is what was sent. The engine hands its rules one
 * context, and a deployment's own rule can write to it: default a missing
 * cost for its own arithmetic, fill in a list, say who recorded the trace.
 * The record of what the call carried is taken before any rule runs, so
 * nothing a rule writes becomes evidence, and required evidence that was
 * not sent stays missing.
 */
describe('what a call carried is recorded before any rule runs: a rule that writes to the context it is handed changes no evidence', () => {
  const REPORT = { input: 'Summarise the quarterly report in two sentences.', output: 'Revenue grew four percent on the quarter, led by the services line. Costs were flat and the margin widened by one point.' };
  /** A deployment's own measurement, registered in code, that writes to its context before it answers. */
  const writing = (write: (ctx: EvalContext) => void): EvalRule => ({
    name: 'acme_note',
    description: "A measurement of the deployment's own.",
    evalType: 'custom',
    weight: 1,
    critical: false,
    kind: 'measurement',
    mechanism: 'formula',
    needs: ['output'],
    version: 1,
    evaluate: (ctx): RuleAnswer => {
      write(ctx);
      return { ruleName: 'acme_note', passed: true, score: 1, message: 'Measured' };
    },
  });
  const withRule = (overrides: Record<string, unknown>, write: (ctx: EvalContext) => void): EvalEngine => {
    const e = engine(overrides as Partial<typeof defaultConfig.eval>);
    e.registerRule('custom', writing(write), 'embedder:acme_note');
    return e;
  };

  it('a cost the deployment requires and the call did not send is still missing when a rule gives itself one', async () => {
    const writes: Array<[string, (ctx: EvalContext) => void]> = [
      ['touches nothing', () => {}],
      ['assigns a cost', (ctx) => void (ctx.costUsd = 0.01)],
      ['defaults a cost, so its own division needs no guard', (ctx) => void (ctx.costUsd ??= 0)],
    ];
    for (const [what, write] of writes) {
      const result = await withRule({ requiredEvidence: ['cost'] }, write).evaluateAll({ ...REPORT });
      expect(row(result, 'acme_note'), what).toMatchObject({ passed: true });
      expect(result.provenance?.evidence?.carried, what).toEqual(['input', 'output']);
      expect(row(result, 'cost_under_threshold'), what).toMatchObject({ skipped: true, lacked: ['cost'] });
      expect(result.verdict, what).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['cost'] });
      expect(result.passed, what).toBe(false);
    }
  });

  it('a list of tool calls that a capture source records in full and did not send is still a hole in the record when a rule defaults it to an empty one', async () => {
    const recorded = { ...REPORT, recordedBy: 'harness' as const, capture: { name: 'acme-capture', version: '1.0.0', complete: ['tool_calls' as const] } };
    for (const [what, write] of [['touches nothing', () => {}], ['defaults the list', (ctx: EvalContext) => void (ctx.toolCalls ??= [])]] as Array<[string, (ctx: EvalContext) => void]>) {
      const result = await withRule({}, write).evaluateAll({ ...recorded });
      expect(result.provenance?.evidence, what).toMatchObject({ recordedBy: 'harness', carried: ['input', 'output'] });
      expect(result.provenance?.evidence?.toolCalls, what).toBeUndefined();
      expect(result.verdict, what).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    }
  });

  it('who recorded a trace is what the call said, and not what a rule writes afterwards', async () => {
    const vouch = (ctx: EvalContext): void => {
      ctx.recordedBy = 'harness';
      ctx.capture = { name: 'acme-capture', complete: ['tool_calls'] };
    };
    for (const [what, write] of [['touches nothing', () => {}], ['says a capture source recorded it', vouch]] as Array<[string, (ctx: EvalContext) => void]>) {
      const result = await withRule({ requiredEvidence: ['tool_calls'] }, write).evaluateAll({ ...REPORT, toolCalls: [] });
      expect(result.provenance?.evidence, what).toMatchObject({ recordedBy: 'not_declared', carried: ['input', 'output'] });
      expect(result.provenance?.evidence?.capture, what).toBeUndefined();
      expect(result.verdict, what).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    }
  });

  it('nor does a rule that changes, in place, a list it was handed: the record holds the calls that were sent, whichever way the rule changed them', async () => {
    const sent = (): ToolCallRecord[] => [{ tool_name: 'read_file', input: { path: 'src/a.ts' }, output: 'export const parse = 1;' }];
    const adds = (ctx: EvalContext): void => void ctx.toolCalls!.push({ tool_name: 'read_file', input: { path: 'src/b.ts' }, output: 'export const format = 2;' });
    const empties = (ctx: EvalContext): void => void (ctx.toolCalls!.length = 0);
    // One call sent: one call recorded, and tool calls the deployment requires are not reported missing.
    for (const [what, write] of [['touches nothing', () => {}], ['adds a call to the list', adds], ['empties the list', empties]] as Array<[string, (ctx: EvalContext) => void]>) {
      const result = await withRule({ requiredEvidence: ['tool_calls'] }, write).evaluateAll({ ...REPORT, toolCalls: sent() });
      expect(result.provenance?.evidence, what).toMatchObject({ carried: ['input', 'output', 'tool_calls', 'tool_outputs'], toolCalls: 1 });
      expect(result.verdict, what).toMatchObject({ state: 'pass', basis: 'clean' });
    }
    // An empty list sent, with nothing that recorded the trace: no call was carried, and a call a rule adds to the list is not one.
    for (const [what, write] of [['touches nothing', () => {}], ['adds a call to the list', adds]] as Array<[string, (ctx: EvalContext) => void]>) {
      const result = await withRule({ requiredEvidence: ['tool_calls'] }, write).evaluateAll({ ...REPORT, toolCalls: [] });
      expect(result.provenance?.evidence?.carried, what).toEqual(['input', 'output']);
      expect(result.verdict, what).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['tool_calls'] });
    }
  });

  it('nor does a rule that changes, in place, a call the list holds: the record holds what each call returned', async () => {
    const recorded = { ...REPORT, recordedBy: 'harness' as const, capture: { name: 'acme-capture', version: '1.0.0', complete: ['tool_calls' as const, 'tool_outputs' as const] } };
    const sent = (): ToolCallRecord[] => [
      { tool_name: 'read_file', input: { path: 'src/a.ts' }, output: 'export const parse = 1;' },
      { tool_name: 'read_file', input: { path: 'src/b.ts' }, output: 'export const format = 2;' },
    ];
    const deletesAnOutput = (ctx: EvalContext): void => void delete ctx.toolCalls![0].output;
    for (const [what, write] of [['touches nothing', () => {}], ["deletes the first call's output", deletesAnOutput]] as Array<[string, (ctx: EvalContext) => void]>) {
      const result = await withRule({ requiredEvidence: ['tool_outputs'] }, write).evaluateAll({ ...recorded, toolCalls: sent() });
      expect(result.provenance?.evidence?.carried, what).toEqual(['input', 'output', 'tool_calls', 'tool_outputs']);
      expect(result.verdict?.by ?? [], what).not.toContain('tool_outputs');
    }
  });

  /** The same measurement, registered under `completeness`: it runs before the cost, safety and other rules, so a row stamped after it would show what it wrote. */
  const first = (overrides: Record<string, unknown>, thresholds: Partial<typeof defaultConfig.eval.ruleThresholds>, write: (ctx: EvalContext) => void): EvalEngine => {
    const e = engine(overrides as Partial<typeof defaultConfig.eval>, thresholds);
    e.registerRule('completeness', { ...writing(write), evalType: 'completeness' }, 'embedder:acme_note');
    return e;
  };

  it('what each row lacked is read before any rule runs: a cost that a rule run first writes is not one the call sent', async () => {
    // cost_anomaly reads the cost the earlier rule wrote, and then skips for want of earlier costs: what it lacked is still the cost the call did not send.
    const assigns = (ctx: EvalContext): void => void (ctx.costUsd = 0.01);
    for (const [what, write] of [['touches nothing', () => {}], ['assigns a cost', assigns]] as Array<[string, (ctx: EvalContext) => void]>) {
      const result = await first({}, {}, write).evaluateAll({ ...REPORT });
      expect(row(result, 'cost_anomaly'), what).toMatchObject({ skipped: true, lacked: ['cost'] });
    }
  });

  it('a plugin is handed the same context, and what it writes there is no more evidence than what a rule registered in code writes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-plugin-writes-'));
    try {
      const path = join(dir, 'cost-per-character.mjs');
      writeFileSync(
        path,
        [
          "export default { name: 'cost_per_character', kind: 'measurement', mechanism: 'formula', version: 1, needs: ['output'],",
          "  description: 'What an answer cost for each character of it.',",
          '  evaluate(ctx) {',
          '    ctx.costUsd ??= 0;',
          "    return { ruleName: 'cost_per_character', passed: true, score: 1, message: `${(ctx.costUsd / Math.max(1, ctx.output.length)).toFixed(6)} USD a character` };",
          '  } };',
          '',
        ].join('\n'),
      );
      const e = engine({ requiredEvidence: ['cost'] } as Partial<typeof defaultConfig.eval>);
      for (const p of await loadPlugins([{ path, sha256: createHash('sha256').update(readFileSync(path)).digest('hex') }])) e.registerRule(p.evalType, p.rule, p.id);
      const result = await e.evaluateAll({ ...REPORT });
      expect(row(result, 'cost_per_character')).toMatchObject({ passed: true, origin: 'plugin' });
      expect(result.provenance?.evidence?.carried).toEqual(['input', 'output']);
      expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing', by: ['cost'] });
      expect(sentences(result)).toContain('this deployment requires cost on every evaluation');
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    }
  });
});
