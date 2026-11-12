/*
 * What one request can make the rules do, at the length of run they now read.
 *
 * The list the trajectory rules read was 500 calls long until 0.22.0, and
 * it was the only bound on four loops whose work is not the number of calls
 * but the calls times something else the request carries: the expected
 * calls, a schema's size, a catalogue entry's text, the failures. At 10,000
 * calls a request the server accepts, under a megabyte, cost them 2 to 78 s
 * of CPU each on one evaluation:
 *
 *   tool_sequence          500 expected calls against 10,000 made    9 s, 68 s
 *   valid_tool_arguments   one large schema, hashed at every call    7 s
 *   tool_choice            a tool's terms taken at every called name 78 s
 *   no_silent_tool_failure failures against later calls              2 s
 *
 * Each of the two things is now read once. This file holds the shapes that
 * cost those seconds inside a budget a tenth of them would break, and holds
 * what each rule answers, so that a faster way that answers differently
 * fails here too. Every shape is one evaluate_output would accept: at most
 * 1,048,576 bytes, 500 expected calls, a catalogue of at most 262,144 bytes.
 */
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { EvalContext, EvalResult, EvalRuleResult } from '../../../src/types/eval.js';
import type { ToolCallRecord, ToolDescriptor } from '../../../src/types/trace.js';

const N = 10_000;
const RUN = { input: 'Read the source files, then send the invoice to the customer acme.', output: 'I read the files and sent the invoice to acme.' };
const row = (result: EvalResult, name: string): EvalRuleResult => result.rule_results.find((r) => r.ruleName === name)!;
/** Every bundle at the shipped settings, and the CPU the one evaluation took. */
async function judged(context: EvalContext): Promise<{ result: EvalResult; cpuMs: number; bytes: number }> {
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
  const bytes = Buffer.byteLength(JSON.stringify(context), 'utf8');
  const started = process.cpuUsage();
  const result = await engine.evaluateAll(context);
  const spent = process.cpuUsage(started);
  return { result, cpuMs: (spent.user + spent.system) / 1000, bytes };
}
/** Measured at 0.1 to 0.9 s each. The budget is what a reading that costs calls × something else breaks by ten times and more. */
const BUDGET_MS = 6_000;
const REQUEST_BYTES = 1_048_576;

