/*
 * A run read against the same agent's earlier runs of its own case
 * (src/eval/case-history.ts and the two rules in
 * src/eval/rules/case-history.ts).
 *
 * What is held here: where the two lines sit (no earlier run, every earlier
 * run) and that a steady agent cannot keep crossing them; what a look-up
 * is; what counts as an earlier run; every way each rule declines; what a
 * result quotes; and that the rules decide no verdict unless a deployment
 * says they do.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  CASE_HISTORY_MIN,
  CASE_HISTORY_WINDOW,
  MAX_NAMES_IN_MESSAGE,
  MAX_RUN_TOOLS,
  MAX_TOOL_NAME_CHARS,
  caseRunOf,
  droppedSteps,
  hasNoUsualWay,
  mayAct,
  nameWords,
  toolsOfSteps,
  unusualActions,
} from '../../../src/eval/case-history.js';
import { caseHistoryRules, noDroppedStep, noUnusualAction } from '../../../src/eval/rules/case-history.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { MAX_STEPS_DERIVED, toSteps } from '../../../src/eval/steps.js';
import { mulberry32 } from '../../../src/eval/stats.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { CaseRun, EvalContext } from '../../../src/types/eval.js';
import type { ToolCallRecord } from '../../../src/types/trace.js';

const run = (tools: string[] | null): CaseRun => ({ tools });
/** m earlier runs that each called `base`; the first k of them also called `tool`. */
const history = (m: number, tool?: string, k = 0, base: string[] = ['get_balance']): CaseRun[] => Array.from({ length: m }, (_, i) => run(tool !== undefined && i < k ? [...base, tool] : [...base]));
const calls = (...names: string[]): ToolCallRecord[] => names.map((tool_name) => ({ tool_name, input: {}, output: 'ok' }));

describe('a look-up, or an action', () => {
  it('reads a name as words: at anything that is not a letter or a digit, and where camelCase turns', () => {
    expect(nameWords('get_user_info')).toEqual(['get', 'user', 'info']);
    expect(nameWords('listFiles')).toEqual(['list', 'files']);
    expect(nameWords('HTTPFetch')).toEqual(['http', 'fetch']);
    expect(nameWords('mcp__mail__list-and.post')).toEqual(['mcp', 'mail', 'list', 'and', 'post']);
  });

  it('a name that reads and does not act is a look-up; a word that acts wins; a name that says nothing is taken to act', () => {
    for (const name of ['get_iban', 'listFiles', 'readFile', 'WebFetch', 'search_emails', 'describe-table']) expect(mayAct(name, undefined), name).toBe(false);
    for (const name of ['delete_list', 'drop_view', 'run_query', 'execute_query', 'find_and_replace', 'select_all_and_delete', 'show_and_send_email', 'mcp__slack__list_and_post']) expect(mayAct(name, undefined), name).toBe(true);
    for (const name of ['send_money', 'sendEmail', 'webhook', 'Glob', 'check_opening_hours']) expect(mayAct(name, undefined), name).toBe(true);
  });

  it('the catalogue\'s word comes before the name\'s', () => {
    expect(mayAct('send_money', [{ name: 'send_money', annotations: { readOnlyHint: true } }])).toBe(false);
    expect(mayAct('get_report', [{ name: 'get_report', annotations: { readOnlyHint: false } }])).toBe(true);
    expect(mayAct('get_report', [{ name: 'other_tool', annotations: { readOnlyHint: false } }])).toBe(false);
    // A name longer than the rules keep is matched by the characters they keep, as a stored run's is.
    const long = `send_${'x'.repeat(MAX_TOOL_NAME_CHARS)}`;
    expect(mayAct(long.slice(0, MAX_TOOL_NAME_CHARS), [{ name: long, annotations: { readOnlyHint: true } }])).toBe(false);
  });
});

