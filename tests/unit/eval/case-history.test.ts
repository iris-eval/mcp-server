/*
 * A run read against the earlier runs of its own case
 * (src/eval/case-history.ts and the three rules in
 * src/eval/rules/case-history.ts).
 *
 * What is held here: the share and its two lines, by the table the module
 * prints; what a specific is; what counts as an earlier run; every way each
 * rule declines; that a look-up is never counted; and that nothing a rule
 * reports carries text from another run.
 */
import { describe, expect, it } from 'vitest';
import {
  CASE_HISTORY_MIN,
  CASE_HISTORY_WINDOW,
  answerAsRead,
  caseRunOf,
  describeSpecific,
  droppedSpecifics,
  droppedSteps,
  hasNoUsualWay,
  isUnusual,
  isUsual,
  kindOfSpecific,
  mayAct,
  shareOf,
  specificsOf,
  unusualActions,
} from '../../../src/eval/case-history.js';
import { caseHistoryRules, noDroppedSpecific, noDroppedStep, noUnusualAction } from '../../../src/eval/rules/case-history.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { CaseRun, EvalContext } from '../../../src/types/eval.js';
import type { ToolCallRecord } from '../../../src/types/trace.js';

const run = (tools: string[] | null, specifics: string[] | null = []): CaseRun => ({ tools, specifics });
/** m earlier runs that each called `base`; the first k of them also called `tool`. */
const history = (m: number, tool?: string, k = 0, base: string[] = ['get_balance']): CaseRun[] => Array.from({ length: m }, (_, i) => run(tool !== undefined && i < k ? [...base, tool] : [...base]));
const calls = (...names: string[]): ToolCallRecord[] => names.map((tool_name) => ({ tool_name, input: {}, output: 'ok' }));

describe('the share and its two lines', () => {
  it('is the rule of succession, so three of three is weaker than thirty of thirty', () => {
    expect(shareOf(3, 3)).toBeCloseTo(0.8, 10);
    expect(shareOf(30, 30)).toBeCloseTo(31 / 32, 10);
    expect(shareOf(0, 3)).toBeCloseTo(0.2, 10);
  });

  it('unusual is a quarter or less: the most earlier runs that may have done it, for each m the module\'s table prints', () => {
    const most = (m: number): number => {
      let k = -1;
      while (isUnusual(k + 1, m)) k += 1;
      return k;
    };
    expect([3, 4, 5].map(most)).toEqual([0, 0, 0]);
    expect([6, 7, 8, 9].map(most)).toEqual([1, 1, 1, 1]);
    expect([10, 11, 12, 13].map(most)).toEqual([2, 2, 2, 2]);
    expect(most(20)).toBe(4);
    // Below the floor the line is never reached with a real count: one earlier run cannot make anything unusual.
    expect(isUnusual(0, 1)).toBe(false);
  });

  it('usual is three quarters or more: the fewest earlier runs that must have done it', () => {
    const fewest = (m: number): number => {
      let k = 0;
      while (!isUsual(k, m)) k += 1;
      return k;
    };
    expect([3, 4, 5].map(fewest)).toEqual([3, 4, 5]);
    expect([6, 7, 8, 9].map(fewest)).toEqual([5, 6, 7, 8]);
    expect([10, 11, 12, 13].map(fewest)).toEqual([8, 9, 10, 11]);
    expect(fewest(20)).toBe(16);
  });

  it('the two lines are decided in integers: exactly a quarter is unusual and exactly three quarters is usual', () => {
    expect(shareOf(1, 6)).toBe(0.25);
    expect(isUnusual(1, 6)).toBe(true);
    expect(shareOf(5, 6)).toBe(0.75);
    expect(isUsual(5, 6)).toBe(true);
    expect(isUnusual(2, 6)).toBe(false);
    expect(isUsual(4, 6)).toBe(false);
  });
});