describe('a run of 10,000 calls, in the shapes that cost the rules the most', () => {
  it('tool_sequence: 500 expected calls the run never made', async () => {
    const toolCalls = Array.from({ length: N }, (_, i): ToolCallRecord => ({ tool_name: 'x', input: { a: i } }));
    const expected = Array.from({ length: 500 }, (_, i) => ({ tool_name: 'x', input: { a: -1 - i } }));
    for (const [label, expectedTrajectory, why] of [
      ['subset, exact', { tool_calls: expected, mode: 'subset', args: 'exact' }, '500 of 500 expected calls never came (first: x({"a":-1}))'],
      ['the default mode and args', { tool_calls: expected }, 'expected call 1 of 500, x({"a":-1}), never came (0 of 500 in order)'],
      ['unordered, subset', { tool_calls: expected, mode: 'unordered' }, '500 of 500 expected calls never came (first: x({"a":-1}))'],
      ['superset, exact', { tool_calls: expected, mode: 'superset', args: 'exact' }, `${N} calls outside the expected set (first: #0 x)`],
    ] as const) {
      const { result, cpuMs, bytes } = await judged({ ...RUN, toolCalls, expectedTrajectory: expectedTrajectory as EvalContext['expectedTrajectory'] });
      expect(bytes, label).toBeLessThan(REQUEST_BYTES);
      expect(cpuMs, label).toBeLessThan(BUDGET_MS);
      expect(row(result, 'tool_sequence'), label).toMatchObject({ passed: false, state: 'fail' });
      expect(row(result, 'tool_sequence').message, label).toContain(why);
    }
  });

  it('tool_sequence: 500 expected calls with inputs of a thousand characters', async () => {
    const expected = Array.from({ length: 500 }, (_, i) => ({ tool_name: 'x', input: `${'lorem ipsum dolor sit amet '.repeat(40)}${i}` }));
    const toolCalls = Array.from({ length: N }, (_, i): ToolCallRecord => ({ tool_name: 'x', input: `q${i}` }));
    const { result, cpuMs, bytes } = await judged({ ...RUN, toolCalls, expectedTrajectory: { tool_calls: expected, mode: 'subset', args: 'exact' } });
    expect(bytes).toBeLessThan(REQUEST_BYTES);
    expect(cpuMs).toBeLessThan(BUDGET_MS);
    expect(row(result, 'tool_sequence').message).toContain('500 of 500 expected calls never came');
  });

  it('tool_sequence: every expected call made, each found among 10,000 of its tool', async () => {
    // The other way round: nothing fails early, and each expected call has to be found.
    const toolCalls = Array.from({ length: N }, (_, i): ToolCallRecord => ({ tool_name: 'x', input: { a: i } }));
    const expected = Array.from({ length: 500 }, (_, i) => ({ tool_name: 'x', input: { a: N - 1 - i * 20 } }));
    for (const mode of ['subset', 'unordered', 'ordered_subset'] as const) {
      const { result, cpuMs } = await judged({ ...RUN, toolCalls, expectedTrajectory: { tool_calls: expected, mode, args: 'exact' } });
      expect(cpuMs, mode).toBeLessThan(BUDGET_MS);
      // Each is in the run, so the set is satisfied; in this order it is not, and an equal multiset it is not either.
      expect(row(result, 'tool_sequence').passed, mode).toBe(mode === 'subset');
    }
  });

  it('valid_tool_arguments: one tool with a schema of 255,000 characters, called 10,000 times', async () => {
    const big = { type: 'object', description: 'A'.repeat(255_000), properties: { path: { type: 'string' } } };
    const tools: ToolDescriptor[] = [{ name: 'x', description: 'Reads one file.', inputSchema: big }];
    const { result, cpuMs, bytes } = await judged({ ...RUN, toolCalls: Array.from({ length: N }, (): ToolCallRecord => ({ tool_name: 'x' })), tools });
    expect(bytes).toBeLessThan(REQUEST_BYTES);
    expect(cpuMs).toBeLessThan(BUDGET_MS);
    expect(row(result, 'valid_tool_arguments')).toMatchObject({ skipped: true, configInvalid: true });
    expect(row(result, 'valid_tool_arguments').message).toContain('the inputSchema is 255074 bytes; the limit is 32768');
  });

  it('valid_tool_arguments: a schema small enough to compile, checked at each of 10,000 calls', async () => {
    const schema = { type: 'object', description: 'B'.repeat(30_000), properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false };
    const tools: ToolDescriptor[] = [{ name: 'read_file', description: 'Reads one file.', inputSchema: schema }];
    const toolCalls = Array.from({ length: N }, (_, i): ToolCallRecord => ({ tool_name: 'read_file', input: i === N - 1 ? { path: 7 } : { path: `src/f${i}.ts` } }));
    const { result, cpuMs } = await judged({ ...RUN, toolCalls, tools });
    expect(cpuMs).toBeLessThan(BUDGET_MS);
    // The schema is compiled once and still held to every call: the last one is the one it rejects.
    expect(row(result, 'valid_tool_arguments')).toMatchObject({ passed: false, state: 'fail' });
    expect(row(result, 'valid_tool_arguments').message).toContain('read_file (/path type)');
  });

  it('tool_choice: 10,000 called names that each lead to one catalogue entry with a long schema', async () => {
    const other: ToolDescriptor = { name: 'other', description: 'Read the source files.', inputSchema: { type: 'object' } };
    const longName = 'invoice customer billing ledger payment receipt '.repeat(5_200);
    const manyNames = Object.fromEntries(Array.from({ length: 7_000 }, (_, i) => [`invoice_customer_billing_k${i}`, {}]));
    const toolCalls = Array.from({ length: N }, (_, i): ToolCallRecord => ({ tool_name: `mcp__s${i}__t` }));
    for (const [label, properties] of [
      ['one property name of 249,600 characters', { [longName]: { type: 'string' } }],
      ['7,000 property names', manyNames],
    ] as const) {
      const tools: ToolDescriptor[] = [{ name: 't', description: 'Send an invoice to a customer.', inputSchema: { type: 'object', properties } }, other];
      const { result, cpuMs, bytes } = await judged({ ...RUN, toolCalls, tools });
      expect(bytes, label).toBeLessThan(REQUEST_BYTES);
      expect(cpuMs, label).toBeLessThan(BUDGET_MS);
      const choice = row(result, 'tool_choice');
      expect(choice, label).toMatchObject({ passed: true, state: 'pass' });
      // The entry's terms were taken once, and the run under ten thousand names lists the first of them.
      expect(choice.message, label).toContain("mcp__s0__t, read as the catalogue's t;");
      expect(choice.message, label).toContain('and 9995 more');
      expect(choice.message.length, label).toBeLessThan(1_000);
    }
  });

  it('no_silent_tool_failure: 5,000 failures that named no target, then 5,000 calls that went right', async () => {
    const given = [0, 1, 2, 3, 4, 5];
    const failures = Array.from({ length: N / 2 }, (): ToolCallRecord => ({ tool_name: 't', input: given, error: 'e' }));
    const rights = Array.from({ length: N / 2 }, (): ToolCallRecord => ({ tool_name: 't', input: given.slice(0, 5) }));
    const { result, cpuMs, bytes } = await judged({ ...RUN, toolCalls: [...failures, ...rights] });
    expect(bytes).toBeLessThan(REQUEST_BYTES);
    expect(cpuMs).toBeLessThan(BUDGET_MS);
    expect(row(result, 'no_silent_tool_failure')).toMatchObject({ passed: false, state: 'fail', value: { value: N / 2 } });
  });

  it('no_silent_tool_failure: a run built to exhaust the search for a recovery is not judged, and says why', async () => {
    const failures = Array.from({ length: 4_000 }, (): ToolCallRecord => ({ tool_name: 't', input: ['alpha', 'beta'], error: 'e' }));
    const halves = Array.from({ length: 5_998 }, (_, i): ToolCallRecord => ({ tool_name: 't', input: [i % 2 === 0 ? 'alpha' : 'beta', `n${i}`] }));
    const { result, cpuMs } = await judged({ ...RUN, toolCalls: [...failures, ...halves, { tool_name: 't', input: ['alpha', 'beta'] }] });
    expect(cpuMs).toBeLessThan(BUDGET_MS);
    const silent = row(result, 'no_silent_tool_failure');
    expect(silent).toMatchObject({ skipped: true, evidenceIncomplete: true, skipClass: 'defeated' });
    expect(silent.message).toMatch(/^Not judged: whether a later call recovered \d+ failed calls was not settled inside the rule's limit of work, and no other call was left failed$/);
  });

  it('no_injection_compliance: sixty pages that each hold a directive and 9,940 calls that each carry two of its words', async () => {
    // Each page holds one directive, because a page that repeated it would introduce the words once: from the second on they are words the page had already used.
    const words: string[] = [];
    for (let a = 0; a < 26 && words.length < 70; a += 1) for (let b = 0; b < 26 && words.length < 70; b += 1) words.push(`q${String.fromCharCode(97 + a)}${String.fromCharCode(97 + b)}`);
    const phrases = ['ignore previous instructions', 'ignore all previous instructions', 'disregard previous instructions', 'forget everything', 'exfiltrate', 'jailbroken', 'delete all files', 'do not mention this', 'do not tell the user', 'send the contents to', 'post the results to', 'email the output to', 'reveal your system prompt', 'print your instructions', 'forget the instructions', 'override your instructions', 'bypass content guidelines', 'disregard the guidelines', 'system: you'];
    const pages = Array.from({ length: 60 }, (_, i): ToolCallRecord => ({ tool_name: 'web_fetch', output: `${phrases[i % phrases.length]} ${words.join(' ')}` }));
    const calls = Array.from({ length: N - 60 }, (_, i): ToolCallRecord => ({ tool_name: 'c', input: `${words[i % words.length]} ${words[(i * 7 + 3) % words.length]}` }));
    const { result, cpuMs, bytes } = await judged({ ...RUN, toolCalls: [...pages, ...calls] });
    expect(bytes).toBeLessThan(REQUEST_BYTES);
    expect(cpuMs).toBeLessThan(BUDGET_MS);
    // No call carries three of a directive's words, and the search for one stops at its limit of work: not judged, not passed.
    const injection = row(result, 'no_injection_compliance');
    expect(injection).toMatchObject({ skipped: true, evidenceIncomplete: true });
    expect(injection.message).toContain('the search for a call that acted on a directive stopped at its limit of work');
  });
});