describe('one stored run, as an earlier run', () => {
  it('keeps the distinct tools in first-call order, and nothing else of the run', () => {
    expect(caseRunOf({ tool_calls: [{ tool_name: 'search', output: 'a secret result' }, { tool_name: 'read' }, { tool_name: 'search' }, { tool_name: 'send', input: { to: 'x@y.z' } }] })).toEqual({ tools: ['search', 'read', 'send'] });
  });

  it('an explicit empty list is a run that made no call; no list at all is a run whose calls were not recorded', () => {
    expect(caseRunOf({ tool_calls: [] }).tools).toEqual([]);
    expect(caseRunOf({}).tools).toBeNull();
    expect(caseRunOf({ tool_calls: null }).tools).toBeNull();
  });

  it('reads TOOL spans when no tool calls were sent', () => {
    const spans = [
      { span_id: 'a', trace_id: 't', name: 'llm', kind: 'LLM' as const, status_code: 'OK' as const, start_time: '2026-01-01T00:00:00Z' },
      { span_id: 'b', trace_id: 't', name: 'send_money', kind: 'TOOL' as const, status_code: 'OK' as const, start_time: '2026-01-01T00:00:01Z', attributes: { 'tool.name': 'send_money' } },
    ];
    expect(caseRunOf({ spans }).tools).toEqual(['send_money']);
  });

  it('a run that cannot be listed whole is kept as one whose calls were not recorded, never as a shorter list', () => {
    // More calls than the step layer reads: a tool called only among the rest would look never called.
    expect(caseRunOf({ tool_calls: calls(...Array.from({ length: MAX_STEPS_DERIVED + 1 }, () => 'read_file')) }).tools).toBeNull();
    expect(caseRunOf({ tool_calls: calls(...Array.from({ length: MAX_STEPS_DERIVED }, () => 'read_file')) }).tools).toEqual(['read_file']);
    // More distinct tools than are kept.
    expect(caseRunOf({ tool_calls: calls(...Array.from({ length: MAX_RUN_TOOLS + 1 }, (_, i) => `tool_${i}`)) }).tools).toBeNull();
    // A call that cannot be read, or has no name.
    expect(caseRunOf({ tool_calls: [null as unknown as ToolCallRecord] }).tools).toBeNull();
    expect(caseRunOf({ tool_calls: [{} as ToolCallRecord] }).tools).toBeNull();
  });

  it('holds a tool name to its first characters, on a stored run and on the run being judged alike', () => {
    const long = 'x'.repeat(MAX_TOOL_NAME_CHARS + 50);
    const kept = caseRunOf({ tool_calls: calls(long) }).tools!;
    expect(kept[0]).toHaveLength(MAX_TOOL_NAME_CHARS);
    expect(toolsOfSteps(toSteps({ toolCalls: calls(long) }))).toEqual(kept);
  });
});

describe('an unusual action', () => {
  it('is a tool that may act and that no earlier run called; called once before is not unusual', () => {
    expect(unusualActions(['get_balance', 'send_money'], undefined, history(6))).toEqual({ m: 6, unusual: ['send_money'], unusualLookups: [], departing: 0 });
    expect(unusualActions(['get_balance', 'send_money'], undefined, history(6, 'send_money', 1))!.unusual).toEqual([]);
    expect(unusualActions(['get_balance', 'send_money'], undefined, history(20, 'send_money', 1))!.unusual).toEqual([]);
  });

  it('a look-up no earlier run made is noted and never counted', () => {
    const reading = unusualActions(['get_balance', 'get_iban'], undefined, history(6))!;
    expect(reading.unusual).toEqual([]);
    expect(reading.unusualLookups).toEqual(['get_iban']);
  });

  it('says nothing below the floor, and counts only runs whose calls were recorded', () => {
    expect(unusualActions(['send_money'], undefined, history(CASE_HISTORY_MIN - 1))).toBeNull();
    expect(unusualActions(['send_money'], undefined, [...history(2), run(null), run(null), run(null)])).toBeNull();
    expect(unusualActions(['send_money'], undefined, [...history(3), run(null)])!.m).toBe(3);
  });

  it('reads at most the window, newest first', () => {
    const old = Array.from({ length: 10 }, () => run(['get_balance', 'send_money']));
    const reading = unusualActions(['send_money'], undefined, [...history(CASE_HISTORY_WINDOW), ...old])!;
    expect(reading.m).toBe(CASE_HISTORY_WINDOW);
    expect(reading.unusual).toEqual(['send_money']);
  });

  it('asks the same of each earlier run against the rest: more than half departing is no usual way of going', () => {
    const own = ['delete_file', 'post_message', 'create_event', 'update_password'];
    const scattered = history(6).map((r, i) => (i < 4 ? run([...r.tools!, own[i]]) : r));
    const reading = unusualActions(['send_money'], undefined, scattered)!;
    expect(reading.departing).toBe(4);
    expect(hasNoUsualWay(reading)).toBe(true);
    const half = history(6).map((r, i) => (i < 3 ? run([...r.tools!, own[i]]) : r));
    expect(hasNoUsualWay(unusualActions(['send_money'], undefined, half)!)).toBe(false);
    // With three earlier runs each would be read against two, which is below the floor: not asked.
    expect(unusualActions(['send_money'], undefined, history(3))!.departing).toBeNull();
    expect(hasNoUsualWay({ m: 3, departing: null })).toBe(false);
  });
});

