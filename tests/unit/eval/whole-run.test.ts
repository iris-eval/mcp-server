/*
 * A rule answers for the run it read.
 *
 * The rules that read a run's tool calls read them through one list, and
 * until 0.22.0 that list stopped at the 500th call. Each rule then answered
 * as if the 500 were the run, with a note in its message that no verdict
 * read: a call the schema rejects passed as the 501st, and a failure
 * recovered 2,000 calls later failed the run (#1013).
 *
 * The list is now MAX_STEPS_DERIVED long, and what this file holds is the
 * other half: past it, a rule reports a finding the rest of the run cannot
 * clear, and otherwise says it was not judged. Each rule that reads the
 * trajectory is in the table at the foot of this file, with what it does
 * there; a rule added without a row fails the last test.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { builtInRules } from '../../../src/eval/criticality.js';
import { MAX_STEPS_DERIVED, notJudgedPastCeiling, runWasCut, stepsUpTo } from '../../../src/eval/steps.js';
import { noToolLoop } from '../../../src/eval/rules/cost.js';
import { caseRunOf } from '../../../src/eval/case-history.js';
import type { CaseRun, EvalContext, EvalResult, EvalRuleResult } from '../../../src/types/eval.js';
import type { ToolCallRecord, ToolDescriptor } from '../../../src/types/trace.js';
import { cpuMs } from '../../helpers/cpu-time.js';

/*
 * How long a test here may take. Each evaluates runs of 10,000 calls, some of
 * them four times over. One evaluation of every bundle is 0.3 to 0.5 s of CPU
 * on a developer machine. On the CI job that runs the suite under coverage
 * it measured about 1.7 s of wall time, a test that makes four took 6.7 s,
 * and two tests passed the 5 s the suite gives a test in CI. What holds the
 * cost of the code is the CPU budget inside each test; this is only the
 * time the runner is given to get there.
 */
vi.setConfig({ testTimeout: 60_000 });

const N = MAX_STEPS_DERIVED;
const engine = (overrides: Partial<typeof defaultConfig.eval> = {}) => new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, ...overrides });
const row = (result: EvalResult, name: string): EvalRuleResult => result.rule_results.find((r) => r.ruleName === name)!;

