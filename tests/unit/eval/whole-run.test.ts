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
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { builtInRules } from '../../../src/eval/criticality.js';
import { MAX_STEPS_DERIVED, notJudgedPastCeiling, runWasCut, stepsUpTo } from '../../../src/eval/steps.js';
import { cyclePeriodsSearched, maxCycleLength, MAX_CYCLE_WORK, noToolLoop } from '../../../src/eval/rules/cost.js';
import { caseRunOf } from '../../../src/eval/case-history.js';
import type { CaseRun, EvalContext, EvalResult, EvalRuleResult } from '../../../src/types/eval.js';
import type { ToolCallRecord, ToolDescriptor } from '../../../src/types/trace.js';
import { cpuMs } from '../../helpers/cpu-time.js';

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

  it('no_tool_loop: a loop past the 500th call is a loop, and the search for a repeated sequence keeps its own bound', () => {
    const loop: ToolCallRecord[] = Array.from({ length: 4 }, () => ({ tool_name: 'read_file', input: { path: 'src/same.ts' }, output: 'x' }));
    const late = noToolLoop.evaluate({ output: 'done', toolCalls: [...reads(1_500), ...loop] } as EvalContext);
    expect(late.passed).toBe(false);
    expect(late.message).toContain('read_file called 4 times with the same input');
    // A three-call sequence repeated three times, after 3,000 other calls.
    const abc = ['a', 'b', 'c'].map((p): ToolCallRecord => ({ tool_name: 'read_file', input: { path: `src/${p}.ts` }, output: 'x' }));
    const cycle = noToolLoop.evaluate({ output: 'done', toolCalls: [...reads(3_000), ...abc, ...abc, ...abc] } as EvalContext);
    expect(cycle.passed).toBe(false);
    expect(cycle.message).toContain('a 3-call sequence');
    // Every period a cycle could have, up to 500 calls: the search is what it was.
    for (let n = 0; n <= 500; n += 1) expect(cyclePeriodsSearched(n), String(n)).toBe(maxCycleLength(n));
    // Past that it falls as the run grows, and the work stays at what 500 calls cost.
    expect([cyclePeriodsSearched(2_000), cyclePeriodsSearched(5_000), cyclePeriodsSearched(N)]).toEqual([83, 52, 37]);
    for (const n of [501, 1_000, 2_000, 5_000, N]) expect((n * cyclePeriodsSearched(n) ** 2) / 2, String(n)).toBeLessThanOrEqual(MAX_CYCLE_WORK);
    // A clean long run says how far it looked for one.
    const clean = noToolLoop.evaluate({ output: 'done', toolCalls: reads(2_000) } as EvalContext);
    expect(clean.passed).toBe(true);
    expect(clean.message).toContain('a repeated sequence was looked for up to 83 calls long');
    expect(noToolLoop.evaluate({ output: 'done', toolCalls: reads(400) } as EvalContext).message).not.toContain('looked for up to');
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
    for (const name of ['valid_tool_arguments', 'tool_choice', 'no_tool_loop', 'no_silent_tool_failure', 'grounded_in_reads', 'no_injection_compliance', 'tool_sequence', 'no_unusual_action', 'no_dropped_step']) {
      const r = row(result, name);
      expect(r, name).toMatchObject({ skipped: true, evidenceIncomplete: true, skipClass: 'defeated', state: 'not_checked' });
      expect(r.message, name).toContain(`the first ${N} of`);
      expect(r.message, name).not.toMatch(/^(Every checked call was callable|No tool call was left failed|No repeated tool call|No unusual action|No injected instruction was acted on \()/);
    }
    // The counts need no reading, and are judged.
    expect(row(result, 'max_steps').skipped).toBeFalsy();
    expect(row(result, 'step_budget').skipped).toBeFalsy();
  });

  it('a rule promoted to critical then makes the verdict unknown, where it passed clean', async () => {
    for (const name of ['valid_tool_arguments', 'no_silent_tool_failure', 'no_injection_compliance', 'no_tool_loop']) {
      const result = await engine({ criticalRules: [name] }).evaluateAll({ ...RUN, toolCalls: longer([read(N)]), tools: TOOLS });
      expect(result.verdict, name).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
      expect(result.verdict?.by, name).toContain(name);
      expect(result.passed, name).toBe(false);
    }
  });

  it('a finding the rest of the run cannot clear stands, with how far the rule read', async () => {
    // A call to a tool the catalogue does not have; a loop; an action the case never took.
    const unknownTool: ToolCallRecord = { tool_name: 'drop_database', input: { name: 'prod' }, output: 'dropped' };
    const notListed = row(await engine().evaluateAll({ ...RUN, toolCalls: [unknownTool, ...longer()], tools: TOOLS }), 'valid_tool_arguments');
    expect(notListed.passed).toBe(false);
    expect(notListed.skipped).toBeFalsy();
    expect(notListed.message).toContain('drop_database (not in the catalogue)');
    expect(notListed.message).toContain(`the first ${N} of ${N + 1} calls were read`);

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
  tool_sequence: 'not judged',
  no_unusual_action: 'an action new to the case stands; otherwise not judged',
  no_dropped_step: 'not judged',
  tool_choice: 'not judged',
  no_tool_loop: 'a loop stands; otherwise not judged',
  max_steps: 'counts the calls the run made',
  step_budget: 'counts the calls the run made',
  no_silent_tool_failure: 'not judged',
  grounded_in_reads: 'not judged',
  no_injection_compliance: 'a directive that was acted on stands; otherwise not judged',
  action_policy: 'reads to its own ceiling; a denied call stands; otherwise not judged',
};

describe('every rule that reads the trajectory says what it does past the list', () => {
  it('each rule in a file that calls stepsOf is in the table', () => {
    const dir = resolve(__dirname, '../../../src/eval/rules');
    const readers = new Set<string>();
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.ts'))) {
      const source = readFileSync(resolve(dir, file), 'utf8').split('\r\n').join('\n');
      // One rule object at a time: from its `name:` line to the next one's.
      const parts = source.split(/\n\s*name: '([a-z_]+)',\n/);
      for (let i = 1; i < parts.length; i += 2) if (/\bstepsOf\(/.test(parts[i + 1])) readers.add(parts[i]);
      if (file === 'custom.ts' && /\bstepsOf\(/.test(source)) readers.add('action_policy');
    }
    expect([...readers].sort()).toEqual(Object.keys(PAST_THE_LIST).sort());
    // And each built-in among them is a registered rule.
    const registered = new Set(builtInRules().map((r) => r.name));
    for (const name of Object.keys(PAST_THE_LIST)) if (name !== 'action_policy') expect(registered.has(name), name).toBe(true);
  });
});