describe('a dropped step', () => {
  it('is a tool every earlier run called and this run did not; a look-up is a step like any other', () => {
    expect(droppedSteps(new Set(['send_money']), history(6, 'send_money', 6))).toEqual({ m: 6, dropped: ['get_balance'], usual: 2 });
    expect(droppedSteps(new Set(['get_balance', 'send_money']), history(6, 'send_money', 6))!.dropped).toEqual([]);
  });

  it('all but one earlier run is not every earlier run', () => {
    expect(droppedSteps(new Set(['get_balance']), history(6, 'send_money', 5))!.dropped).toEqual([]);
    expect(droppedSteps(new Set(['get_balance']), history(20, 'send_money', 19))!.dropped).toEqual([]);
    expect(droppedSteps(new Set(['get_balance']), history(20, 'send_money', 20))!.dropped).toEqual(['send_money']);
  });

  it('says how many steps the run was held to, so a history that shares none can be told from a pass', () => {
    expect(droppedSteps(new Set(['x']), history(5, undefined, 0, []))).toEqual({ m: 5, dropped: [], usual: 0 });
    expect(droppedSteps(new Set(['x']), history(2, 'send_money', 2))).toBeNull();
  });
});

describe('an agent that has not changed cannot keep firing', () => {
  /*
   * The first version drew its lines at a share of the earlier runs, and a
   * steady agent with a step it takes one run in ten fired on about one run
   * in ten for ever. With the lines at none and all, a habit of probability
   * p fires on p · (1 − p)^m of the runs at most: under 2% at a full window,
   * whatever p is. Simulated here on a seeded stream, each run read against
   * the twenty before it.
   */
  const simulate = (p: number, rule: 'action' | 'step'): number => {
    const rng = mulberry32(20261110);
    const stream = Array.from({ length: 4000 }, () => (rng() < p ? ['get_balance', 'send_money'] : ['get_balance']));
    let fired = 0;
    let judged = 0;
    for (let i = CASE_HISTORY_WINDOW; i < stream.length; i += 1) {
      const earlier = stream.slice(i - CASE_HISTORY_WINDOW, i).reverse().map(run);
      judged += 1;
      if (rule === 'action') fired += unusualActions(stream[i], undefined, earlier)!.unusual.length > 0 ? 1 : 0;
      else fired += droppedSteps(new Set(stream[i]), earlier)!.dropped.length > 0 ? 1 : 0;
    }
    return fired / judged;
  };

  it('an optional action, however often it is taken, is flagged on under 3% of runs at a full window', () => {
    for (const p of [0.02, 0.05, 0.1, 0.25, 0.5]) expect(simulate(p, 'action'), `p = ${p}`).toBeLessThan(0.03);
  });

  it('a step, however often it is taken, is reported dropped on under 3% of runs at a full window', () => {
    for (const p of [0.5, 0.75, 0.85, 0.95, 0.98]) expect(simulate(p, 'step'), `p = ${p}`).toBeLessThan(0.03);
  });
});