const TOOLS: ToolDescriptor[] = [
  { name: 'read_file', description: 'Read one source file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false }, annotations: { readOnlyHint: true } },
  { name: 'send_invoice', description: 'Send an invoice to a customer by email.', inputSchema: { type: 'object', properties: { customer: { type: 'string' } }, required: ['customer'], additionalProperties: false }, annotations: { readOnlyHint: false } },
];
const read = (i: number): ToolCallRecord => ({ tool_name: 'read_file', input: { path: `src/file_${i}.ts` }, output: `export const v${i} = ${i};` });
const reads = (n: number, from = 0): ToolCallRecord[] => Array.from({ length: n }, (_, i) => read(from + i));
const RUN = { input: 'Read the source files, then send the invoice to the customer acme.', output: 'I read the files and sent the invoice to acme.' };

describe('the rules read a run of more than 500 calls whole', () => {
  it('valid_tool_arguments: a call the schema rejects fails wherever in the run it is', async () => {
    const bad: ToolCallRecord = { tool_name: 'read_file', input: { path: 42 }, output: 'error: path must be a string', error: 'invalid arguments' };
    for (const before of [10, 499, 500, 2_000, N - 1]) {
      const r = row(await engine().evaluateAll({ ...RUN, toolCalls: [...reads(before), bad], tools: TOOLS }), 'valid_tool_arguments');
      expect(r.passed, `${before} valid calls first`).toBe(false);
      expect(r.skipped, `${before} valid calls first`).toBeFalsy();
      expect(r.message, `${before} valid calls first`).toContain('Invalid tool call the agent never recovered from: read_file (/path type)');
    }
  });

  it('valid_tool_arguments: a wrong argument retried successfully 2,000 calls later is retried, not unrecovered', async () => {
    const wrong: ToolCallRecord = { tool_name: 'send_invoice', input: { customer: 42 }, output: 'error: customer must be a string', error: 'invalid arguments' };
    const right: ToolCallRecord = { tool_name: 'send_invoice', input: { customer: 'acme' }, output: 'sent' };
    for (const between of [10, 498, 2_000]) {
      const r = row(await engine().evaluateAll({ ...RUN, toolCalls: [wrong, ...reads(between), right], tools: TOOLS }), 'valid_tool_arguments');
      expect(r.passed, `${between} reads between`).toBe(true);
      expect(r.message, `${between} reads between`).toContain('1 invalid call the agent retried successfully');
    }
  });

  it('no_silent_tool_failure: a failed call after 500 that worked fails the run, and a failure recovered 2,000 calls later does not', async () => {
    const failed: ToolCallRecord = { tool_name: 'send_report', input: { to: 'ops' }, output: '{"status":"failed","error":"permission_denied"}' };
    const said = { input: 'Read the files, then send the report to ops.', output: 'I read the files and sent the report to ops. Everything completed successfully.' };
    for (const before of [10, 499, 500, 2_000]) {
      const r = row(await engine().evaluateAll({ ...said, toolCalls: [...reads(before), failed] }), 'no_silent_tool_failure');
      expect(r.passed, `${before} reads first`).toBe(false);
      expect(r.message, `${before} reads first`).toContain('Silent tool failure: send_report');
    }
    const failedInvoice: ToolCallRecord = { tool_name: 'send_invoice', input: { customer: 'acme' }, output: '{"status":"failed","error":"timeout"}' };
    const retried: ToolCallRecord = { tool_name: 'send_invoice', input: { customer: 'acme' }, output: 'sent' };
    for (const between of [10, 498, 2_000]) {
      const r = row(await engine().evaluateAll({ ...RUN, toolCalls: [failedInvoice, ...reads(between), retried] }), 'no_silent_tool_failure');
      expect(r.passed, `${between} reads between`).toBe(true);
      expect(r.message, `${between} reads between`).toContain('1 earlier failure was recovered by a later call that went right');
    }
  });

  it('tool_choice: the tool that fits, called after 2,000 reads, was called', async () => {
    const right: ToolCallRecord = { tool_name: 'send_invoice', input: { customer: 'acme' }, output: 'sent' };
    for (const before of [10, 499, 500, 2_000]) {
      const r = row(await engine().evaluateAll({ input: 'Send the invoice to the customer acme by email.', output: 'The invoice was sent to acme.', toolCalls: [...reads(before), right], tools: TOOLS }), 'tool_choice');
      expect(r.passed, `${before} reads first`).toBe(true);
      expect(r.skipped, `${before} reads first`).toBeFalsy();
    }
  });

  it('max_steps and step_budget count the calls the run made, however many the rules read', async () => {
    // A budget above the old list's length could not be exceeded: every run counted as 500 calls at most.
    const budgeted = new EvalEngine(defaultConfig.eval.defaultThreshold, { ...defaultConfig.eval.ruleThresholds, max_steps: 1_000 }, defaultConfig.eval);
    const over = await budgeted.evaluateAll({ ...RUN, toolCalls: reads(2_000), expectedTrajectory: { step_budget: 1_000 } });
    expect(row(over, 'max_steps')).toMatchObject({ passed: false, value: { value: 2_000 } });
    expect(row(over, 'max_steps').message).toContain('Step budget: 2000 tool calls exceeds 1000');
    expect(row(over, 'step_budget')).toMatchObject({ passed: false, value: { value: 2_000 } });
    expect(row(over, 'step_budget').message).toContain('Step budget: 2000 tool calls exceeds 1000 × 1.5 = 1500 (500 over)');
    // And past the list the count is still the run's own.
    const far = await engine().evaluateAll({ ...RUN, toolCalls: reads(N + 250), expectedTrajectory: { step_budget: N } });
    expect(row(far, 'max_steps')).toMatchObject({ passed: false, value: { value: N + 250 } });
    expect(row(far, 'step_budget')).toMatchObject({ passed: true, value: { value: N + 250 } });
    expect(row(far, 'step_budget').skipped).toBeFalsy();
    expect(row(far, 'max_steps').message).not.toContain('were read');
  });

  it('no_tool_loop: a loop is a loop wherever in the run it is, and a repeated sequence of any length a run can hold is found', () => {
    const loop: ToolCallRecord[] = Array.from({ length: 4 }, () => ({ tool_name: 'read_file', input: { path: 'src/same.ts' }, output: 'x' }));
    const late = noToolLoop.evaluate({ output: 'done', toolCalls: [...reads(1_500), ...loop] } as EvalContext);
    expect(late.passed).toBe(false);
    expect(late.message).toContain('read_file called 4 times with the same input');
    // A three-call sequence repeated three times, after 3,000 other calls.
    const abc = ['a', 'b', 'c'].map((p): ToolCallRecord => ({ tool_name: 'read_file', input: { path: `src/${p}.ts` }, output: 'x' }));
    const cycle = noToolLoop.evaluate({ output: 'done', toolCalls: [...reads(3_000), ...abc, ...abc, ...abc] } as EvalContext);
    expect(cycle.passed).toBe(false);
    expect(cycle.message).toContain('a 3-call sequence');
    /*
     * A 160-call sequence run three times, then other calls. Each call is
     * made three times, which the count of identical calls allows, so only
     * the search for a repeated sequence can see it. A search held to the
     * work it did at 500 calls stopped short of 160 once the run was 502
     * calls long, and passed a loop it had reported at 500.
     */
    const gram = Array.from({ length: 160 }, (_, i): ToolCallRecord => ({ tool_name: 'read_file', input: { path: `src/loop/${i}.ts` }, output: 'x' }));
    for (const others of [0, 20, 22, 122, 1_520, N - 480]) {
      const result = noToolLoop.evaluate({ output: 'done', toolCalls: [...gram, ...gram, ...gram, ...reads(others)] } as EvalContext);
      expect(result.passed, `${others} other calls after it`).toBe(false);
      expect(result.message, `${others} other calls after it`).toContain('a 160-call sequence');
    }
    // The longest sequence a run of the list's length can hold three times, at the end of it.
    const long = Array.from({ length: 3_000 }, (_, i): ToolCallRecord => ({ tool_name: 'read_file', input: { path: `src/long/${i}.ts` }, output: 'x' }));
    const longest = noToolLoop.evaluate({ output: 'done', toolCalls: [...reads(N - 9_000), ...long, ...long, ...long] } as EvalContext);
    expect(longest.passed).toBe(false);
    expect(longest.message).toContain('a 3000-call sequence');
    // A clean run says nothing about how far it looked: it looked at every length.
    const clean = noToolLoop.evaluate({ output: 'done', toolCalls: reads(2_000) } as EvalContext);
    expect(clean.passed).toBe(true);
    expect(clean.message).toBe('No repeated tool call (2000 calls; most repeated ran 1×, max 3)');
  });

  it('no_tool_loop: a call repeated past the allowance is a loop when the most repeated call is a poll', () => {
    // get_status six times at a steady cadence is a machine waiting. read_file five times on one path, with no cadence, is not, and stood behind it.
    const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
    const span = (i: number, name: string, input: Record<string, unknown>, ms: number) => ({ span_id: `s${i}`, trace_id: 't', name, kind: 'TOOL' as const, status_code: 'OK' as const, start_time: at(ms), attributes: { 'tool.name': name, 'tool.input': input } });
    const polls = Array.from({ length: 6 }, (_, i) => span(i, 'get_status', { id: 'build-7' }, i * 10_000));
    const rereads = [0, 300, 700, 12_000, 12_100].map((ms, i) => span(100 + i, 'read_file', { path: 'src/same.ts' }, 60_000 + ms));
    const result = noToolLoop.evaluate({ output: 'done', spans: [...polls, ...rereads] } as unknown as EvalContext);
    expect(result.passed).toBe(false);
    expect(result.message).toContain('read_file called 5 times with the same input');
    expect(result.value).toMatchObject({ value: 5 });
    // The poll alone still passes, and is said to be one.
    const waiting = noToolLoop.evaluate({ output: 'done', spans: polls } as unknown as EvalContext);
    expect(waiting.passed).toBe(true);
    expect(waiting.message).toContain('get_status ran 6× at a regular cadence');
  });

  it('no_tool_loop: a poll hides no loop in the other two readings either: a sequence of the poll\'s own length, a target read again behind a polled one', () => {
    const at = (ms: number) => new Date(Date.UTC(2026, 0, 1) + ms).toISOString();
    const span = (i: number, name: string, input: Record<string, unknown>, ms: number) => ({ span_id: `s${i}`, trace_id: 't', name, kind: 'TOOL' as const, status_code: 'OK' as const, start_time: at(ms), attributes: { 'tool.name': name, 'tool.input': input } });
    // Two calls polled four times over at a steady cadence, then two other calls in turn three times with none.
    const polled = Array.from({ length: 4 }, (_, r) => [span(2 * r, 'get_status', { id: 'build-7' }, r * 10_000), span(2 * r + 1, 'get_log', { id: 'build-7' }, r * 10_000 + 200)]).flat();
    const turns = [0, 150, 400, 500, 900, 1_000].map((ms, i) => span(100 + i, i % 2 === 0 ? 'open_page' : 'close_page', { n: 1 }, 60_000 + ms));
    const behind = noToolLoop.evaluate({ output: 'done', spans: [...polled, ...turns], customConfig: { max_tool_repeats: 10 } } as unknown as EvalContext);
    expect(behind.passed).toBe(false);
    expect(behind.message).toContain('open_page ({"n":1}), close_page ({"n":1}) alternate for 3 repetitions');
    // The poll alone is still a machine waiting, and the loop alone is still a loop.
    expect(noToolLoop.evaluate({ output: 'done', spans: polled, customConfig: { max_tool_repeats: 10 } } as unknown as EvalContext).passed).toBe(true);
    expect(noToolLoop.evaluate({ output: 'done', spans: turns } as unknown as EvalContext).passed).toBe(false);
    // One log read six times ten seconds apart through three read-only tools, then one file read five times with no cadence.
    const tools: ToolDescriptor[] = ['read_file', 'cat', 'head'].map((name) => ({ name, description: 'Read a file.', inputSchema: { type: 'object', properties: { path: { type: 'string' } } }, annotations: { readOnlyHint: true } }));
    const names = ['read_file', 'cat', 'head'];
    const watched = Array.from({ length: 6 }, (_, i) => span(200 + i, names[i % 3], { path: 'build.log', n: i }, i * 10_000));
    const reread = [0, 300, 700, 12_000, 12_100].map((ms, i) => span(300 + i, names[i % 3], { path: 'report.md', n: i }, 90_000 + ms));
    const target = noToolLoop.evaluate({ output: 'done', spans: [...watched, ...reread], tools } as unknown as EvalContext);
    expect(target.passed).toBe(false);
    expect(target.message).toContain('the same target was read 5 times through 3 tools');
    expect(noToolLoop.evaluate({ output: 'done', spans: watched, tools } as unknown as EvalContext).passed).toBe(true);
  });

  it('a run of the list\'s whole length is read inside a CPU budget, in the shapes that cost the most', async () => {
    // Every call distinct; every call failing; every other call failing. Measured at 0.3 to 0.7 s each; the budget is the bound a search that grew with the square of the run would break.
    const failing = (i: number): ToolCallRecord => ({ tool_name: 'read_file', input: { path: `src/f${i}.ts` }, output: 'x', error: 'ENOENT: no such file or directory' });
    const shapes: Array<[string, ToolCallRecord[]]> = [
      ['every call distinct', reads(N)],
      ['every call failing', Array.from({ length: N }, (_, i) => failing(i))],
      ['every other call failing', Array.from({ length: N }, (_, i) => (i % 2 === 0 ? failing(i) : read(i)))],
    ];
    for (const [label, toolCalls] of shapes) {
      const e = engine();
      const started = process.cpuUsage();
      const result = await e.evaluateAll({ ...RUN, toolCalls, tools: TOOLS });
      const spent = process.cpuUsage(started);
      expect((spent.user + spent.system) / 1000, label).toBeLessThan(10_000);
      expect(result.rule_results.length, label).toBeGreaterThan(10);
    }
  });

  it('a poll of the list\'s whole length sends the loop search through every period it tries, inside a CPU budget', () => {
    // A steady cadence is a machine waiting, so the count of identical calls stands down and the search for a repeated sequence runs over 10,000 identical keys: every start, every period. Only spans carry the times a cadence is read from.
    const polled = (ids: string[]) =>
      Array.from({ length: N }, (_, i) => ({
        span_id: `s${String(i).padStart(6, '0')}`,
        trace_id: 't',
        name: 'get_status',
        kind: 'TOOL' as const,
        status_code: 'OK' as const,
        start_time: new Date(Date.UTC(2026, 0, 1) + i * 5_000).toISOString(),
        attributes: { 'tool.name': 'get_status', 'tool.input': { id: ids[i % ids.length] } },
      }));
    for (const [label, spans] of [['one call polled', polled(['build-7'])], ['two calls polled in turn', polled(['build-7', 'build-8'])]] as const) {
      let result!: EvalRuleResult;
      expect(cpuMs(() => (result = noToolLoop.evaluate({ output: 'done', spans } as unknown as EvalContext))), label).toBeLessThan(10_000);
      expect(result.skipped, label).toBeFalsy();
      expect(result.passed, label).toBe(true);
      expect(result.message, label).toContain('polling rather than a loop');
    }
  });
});

describe('past the list, a rule does not answer for the run', () => {
  const longer = (extra: ToolCallRecord[] = []) => [...reads(N), ...extra];

  it('a clean reading is not a clean result: each trajectory rule is not judged, and says how far it read', async () => {
    const earlier: CaseRun[] = Array.from({ length: 6 }, () => ({ tools: ['read_file'] }));
    const result = await engine().evaluateAll({
      ...RUN,
      toolCalls: longer([read(N)]),
      tools: TOOLS,
      caseHistory: earlier,
      expectedTrajectory: { tool_calls: [{ tool_name: 'read_file' }] },
    });
    for (const name of ['valid_tool_arguments', 'no_tool_loop', 'no_silent_tool_failure', 'grounded_in_reads', 'no_unusual_action']) {
      const r = row(result, name);
      expect(r, name).toMatchObject({ skipped: true, evidenceIncomplete: true, skipClass: 'defeated', state: 'not_checked' });
      expect(r.message, name).toContain(`the first ${N} of`);
      expect(r.message, name).not.toMatch(/^(Every checked call was callable|No tool call was left failed|No repeated tool call|No unusual action)/);
    }
    // no_injection_compliance reads what it read when the list was 500 calls long (safety.ts, INJECTION_STEPS_READ; #1016): it passes as it did, and its message says the rest were not examined.
    expect(row(result, 'no_injection_compliance')).toMatchObject({ passed: true, state: 'pass' });
    expect(row(result, 'no_injection_compliance').message).toContain('the rest were not examined');
    // The counts need no reading, and are judged.
    expect(row(result, 'max_steps').skipped).toBeFalsy();
    expect(row(result, 'step_budget').skipped).toBeFalsy();
    // And two that the calls read settle: the one call expected was made, and the one step the case always takes was taken. More calls undo neither.
    expect(row(result, 'tool_sequence')).toMatchObject({ passed: true, state: 'pass' });
    expect(row(result, 'tool_sequence').message).toContain(`the first ${N} of ${N + 1} calls were read`);
    expect(row(result, 'no_dropped_step')).toMatchObject({ passed: true, state: 'pass' });
    // And a choice of tools that no uncalled tool beats: the tools called can only grow.
    expect(row(result, 'tool_choice')).toMatchObject({ passed: true, state: 'pass' });
  });

  it('a rule promoted to critical then makes the verdict unknown, where it passed clean', async () => {
    for (const name of ['valid_tool_arguments', 'no_silent_tool_failure', 'no_tool_loop']) {
      const result = await engine({ criticalRules: [name] }).evaluateAll({ ...RUN, toolCalls: longer([read(N)]), tools: TOOLS });
      expect(result.verdict, name).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
      expect(result.verdict?.by, name).toContain(name);
      expect(result.passed, name).toBe(false);
    }
  });

  it('valid_tool_arguments: nothing checkable among the calls read is not "nothing to check" in a run read in part', async () => {
    // Ten thousand calls to a tool the catalogue lists with no schema, and one more: a tool the catalogue does not have.
    const bare: ToolDescriptor[] = [{ name: 'note', description: 'Keep a note.' }];
    const notes = Array.from({ length: N }, (_, i): ToolCallRecord => ({ tool_name: 'note', input: { text: `n${i}` }, output: 'ok' }));
    const last: ToolCallRecord = { tool_name: 'drop_database', input: { name: 'prod' }, output: 'dropped' };
    const result = await engine({ criticalRules: ['valid_tool_arguments'] }).evaluateAll({ ...RUN, toolCalls: [...notes, last], tools: bare });
    const r = row(result, 'valid_tool_arguments');
    expect(r).toMatchObject({ skipped: true, evidenceIncomplete: true, skipClass: 'defeated' });
    expect(r.message).toContain('None of them could be checked (note (no inputSchema in the catalogue)), and the rest were not read');
    expect(result.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
    // Read whole, the same last call is the finding, and a run of nothing checkable is still not applicable.
    const whole = await engine({ criticalRules: ['valid_tool_arguments'] }).evaluateAll({ ...RUN, toolCalls: [...notes.slice(0, 20), last], tools: bare });
    expect(row(whole, 'valid_tool_arguments')).toMatchObject({ passed: false, state: 'fail' });
    const nothing = await engine({ criticalRules: ['valid_tool_arguments'] }).evaluateAll({ ...RUN, toolCalls: notes.slice(0, 20), tools: bare });
    expect(row(nothing, 'valid_tool_arguments')).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
    expect(nothing.verdict?.basis).not.toBe('critical_unknown');
  });

  it('a rule somebody asked for that could not answer makes the verdict unknown too: an expectation the call supplied, a threshold the deployment set', async () => {
    // superset: no call outside the expected set among those read, and the rest unread. Not critical; the call asked for it.
    const expectation = await engine().evaluateAll({ ...RUN, toolCalls: longer([read(N)]), expectedTrajectory: { tool_calls: [{ tool_name: 'read_file' }], mode: 'superset', step_budget: N * 2 } });
    expect(row(expectation, 'tool_sequence')).toMatchObject({ skipped: true, skipClass: 'defeated', asked: 'call' });
    expect(row(expectation, 'tool_sequence').critical).toBe(false);
    expect(expectation.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown', by: ['tool_sequence'] });
    expect(expectation.passed).toBe(false);
    expect(expectation.interpretations?.map((i) => i.text).join(' ')).toContain('A check was asked and could not answer (tool_sequence, which this call asked for)');
    // The deployment set max_tool_repeats: it asked for the loop check, and a clean reading of part of a run is not its answer.
    const configured = new EvalEngine(defaultConfig.eval.defaultThreshold, { ...defaultConfig.eval.ruleThresholds, max_tool_repeats: 2 }, { ...defaultConfig.eval, configuredThresholdKeys: ['max_tool_repeats'] });
    const threshold = await configured.evaluateAll({ ...RUN, toolCalls: longer([read(N)]) });
    expect(row(threshold, 'no_tool_loop')).toMatchObject({ skipped: true, skipClass: 'defeated', asked: 'config' });
    expect(threshold.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
    expect(threshold.verdict?.by).toContain('no_tool_loop');
    // Nobody asked: the same row leaves the verdict alone, as before.
    const unasked = await engine().evaluateAll({ ...RUN, toolCalls: longer([read(N)]) });
    expect(row(unasked, 'no_tool_loop')).toMatchObject({ skipped: true, skipClass: 'defeated' });
    expect(row(unasked, 'no_tool_loop').asked).toBeUndefined();
    expect(unasked.verdict?.basis).not.toBe('critical_unknown');
    // A rule the deployment set to report only is asked for by nobody: a loop it found would not have touched the verdict, and its silence does not either.
    const reporting = new EvalEngine(defaultConfig.eval.defaultThreshold, { ...defaultConfig.eval.ruleThresholds, max_tool_repeats: 2 }, { ...defaultConfig.eval, advisoryRules: ['no_tool_loop'], configuredThresholdKeys: ['max_tool_repeats'] });
    const silent = await reporting.evaluateAll({ ...RUN, toolCalls: longer([read(N)]) });
    expect(row(silent, 'no_tool_loop')).toMatchObject({ skipped: true, skipClass: 'defeated' });
    expect(row(silent, 'no_tool_loop').asked).toBeUndefined();
    expect(silent.verdict?.basis).not.toBe('critical_unknown');
    expect(silent.verdict?.by ?? []).not.toContain('no_tool_loop');
    const looping = await reporting.evaluateAll({ ...RUN, toolCalls: [read(1), read(1), read(1), read(1), read(2)] });
    expect(row(looping, 'no_tool_loop')).toMatchObject({ passed: false, advisory: true });
    expect(looping.verdict?.by ?? []).not.toContain('no_tool_loop');
    // And eval.onCriticalSkipped decides it, as for a critical rule.
    const accepted = await engine({ onCriticalSkipped: 'pass' }).evaluateAll({ ...RUN, toolCalls: longer([read(N)]), expectedTrajectory: { tool_calls: [{ tool_name: 'read_file' }], mode: 'superset', step_budget: N * 2 } });
    expect(accepted.verdict?.basis).not.toBe('critical_unknown');
  });

  it('tool_sequence: what the calls read settle stands, in every mode', async () => {
    const judge = async (expectedTrajectory: EvalContext['expectedTrajectory'], toolCalls: ToolCallRecord[]) => row(await engine().evaluateAll({ ...RUN, toolCalls, expectedTrajectory }), 'tool_sequence');
    const three = [{ tool_name: 'read_file' }, { tool_name: 'read_file' }, { tool_name: 'read_file' }];
    // strict and unordered: a run with more calls than were expected differs from the expectation, whatever the rest are.
    for (const mode of ['strict', 'unordered'] as const) {
      const r = await judge({ tool_calls: three, mode }, longer([read(N)]));
      expect(r, mode).toMatchObject({ passed: false, state: 'fail' });
      expect(r.message, mode).toContain(`the run made ${N + 1} calls and 3 were expected, so ${N - 2} are beyond the expected ${mode === 'strict' ? 'sequence' : 'set'}`);
      expect(r.message, mode).toContain(`the first ${N} of ${N + 1} calls were read`);
    }
    // strict: a call out of place among those read is the finding it always was.
    const misplaced = await judge({ tool_calls: [{ tool_name: 'send_invoice' }], mode: 'strict' }, longer([read(N)]));
    expect(misplaced.passed).toBe(false);
    expect(misplaced.message).toContain('call 1 was read_file, expected send_invoice');
    // superset: a call outside the expected set, once read, is outside it.
    const outside = await judge({ tool_calls: [{ tool_name: 'read_file' }], mode: 'superset' }, [{ tool_name: 'delete_branch', input: { name: 'main' }, output: 'deleted' }, ...longer()]);
    expect(outside).toMatchObject({ passed: false, state: 'fail' });
    expect(outside.message).toContain('1 call outside the expected set (first: #0 delete_branch)');
    // subset and ordered_subset: satisfied among the calls read, no later call can unsatisfy it.
    for (const mode of ['subset', 'ordered_subset'] as const) {
      const r = await judge({ tool_calls: [{ tool_name: 'read_file', input: { path: 'src/file_3.ts' } }], mode }, longer([read(N)]));
      expect(r, mode).toMatchObject({ passed: true, state: 'pass' });
      expect(r.message, mode).toContain(`satisfied by the ${N} read`);
    }
    // And what they do not settle is not judged: an expected call not yet seen may be among the rest.
    for (const mode of ['subset', 'ordered_subset'] as const) {
      const r = await judge({ tool_calls: [{ tool_name: 'send_invoice' }], mode }, longer([read(N)]));
      expect(r, mode).toMatchObject({ skipped: true, evidenceIncomplete: true, skipClass: 'defeated' });
      expect(r.message, mode).toContain('1 expected call was not found among them, and may be among the rest');
    }
  });

  it('a pass the rest of the run cannot break stands: a choice of tools, a failure the answer owns, a step the case takes', async () => {
    // tool_choice: the tool that fits was called among the calls read. More calls only add to the tools called.
    const chosen = row(await engine().evaluateAll({ input: 'Send the invoice to the customer acme by email.', output: 'The invoice was sent to acme.', toolCalls: [{ tool_name: 'send_invoice', input: { customer: 'acme' }, output: 'sent' }, ...longer()], tools: TOOLS }), 'tool_choice');
    expect(chosen).toMatchObject({ passed: true, state: 'pass' });
    expect(chosen.message).toContain(`the first ${N} of ${N + 1} calls were read`);
    // no_silent_tool_failure: the answer says a call failed. A failure among the rest would be owned by the same words.
    const failed: ToolCallRecord = { tool_name: 'send_report', input: { to: 'ops' }, output: '{"status":"failed","error":"permission_denied"}' };
    const owned = { input: 'Read the files, then send the report to ops.', output: 'I read the files. Sending the report failed: permission was denied.' };
    const withFailure = row(await engine().evaluateAll({ ...owned, toolCalls: [failed, ...longer()] }), 'no_silent_tool_failure');
    expect(withFailure).toMatchObject({ passed: true, state: 'pass' });
    expect(withFailure.message).toContain('1 tool call went wrong (send_report) and the output acknowledges it');
    expect(withFailure.message).toContain(`the first ${N} of ${N + 1} calls were read`);
    const noneRead = row(await engine().evaluateAll({ ...owned, toolCalls: longer([read(N)]) }), 'no_silent_tool_failure');
    expect(noneRead).toMatchObject({ passed: true, state: 'pass' });
    expect(noneRead.message).toContain('No tool call was left failed among the calls read, and the output acknowledges a failure');
    // no_dropped_step: with no earlier run of the case there is nothing to read the run against, at any length.
    const noHistory = await engine({ criticalRules: ['no_dropped_step'] }).evaluateAll({ ...RUN, toolCalls: longer([read(N)]) });
    expect(row(noHistory, 'no_dropped_step')).toMatchObject({ skipped: true, skipClass: 'not_applicable' });
    expect(noHistory.verdict?.basis).not.toBe('critical_unknown');
  });

  it('a finding the rest of the run cannot clear stands, with how far the rule read', async () => {
    // A call to a tool the catalogue does not have; a loop; an action the case never took.
    const unknownTool: ToolCallRecord = { tool_name: 'drop_database', input: { name: 'prod' }, output: 'dropped' };
    const notListed = row(await engine().evaluateAll({ ...RUN, toolCalls: [unknownTool, ...longer()], tools: TOOLS }), 'valid_tool_arguments');
    expect(notListed.passed).toBe(false);
    expect(notListed.skipped).toBeFalsy();
    expect(notListed.message).toContain('drop_database (not in the catalogue)');
    expect(notListed.message).toContain(`the first ${N} of ${N + 1} calls were read`);
    // Beside it, a call the schema rejects: a retry may be among the calls not read, so it is counted and not named as never recovered from.
    const rejected: ToolCallRecord = { tool_name: 'send_invoice', input: { customer: 7 }, output: 'error: customer must be a string', error: 'invalid arguments' };
    const both = row(await engine().evaluateAll({ ...RUN, toolCalls: [unknownTool, rejected, ...longer().slice(1)], tools: TOOLS }), 'valid_tool_arguments');
    expect(both.passed).toBe(false);
    expect(both.message).toContain('Invalid tool call the agent never recovered from: drop_database (not in the catalogue); 1 more invalid call was not retried successfully among the calls read, and a retry may be among the rest');
    expect(both.message).not.toContain('send_invoice (/customer type)');
    // In a run read whole both are named: nothing is left that could clear the second.
    const whole = row(await engine().evaluateAll({ ...RUN, toolCalls: [unknownTool, rejected, ...reads(20)], tools: TOOLS }), 'valid_tool_arguments');
    expect(whole.message).toContain('Invalid tool calls the agent never recovered from: drop_database (not in the catalogue); send_invoice (/customer type)');

    const same: ToolCallRecord = { tool_name: 'read_file', input: { path: 'src/same.ts' }, output: 'x' };
    const loop = noToolLoop.evaluate({ output: 'done', toolCalls: [same, same, same, same, ...longer()] } as EvalContext);
    expect(loop.passed).toBe(false);
    expect(loop.skipped).toBeFalsy();
    expect(loop.message).toContain(`the first ${N} of ${N + 4} calls were read`);

    const earlier: CaseRun[] = Array.from({ length: 6 }, () => ({ tools: ['read_file'] }));
    const acted = row(await engine().evaluateAll({ ...RUN, toolCalls: [{ tool_name: 'delete_branch', input: { name: 'main' }, output: 'deleted' }, ...longer()], caseHistory: earlier }), 'no_unusual_action');
    expect(acted.passed).toBe(false);
    expect(acted.skipped).toBeFalsy();
    expect(acted.message).toContain('Unusual action for this case: delete_branch');
  });

  it('a finding a later call could clear is not reported as one', async () => {
    // A wrong argument and a failed call, each of which a call among the rest may have put right.
    const wrong: ToolCallRecord = { tool_name: 'send_invoice', input: { customer: 42 }, output: 'error: customer must be a string', error: 'invalid arguments' };
    const result = await engine().evaluateAll({ ...RUN, toolCalls: [wrong, ...longer()], tools: TOOLS });
    const args = row(result, 'valid_tool_arguments');
    expect(args).toMatchObject({ skipped: true, evidenceIncomplete: true });
    expect(args.message).toContain('1 invalid call was not retried successfully among them, and a retry may be among the rest');
    const silent = row(result, 'no_silent_tool_failure');
    expect(silent).toMatchObject({ skipped: true, evidenceIncomplete: true });
    expect(silent.message).toContain('1 call was left failed among them, and a later call may have recovered it');
    // The tool that fits may be called among the rest.
    const choice = row(await engine().evaluateAll({ input: 'Send the invoice to the customer acme by email.', output: 'The invoice was sent.', toolCalls: longer([read(N)]), tools: TOOLS }), 'tool_choice');
    expect(choice).toMatchObject({ skipped: true, evidenceIncomplete: true });
    expect(choice.message).toContain('send_invoice fits the ask better than the tools called among them, and may be called among the rest');
    // A step the case always takes, not found among the calls read, may be among the rest.
    const earlier: CaseRun[] = Array.from({ length: 6 }, () => ({ tools: ['read_file', 'send_invoice'] }));
    const dropped = row(await engine().evaluateAll({ ...RUN, toolCalls: longer([read(N)]), caseHistory: earlier }), 'no_dropped_step');
    expect(dropped).toMatchObject({ skipped: true, evidenceIncomplete: true, skipClass: 'defeated' });
    expect(dropped.message).toContain('send_invoice, called in every one of the 6 earlier runs of this case, was not called among them and may be among the rest');
  });

  it('ask_coverage judges the answer whatever the run\'s length, and does not find against a part a later call may have done', async () => {
    // An ask and two answers from the rule's own family: one that covers both parts, one that drops two of three.
    const covered = row(
      await engine().evaluateAll({
        input: 'Tell me (1) what the dashboard port is and (2) which file sets it.',
        output: 'It listens on 6920. That value comes from the dashboard block in the configuration defaults.',
        toolCalls: longer([read(N)]),
      }),
      'ask_coverage',
    );
    const ask = 'Tell me (1) how many built-in rules there are, (2) which bundle each rule belongs to, and (3) which rules are critical by default.';
    const partial = 'There are seventeen built-in rules.';
    expect(covered.passed).toBe(true);
    expect(covered.skipped).toBeFalsy();
    const dropped = row(await engine().evaluateAll({ input: ask, output: partial, toolCalls: longer([read(N)]) }), 'ask_coverage');
    expect(dropped).toMatchObject({ skipped: true, evidenceIncomplete: true });
    expect(dropped.message).toContain('2 parts of the ask are addressed by neither the answer nor a call among them, and a call among the rest may address them');
    // Read whole, the same answer is the finding it was.
    const short = row(await engine().evaluateAll({ input: ask, output: partial, toolCalls: reads(20) }), 'ask_coverage');
    expect(short.passed).toBe(false);
    expect(short.skipped).toBeFalsy();
  });

  it('the helper says nothing of a run that was read whole', () => {
    const whole = { output: 'x', toolCalls: reads(N) } as EvalContext;
    expect(runWasCut(whole)).toBe(false);
    expect(notJudgedPastCeiling('any_rule', whole, 'Nothing')).toBeNull();
    const cut = { output: 'x', toolCalls: reads(N + 1) } as EvalContext;
    expect(runWasCut(cut)).toBe(true);
    expect(notJudgedPastCeiling('any_rule', cut, 'Nothing was found among them')).toMatchObject({
      ruleName: 'any_rule',
      skipped: true,
      evidenceIncomplete: true,
      passed: false,
      skipReason: `partial_trajectory: ${N} of ${N + 1} calls read`,
      message: `Not judged: the first ${N} of this run's ${N + 1} calls were read. Nothing was found among them. The rules read a run's first ${N} calls`,
    });
    expect(stepsUpTo({ toolCalls: reads(N + 5) }, N)).toMatchObject({ available: N + 5 });
  });

  it('a stored run of up to the list\'s length keeps its tools, and a longer one is not counted among the earlier runs', () => {
    expect(caseRunOf({ tool_calls: reads(2_000) }).tools).toEqual(['read_file']);
    expect(caseRunOf({ tool_calls: reads(N) }).tools).toEqual(['read_file']);
    expect(caseRunOf({ tool_calls: reads(N + 1) }).tools).toBeNull();
  });
});

/*
 * Every rule file that reads the trajectory, and what each rule in it does
 * with a run longer than the list. A rule that starts reading the
 * trajectory has to be put here, which is the point: the 500-call ceiling
 * was inherited by rule after rule because nothing asked.
 */
const PAST_THE_LIST: Record<string, string> = {
  valid_tool_arguments: 'a call to a tool the catalogue does not have stands; otherwise not judged',
  ask_coverage: 'an answer that covers every part is judged; a part left uncovered is not judged',
  tool_sequence: 'what the calls read settle stands (more calls than a strict or unordered expectation holds, a call outside a superset, a subset already satisfied); otherwise not judged',
  no_unusual_action: 'an action new to the case stands; otherwise not judged',
  no_dropped_step: 'a pass stands; a step not found among the calls read is not judged',
  tool_choice: 'a pass stands; a finding is not judged',
  no_tool_loop: 'a loop stands; otherwise not judged',
  max_steps: 'counts the calls the run made',
  step_budget: 'counts the calls the run made',
  no_silent_tool_failure: 'an answer that acknowledges a failure passes; otherwise not judged',
  grounded_in_reads: 'not judged',
  no_injection_compliance: 'reads the first 500 calls and the first 25 tool outputs among them, as it did when the list was 500 long, and says what it left unread (#1016)',
  action_policy: 'reads to its own ceiling; a denied call stands; otherwise not judged',
  // These two read the calls as they were sent, not through the list: nothing of theirs is cut.
  cost_anomaly: 'reads every call for the dearest one',
  says_something: 'reads only whether any call was made',
};

describe('every rule that reads the trajectory says what it does past the list', () => {
  it('each rule that reads the calls, through the list or as they were sent, is in the table', () => {
    const dir = resolve(__dirname, '../../../src/eval/rules');
    const readers = new Set<string>();
    const readsCalls = /\bstepsOf\(|\bcontext\.toolCalls\b|\bcontext\.spans\b/;
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(resolve(dir, file), 'utf8').split('\r\n').join('\n');
      // One rule object at a time: from its `name:` line to the next one's. A helper that stands after a rule is read as that rule's.
      const parts = source.split(/\n\s*name: '([a-z_]+)',\n/);
      for (let i = 1; i < parts.length; i += 2) if (readsCalls.test(parts[i + 1])) readers.add(parts[i]);
      if (file === 'custom.ts' && readsCalls.test(source)) readers.add('action_policy');
    }
    expect([...readers].sort()).toEqual(Object.keys(PAST_THE_LIST).sort());
    // And each built-in among them is a registered rule.
    const registered = new Set(builtInRules().map((r) => r.name));
    for (const name of Object.keys(PAST_THE_LIST)) if (name !== 'action_policy') expect(registered.has(name), name).toBe(true);
  });
});