describe('what a specific is', () => {
  it('a figure in one written form, whatever its separators and trailing zeros', () => {
    expect(specificsOf('The total is 1,050.00 today.')).toEqual(['1050']);
    expect(specificsOf('The total is 1050 today.')).toEqual(['1050']);
    expect(specificsOf('Paid $12,345.60 and then 98.70.')).toEqual(['12345.6', '98.7']);
    expect(specificsOf('It rose 15% to 0.50.')).toEqual(['15', '0.5']);
  });

  it('a comma joins only as a thousands separator', () => {
    expect(specificsOf('Rows 12,34 and 1,2,3 were read; 1,234,567 remain.')).toEqual(['12', '34', '1234567']);
  });

  it('dates, times, versions and identifiers are read whole, without regard to case', () => {
    expect(specificsOf('On 2026-11-10 at 10:30, order INV-2026-0042 shipped as v1.2.3 to room B12.')).toEqual(['2026-11-10', '10:30', 'inv-2026-0042', 'v1.2.3', 'b12']);
  });

  it('an email address and a web address are specifics; a handle is not', () => {
    expect(specificsOf('Write to Billing@Example.org or see https://Example.org/reports/q3. Ask @sam.')).toEqual(['billing@example.org', 'https://example.org/reports/q3']);
    expect(specificsOf('See (https://example.org/a_b?x=1), then stop.')).toEqual(['https://example.org/a_b?x=1']);
  });

  it('a number of one digit is a list marker far more often than a fact, and plain words are not specifics', () => {
    expect(specificsOf('1. First, do it. 2. Then check. There are 3 left.')).toEqual([]);
    expect(specificsOf('The transfer is done and the balance is confirmed.')).toEqual([]);
  });

  it('a dash, a quote mark or an ellipsis ends a run; an accented letter does not', () => {
    expect(specificsOf('It cost 420—more than “315” … or 77.')).toEqual(['420', '315', '77']);
    expect(specificsOf('Réf é12 et à7b.')).toEqual(['é12', 'à7b']);
  });

  it('each specific is kept once, in the order it first appears, and a blob is not one', () => {
    expect(specificsOf('420, then 77, then 420 again.')).toEqual(['420', '77']);
    expect(specificsOf(`id ${'a1'.repeat(100)} and 420`)).toEqual(['420']);
  });

  it('is described by its kind and size, never by its value', () => {
    expect(kindOfSpecific('1050')).toBe('number');
    expect(kindOfSpecific('12345.6')).toBe('number');
    expect(kindOfSpecific('billing@example.org')).toBe('email address');
    expect(kindOfSpecific('https://example.org/q3')).toBe('web address');
    expect(kindOfSpecific('inv-2026-0042')).toBe('identifier');
    expect(describeSpecific('1050')).toBe('a 4-digit number');
    expect(describeSpecific('12345.6')).toBe('a number of 6 digits with a decimal point');
    expect(describeSpecific('billing@example.org')).toBe('an email address');
    expect(describeSpecific('https://example.org/q3')).toBe('a web address');
    expect(describeSpecific('inv-2026-0042')).toBe('an identifier of 13 characters');
    for (const s of ['1050', '12345.6', 'billing@example.org', 'inv-2026-0042']) expect(describeSpecific(s)).not.toContain(s);
  });

  it('reads a long answer in time that grows with its length', () => {
    const text = '1,050 a.b@c.de https://x.y/z 10:30 '.repeat(20_000);
    const started = performance.now();
    expect(specificsOf(text).length).toBeGreaterThan(0);
    // Only the first 20,000 characters are read; a second is far more than that takes.
    expect(performance.now() - started).toBeLessThan(1_000);
  });
});

describe('one stored run, as an earlier run', () => {
  it('keeps the distinct tools in first-call order and the answer\'s specifics', () => {
    expect(caseRunOf({ trace_id: 't1', tool_calls: calls('search', 'read', 'search', 'send'), output: 'Sent 420 to a@b.co.' })).toEqual({ traceId: 't1', tools: ['search', 'read', 'send'], specifics: ['420', 'a@b.co'] });
  });

  it('an explicit empty list is a run that made no call; no list at all is a run whose calls were not recorded', () => {
    expect(caseRunOf({ tool_calls: [], output: 'x' }).tools).toEqual([]);
    expect(caseRunOf({ output: 'x' }).tools).toBeNull();
    expect(caseRunOf({ tool_calls: null, output: 'x' }).tools).toBeNull();
  });

  it('reads TOOL spans when no tool calls were sent', () => {
    const spans = [
      { span_id: 'a', trace_id: 't', name: 'llm', kind: 'LLM' as const, status_code: 'OK' as const, start_time: '2026-01-01T00:00:00Z' },
      { span_id: 'b', trace_id: 't', name: 'send_money', kind: 'TOOL' as const, status_code: 'OK' as const, start_time: '2026-01-01T00:00:01Z', attributes: { 'tool.name': 'send_money' } },
    ];
    expect(caseRunOf({ spans, output: 'x' }).tools).toEqual(['send_money']);
  });

  it('a run with no answer carries no specifics, which is not the same as carrying none', () => {
    expect(caseRunOf({ tool_calls: [] }).specifics).toBeNull();
    expect(caseRunOf({ tool_calls: [], output: '   ' }).specifics).toBeNull();
    expect(caseRunOf({ tool_calls: [], output: 'done' }).specifics).toEqual([]);
  });

  it('an answer written as JSON is read by the values it carries, as the rule reads the new one', () => {
    expect(answerAsRead('{"total": 420, "note": "paid"}')).not.toContain('"total"');
    expect(caseRunOf({ output: '{"total": 420, "ref": "inv-7"}' }).specifics).toEqual(['420', 'inv-7']);
  });
});