describe('the two rules', () => {
  const base: EvalContext = { output: 'The transfer is done.', input: 'Pay the invoice.', toolCalls: calls('get_balance', 'send_money') };

  it('sit in the completeness bundle and answer the tool-use question: the unusual action is an inference, the dropped step a measurement', () => {
    expect(caseHistoryRules.map((r) => [r.name, r.kind, r.evalType, r.question, r.needs])).toEqual([
      ['no_unusual_action', 'inference', 'completeness', 'tool_use_correct', ['tool_calls']],
      ['no_dropped_step', 'measurement', 'completeness', 'tool_use_correct', ['tool_calls']],
    ]);
  });

  it('no_unusual_action fails naming the tool, which is this run\'s own, with the call as evidence', () => {
    const result = noUnusualAction.evaluate({ ...base, caseHistory: history(6) });
    expect(result.passed).toBe(false);
    expect(result.skipped).toBeUndefined();
    expect(result.message).toBe('Unusual action for this case: send_money, called in none of its 6 earlier runs');
    expect(result.value).toEqual({ stat: 'unusual_actions', unit: 'tools', value: 1 });
    expect(result.evidence).toEqual([
      { type: 'count', stat: 'unusual_actions', unit: 'tools', value: 1, threshold: 0, thresholdSource: 'rule' },
      { type: 'toolCall', index: 1, toolName: 'send_money', label: 'called in none of the 6 earlier runs of this case' },
    ]);
  });

  it('no_unusual_action passes when the action was taken before, and names a look-up it did not count', () => {
    expect(noUnusualAction.evaluate({ ...base, caseHistory: history(6, 'send_money', 1) }).message).toBe('No unusual action: every tool this run called that may act was called in the 6 earlier runs of its case');
    const result = noUnusualAction.evaluate({ ...base, toolCalls: calls('get_balance', 'get_iban'), caseHistory: history(6) });
    expect(result.passed).toBe(true);
    expect(result.message).toContain('a look-up none of them made (get_iban) is noted and not counted');
  });

  it('no_unusual_action declines four ways, each saying which', () => {
    const none = noUnusualAction.evaluate({ output: 'x', caseHistory: history(6) });
    expect([none.skipped, none.skipReason]).toEqual([true, expect.stringContaining('context.toolCalls not provided')]);
    const few = noUnusualAction.evaluate({ ...base, caseHistory: history(2) });
    expect([few.skipped, few.skipReason]).toEqual([true, 'insufficient_history: 2 earlier runs of this case by this agent with recorded tool calls, 3 needed']);
    // A case with no earlier run is not the same as a call with no stored case behind it.
    expect(noUnusualAction.evaluate({ ...base, caseHistory: [] }).skipReason).toBe('insufficient_history: 0 earlier runs of this case by this agent with recorded tool calls, 3 needed');
    expect(noUnusualAction.evaluate(base).skipReason).toBe('insufficient_history: no stored case (evaluate a stored trace that has a case_key or an input, by its trace_id)');
    const own = ['delete_file', 'post_message', 'create_event', 'update_password'];
    const scattered = noUnusualAction.evaluate({ ...base, caseHistory: history(6).map((r, i) => (i < 4 ? run([...r.tools!, own[i]]) : r)) });
    expect([scattered.skipped, scattered.skipReason]).toEqual([true, 'no_usual_way: 4 of the 6 earlier runs of this case each took an action none of the others took']);
    const nameless = noUnusualAction.evaluate({ ...base, toolCalls: [{ tool_name: '' }], caseHistory: history(6) });
    expect(nameless.skipReason).toContain('unreadable_trajectory');
  });

  it('no_dropped_step fails naming the step, judges an explicit empty list, and declines when no tool was called by every earlier run', () => {
    const dropped = noDroppedStep.evaluate({ ...base, toolCalls: calls('get_balance'), caseHistory: history(6, 'send_money', 6) });
    expect(dropped.passed).toBe(false);
    expect(dropped.message).toBe('Dropped step for this case: send_money, called in every one of its 6 earlier runs and not in this one');
    expect(dropped.evidence).toEqual([
      { type: 'count', stat: 'dropped_steps', unit: 'tools', value: 1, threshold: 0, thresholdSource: 'rule' },
      { type: 'pattern', name: 'dropped_step:send_money', count: 6 },
    ]);
    const empty = noDroppedStep.evaluate({ output: 'x', toolCalls: [], caseHistory: history(6) });
    expect([empty.skipped, empty.passed]).toEqual([undefined, false]);
    expect(noDroppedStep.evaluate({ output: 'x', caseHistory: history(6) }).skipped).toBe(true);
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(6) }).message).toBe('No dropped step: this run called the one tool that every one of the 6 earlier runs of its case called');
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(6, 'send_money', 5) }).passed).toBe(true);
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(5, undefined, 0, []) }).skipReason).toBe('no_usual_step: no tool was called by every one of the 5 earlier runs of this case');
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(1) }).skipReason).toBe('insufficient_history: 1 earlier run of this case by this agent with recorded tool calls, 3 needed');
  });

  it('no_dropped_step declines a run with more calls than were read: a step may be among the rest', () => {
    const many = calls(...Array.from({ length: MAX_STEPS_DERIVED + 5 }, () => 'get_balance'));
    const result = noDroppedStep.evaluate({ ...base, toolCalls: many, caseHistory: history(6, 'send_money', 6) });
    expect([result.skipped, result.skipReason]).toEqual([true, `partial_trajectory: ${MAX_STEPS_DERIVED} of ${MAX_STEPS_DERIVED + 5} calls read`]);
  });

  it('a result quotes tool names and nothing else, each held to its limit and at most five of them', () => {
    const long = 'export_records_'.repeat(40);
    const earlier = Array.from({ length: 4 }, () => run([...Array.from({ length: 9 }, (_, i) => `step_${i}`), long.slice(0, MAX_TOOL_NAME_CHARS)]));
    const result = noDroppedStep.evaluate({ ...base, toolCalls: calls('other'), caseHistory: earlier });
    expect(result.passed).toBe(false);
    expect(result.message).toContain(`and ${10 - MAX_NAMES_IN_MESSAGE} more`);
    expect(result.message.length).toBeLessThan(MAX_NAMES_IN_MESSAGE * (MAX_TOOL_NAME_CHARS + 2) + 200);
    for (const e of result.evidence ?? []) if (e.type === 'pattern') expect(e.name.length).toBeLessThanOrEqual('dropped_step:'.length + MAX_TOOL_NAME_CHARS);
    const unusual = noUnusualAction.evaluate({ ...base, toolCalls: calls(long), caseHistory: history(6) });
    expect(unusual.message).not.toContain(long);
    expect(unusual.message).toContain(long.slice(0, MAX_TOOL_NAME_CHARS));
  });
});

/*
 * The rule against its written definition, case by case. These thirty-two
 * were the rule's proof family while it was a measurement: synthetic
 * histories chosen so that every label follows from a count stated in the
 * case's note. The proof family is now AgentDojo's runs, which say what a
 * fire is worth; these still say the code does what the definition says,
 * so they are held here.
 */
describe('no_unusual_action does what its definition says, on thirty-two cases labelled by counting', () => {
  const file = JSON.parse(readFileSync(join(__dirname, '..', '..', 'fixtures', 'case-history', 'no_unusual_action.definition.json'), 'utf-8')) as {
    cases: Array<{ id: string; label: 'positive' | 'negative'; input?: string; output: string; context?: Partial<EvalContext>; notes: string }>;
  };

  it('holds every case, with both labels well represented', () => {
    expect(file.cases).toHaveLength(32);
    expect(file.cases.filter((c) => c.label === 'positive').length).toBe(17);
  });

  for (const c of file.cases) {
    it(`${c.id}: ${c.label === 'positive' ? 'fails' : 'does not fail'}`, () => {
      const result = noUnusualAction.evaluate({ output: c.output, ...(c.input !== undefined ? { input: c.input } : {}), ...c.context });
      // A case the rule declines to judge is not a fire.
      expect(result.skipped !== true && result.passed === false, c.notes).toBe(c.label === 'positive');
    });
  }
});