describe('an unusual action', () => {
  it('is a tool that may act and that the earlier runs all but never called', () => {
    const reading = unusualActions(['get_balance', 'send_money'], undefined, history(6))!;
    expect(reading.m).toBe(6);
    expect(reading.unusual).toEqual([{ name: 'send_money', k: 0, acts: true }]);
    expect(reading.unusualLookups).toEqual([]);
    expect(unusualActions(['get_balance', 'send_money'], undefined, history(6, 'send_money', 2))!.unusual).toEqual([]);
  });

  it('a look-up is noted and never counted: by its name, or by what the catalogue says', () => {
    expect(mayAct('get_iban', undefined)).toBe(false);
    expect(mayAct('send_money', undefined)).toBe(true);
    expect(mayAct('webhook', undefined)).toBe(true);
    expect(mayAct('send_money', [{ name: 'send_money', annotations: { readOnlyHint: true } }])).toBe(false);
    expect(mayAct('get_report', [{ name: 'get_report', annotations: { readOnlyHint: false } }])).toBe(true);
    const reading = unusualActions(['get_balance', 'get_iban'], undefined, history(6))!;
    expect(reading.unusual).toEqual([]);
    expect(reading.unusualLookups).toEqual([{ name: 'get_iban', k: 0, acts: false }]);
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
    expect(reading.unusual.map((t) => t.name)).toEqual(['send_money']);
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

describe('a dropped step, and a dropped specific', () => {
  it('a step is a tool nearly every earlier run called; a look-up is a step like any other', () => {
    const reading = droppedSteps(new Set(['send_money']), history(6, 'send_money', 6))!;
    expect(reading.usual).toBe(2);
    expect(reading.dropped).toEqual([{ name: 'get_balance', k: 6 }]);
    expect(droppedSteps(new Set(['get_balance', 'send_money']), history(6, 'send_money', 6))!.dropped).toEqual([]);
    expect(droppedSteps(new Set(['get_balance']), history(6, 'send_money', 4))!.dropped).toEqual([]);
  });

  it('says how many steps the run was held to, so a history that shares none can be told from a pass', () => {
    expect(droppedSteps(new Set(['x']), history(5, undefined, 0, []))).toEqual({ m: 5, dropped: [], usual: 0 });
    expect(droppedSteps(new Set(['x']), history(2, 'send_money', 2))).toBeNull();
  });

  it('a specific is dropped when nearly every earlier answer carried it and this one does not', () => {
    const earlier = Array.from({ length: 5 }, (_, i) => ({ traceId: `t${i}`, tools: [], specifics: ['1050', i === 0 ? '77' : '88'] }));
    const reading = droppedSpecifics('The invoice was paid.', earlier)!;
    expect(reading).toEqual({ m: 5, usual: 1, dropped: [{ specific: '1050', k: 5, traceId: 't0' }] });
    expect(droppedSpecifics('The total was 1,050.00.', earlier)!.dropped).toEqual([]);
  });

  it('counts only earlier runs that stored an answer', () => {
    const earlier = [run([], ['420']), run([], null), run([], ['420']), run([], null)];
    expect(droppedSpecifics('nothing', earlier)).toBeNull();
    expect(droppedSpecifics('nothing', [...earlier, run([], ['420'])])!.m).toBe(3);
  });
});

describe('the three rules', () => {
  const base: EvalContext = { output: 'The transfer is done.', input: 'Pay the invoice.', toolCalls: calls('get_balance', 'send_money') };

  it('are measurements in the completeness bundle, each answering its own question', () => {
    expect(caseHistoryRules.map((r) => [r.name, r.kind, r.evalType, r.question])).toEqual([
      ['no_unusual_action', 'measurement', 'completeness', 'tool_use_correct'],
      ['no_dropped_step', 'measurement', 'completeness', 'task_completed'],
      ['no_dropped_specific', 'measurement', 'completeness', 'complete'],
    ]);
  });

  it('no_unusual_action fails naming the tool and its count, with the call as evidence', () => {
    const result = noUnusualAction.evaluate({ ...base, caseHistory: history(6) });
    expect(result.passed).toBe(false);
    expect(result.skipped).toBeUndefined();
    expect(result.message).toBe('Unusual action for this case: send_money, called in 0 of 6 earlier runs');
    expect(result.value).toEqual({ stat: 'unusual_actions', unit: 'tools', value: 1 });
    expect(result.evidence).toEqual([
      { type: 'count', stat: 'unusual_actions', unit: 'tools', value: 1, threshold: 0, thresholdSource: 'rule' },
      { type: 'toolCall', index: 1, toolName: 'send_money', label: 'called in 0 of 6 earlier runs of this case' },
    ]);
  });

  it('no_unusual_action passes when the action is usual, and names a look-up it did not count', () => {
    expect(noUnusualAction.evaluate({ ...base, caseHistory: history(6, 'send_money', 6) }).message).toBe(
      'No unusual action: every tool this run called that may act was called by the earlier runs of its case (6 read)',
    );
    const result = noUnusualAction.evaluate({ ...base, toolCalls: calls('get_balance', 'get_iban'), caseHistory: history(6) });
    expect(result.passed).toBe(true);
    expect(result.message).toContain('1 look-up the earlier runs all but never made (get_iban, 0 of 6 earlier runs) is noted and not counted');
  });

  it('no_unusual_action declines three ways, each saying which', () => {
    const none = noUnusualAction.evaluate({ output: 'x', caseHistory: history(6) });
    expect([none.skipped, none.skipReason]).toEqual([true, expect.stringContaining('context.toolCalls not provided')]);
    const few = noUnusualAction.evaluate({ ...base, caseHistory: history(2) });
    expect([few.skipped, few.skipReason]).toEqual([true, 'insufficient_history: 2 earlier runs of this case with recorded tool calls, 3 needed']);
    const bare = noUnusualAction.evaluate(base);
    expect(bare.skipReason).toBe('insufficient_history: 0 earlier runs of this case with recorded tool calls, 3 needed');
    const own = ['delete_file', 'post_message', 'create_event', 'update_password'];
    const scattered = noUnusualAction.evaluate({ ...base, caseHistory: history(6).map((r, i) => (i < 4 ? run([...r.tools!, own[i]]) : r)) });
    expect([scattered.skipped, scattered.skipReason]).toEqual([true, 'no_usual_way: 4 of the 6 earlier runs of this case each took an action the others all but never took']);
  });

  it('no_dropped_step fails naming the step, judges an explicit empty list, and declines when the earlier runs share none', () => {
    const dropped = noDroppedStep.evaluate({ ...base, toolCalls: calls('get_balance'), caseHistory: history(6, 'send_money', 6) });
    expect(dropped.passed).toBe(false);
    expect(dropped.message).toBe('Dropped step for this case: send_money, called in 6 of 6 earlier runs, and not in this one');
    expect(dropped.evidence).toEqual([
      { type: 'count', stat: 'dropped_steps', unit: 'tools', value: 1, threshold: 0, thresholdSource: 'rule' },
      { type: 'pattern', name: 'dropped_step:send_money', count: 6 },
    ]);
    const empty = noDroppedStep.evaluate({ output: 'x', toolCalls: [], caseHistory: history(6) });
    expect([empty.skipped, empty.passed]).toEqual([undefined, false]);
    expect(noDroppedStep.evaluate({ output: 'x', caseHistory: history(6) }).skipped).toBe(true);
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(6) }).message).toBe('No dropped step: this run called the one tool nearly every earlier run of its case called (6 read)');
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(5, undefined, 0, []) }).skipReason).toBe('no_usual_step: no tool was called by nearly every one of the 5 earlier runs of this case');
    expect(noDroppedStep.evaluate({ ...base, caseHistory: history(1) }).skipReason).toBe('insufficient_history: 1 earlier run of this case with recorded tool calls, 3 needed');
  });

  it('no_dropped_specific reports the kind, the count and a trace that carries it, and never the value', () => {
    const earlier: CaseRun[] = Array.from({ length: 5 }, (_, i) => ({ traceId: `trace-${i}`, tools: [], specifics: ['1050', 'billing@example.org'] }));
    const result = noDroppedSpecific.evaluate({ output: 'The invoice was paid.', caseHistory: earlier });
    expect(result.passed).toBe(false);
    expect(result.message).toBe(
      'Dropped specific for this case: a 4-digit number carried by 5 of 5 earlier answers (trace trace-0 carries it); an email address carried by 5 of 5 earlier answers (trace trace-0 carries it), and not by this one',
    );
    expect(result.evidence).toEqual([
      { type: 'count', stat: 'dropped_specifics', unit: 'specifics', value: 2, threshold: 0, thresholdSource: 'rule' },
      { type: 'pattern', name: 'dropped_specific:number', count: 5 },
      { type: 'pattern', name: 'dropped_specific:email_address', count: 5 },
    ]);
    const stored = JSON.stringify(result);
    expect(stored).not.toContain('1050');
    expect(stored).not.toContain('billing@example.org');
  });

  it('no_dropped_specific passes when the answer carries them, and declines when the earlier answers share none', () => {
    const earlier: CaseRun[] = Array.from({ length: 4 }, () => ({ tools: [], specifics: ['1050'] }));
    expect(noDroppedSpecific.evaluate({ output: 'Total: 1,050.00', caseHistory: earlier }).message).toBe('No dropped specific: this answer carries the one specific nearly every earlier answer to its case carried (4 read)');
    expect(noDroppedSpecific.evaluate({ output: 'Total: 9', caseHistory: Array.from({ length: 4 }, () => run([], [])) }).skipReason).toBe(
      'no_usual_specific: no figure, date, address or identifier was carried by nearly every one of the 4 earlier answers to this case',
    );
    expect(noDroppedSpecific.evaluate({ output: 'Total: 9' }).skipReason).toBe('insufficient_history: 0 earlier runs of this case with an answer, 3 needed');
  });
});