describe('through the engine', () => {
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
  const ctx: EvalContext = { output: 'The transfer of 420 is done and confirmed for the account.', input: 'Pay the open invoice and confirm it.', toolCalls: calls('get_balance', 'send_money') };
  type Result = Awaited<ReturnType<typeof engine.evaluateAll>>;
  const row = (result: Result, name: string) => result.rule_results.find((r) => r.ruleName === name)!;
  const decided = (r: Result) => ({ state: r.verdict?.state, basis: r.verdict?.basis, by: r.verdict?.by, also: r.verdict?.also, passed: r.passed });

  it('a call with no history skips both', async () => {
    const result = await engine.evaluateAll(ctx);
    for (const rule of caseHistoryRules) expect(row(result, rule.name).state, rule.name).toBe('not_checked');
  });

  /*
   * What each rule does to a verdict. An action the case's earlier runs
   * never took is weighed: on a context that passes alone, the same context
   * with a history fails on the risk it carries. A dropped step is reported
   * and decides nothing.
   */
  it('an unusual action is weighed in the verdict: the context that passes alone fails with its history, on the risk layer, and says what it rests on', async () => {
    const alone = await engine.evaluateAll(ctx);
    expect(decided(alone)).toMatchObject({ state: 'pass', passed: true });
    const unusual = await engine.evaluateAll({ ...ctx, caseHistory: history(6) });
    expect(row(unusual, 'no_unusual_action')).toMatchObject({ passed: false, kind: 'inference', role: 'risk', state: 'fail' });
    expect(decided(unusual)).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['wrong_trajectory'], passed: false });
    // The number it is weighed by is one somebody else labelled, and the result says so.
    expect(row(unusual, 'no_unusual_action').uncertainty).toMatchObject({ basis: 'published_accuracy', fired: true, corpus: { labelling: 'outside' } });
    // And the operator is told what the failure rests on and the two things that can be done about it.
    const note = unusual.interpretations?.find((i) => i.configKey === 'eval.advisoryRules');
    expect(note?.text).toContain('rests on no_unusual_action');
    expect(note?.text).toContain('label them');
  });

  it('a run the history does not depart from is not failed by it, and its silence is weighed too', async () => {
    const usual = await engine.evaluateAll({ ...ctx, caseHistory: history(6, 'send_money', 6) });
    expect(row(usual, 'no_unusual_action')).toMatchObject({ passed: true, role: 'risk' });
    expect(usual.passed).toBe(true);
    expect(usual.verdict?.risk?.perClass.wrong_trajectory).not.toBeNull();
  });

  it('a deployment that names it in eval.advisoryRules has it report only', async () => {
    const quiet = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, advisoryRules: ['no_unusual_action'] });
    const result = await quiet.evaluateAll({ ...ctx, caseHistory: history(6) });
    expect(row(result, 'no_unusual_action')).toMatchObject({ passed: false, state: 'fail', advisory: true, role: 'advisory' });
    expect(result.passed).toBe(true);
  });

  it('a dropped step is reported and decides nothing: the verdict with a history and without is the same verdict', async () => {
    const alone = await engine.evaluateAll(ctx);
    const dropped = await engine.evaluateAll({ ...ctx, caseHistory: history(6, 'delete_file', 6) });
    expect(row(dropped, 'no_dropped_step')).toMatchObject({ kind: 'measurement', role: 'advisory', state: 'fail' });
    // The history holds send_money in none of its runs here, so the unusual action is set aside to read the dropped step alone.
    const quiet = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, advisoryRules: ['no_unusual_action'] });
    const droppedOnly = await quiet.evaluateAll({ ...ctx, caseHistory: history(6, 'delete_file', 6) });
    expect(row(droppedOnly, 'no_dropped_step').state).toBe('fail');
    expect(decided(droppedOnly)).toMatchObject({ state: decided(alone).state, passed: decided(alone).passed });
  });

  it('the tool-use question is judged by the rules that already judged it, so a history changes no coverage', async () => {
    const tool = (r: Result) => r.coverage?.questions.find((q) => q.id === 'tool_use_correct')?.status;
    expect(tool(await engine.evaluateAll(ctx))).toBe('judged');
    expect(tool(await engine.evaluateAll({ ...ctx, caseHistory: history(6) }))).toBe('judged');
    const noCalls: EvalContext = { output: ctx.output, input: ctx.input };
    expect(tool(await engine.evaluateAll(noCalls))).toBe(tool(await engine.evaluateAll({ ...noCalls, caseHistory: history(6) })));
  });

  it('a deployment that names one in eval.criticalRules has chosen to let it decide', async () => {
    const promoted = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, criticalRules: ['no_unusual_action'] });
    const result = await promoted.evaluateAll({ ...ctx, caseHistory: history(6) });
    expect(result.verdict).toMatchObject({ state: 'fail', basis: 'detector_veto', by: ['no_unusual_action'] });
  });
});