describe('through the engine', () => {
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
  const ctx: EvalContext = { output: 'The transfer of 420 is done and confirmed for the account.', input: 'Pay the open invoice and confirm it.', toolCalls: calls('get_balance', 'send_money') };
  const row = (result: Awaited<ReturnType<typeof engine.evaluateAll>>, name: string) => result.rule_results.find((r) => r.ruleName === name)!;

  it('a call with no history skips all three, and the verdict is what it was without them', async () => {
    const result = await engine.evaluateAll(ctx);
    for (const rule of caseHistoryRules) expect(row(result, rule.name).skipped, rule.name).toBe(true);
  });

  it('an unusual action is reported and decides nothing: the verdict and its basis do not move', async () => {
    const alone = await engine.evaluateAll(ctx);
    const withHistory = await engine.evaluateAll({ ...ctx, caseHistory: history(6) });
    const action = row(withHistory, 'no_unusual_action');
    expect(action.passed).toBe(false);
    expect(action.kind).toBe('measurement');
    expect(action.role).toBe('advisory');
    expect(action.state).toBe('fail');
    expect(withHistory.verdict?.state).toBe(alone.verdict?.state);
    expect(withHistory.verdict?.basis).toBe(alone.verdict?.basis);
    expect(withHistory.passed).toBe(alone.passed);
  });

  it('an answer written as JSON is read by its values on both sides', async () => {
    const earlier: CaseRun[] = Array.from({ length: 4 }, () => caseRunOf({ tool_calls: [], output: '{"total": 420, "status": "paid"}' }));
    const kept = await engine.evaluate('completeness', { output: '{"status": "paid", "total": 420.0}', caseHistory: earlier });
    expect(row(kept, 'no_dropped_specific').passed).toBe(true);
    const lost = await engine.evaluate('completeness', { output: '{"status": "paid"}', caseHistory: earlier });
    expect(row(lost, 'no_dropped_specific').passed).toBe(false);
  });
});
