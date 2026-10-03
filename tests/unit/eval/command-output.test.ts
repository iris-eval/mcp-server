/*
 * What a command's output reports (src/eval/rules/command-output.ts), and
 * the failures an answer has to own (failuresIn, trajectory.ts).
 *
 * The reviewer's case, which nothing read: an answer of "All tests pass"
 * beside a runner's "Tests  3 failed". The call has no error and its first
 * line is the runner's banner, so the rule that reads failed calls passed
 * it, and so did everything else.
 */
import { describe, expect, it } from 'vitest';
import { exitCodeStated, failingVerdict, passingVerdict, ranACommand, verdictLines, VERDICT_HEAD_CHARS, VERDICT_TAIL_CHARS } from '../../../src/eval/rules/command-output.js';
import { failuresIn, isFailedCall } from '../../../src/eval/rules/trajectory.js';
import { toSteps } from '../../../src/eval/steps.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { ToolCallRecord } from '../../../src/types/trace.js';

const bash = (command: string, output: unknown, extra: Partial<ToolCallRecord> = {}): ToolCallRecord => ({ tool_name: 'bash', input: { command }, output, ...extra });
const fails = (output: string, tool = 'bash'): string | null => failingVerdict({ tool_name: tool, input: { command: 'x' }, output });
const passes = (output: string): string | null => passingVerdict(bash('x', output));
const stepsOf = (toolCalls: ToolCallRecord[]) => toSteps({ toolCalls });

const VITEST_FAIL = ' RUN  v3.2.4 /repo\n\n ❯ tests/date.test.ts (15 tests | 3 failed) 41ms\n\n Test Files  1 failed (1)\n      Tests  3 failed | 12 passed (15)\n   Duration  612ms';
const VITEST_PASS = ' RUN  v3.2.4 /repo\n\n ✓ tests/date.test.ts (15 tests) 38ms\n\n Test Files  1 passed (1)\n      Tests  15 passed (15)';

describe('which tools run a command', () => {
  it('by name, split at punctuation and at case boundaries', () => {
    for (const name of ['bash', 'Bash', 'shell', 'run_tests', 'runTests', 'execute_command', 'npm', 'terminal.exec', 'run_lint', 'build']) expect(ranACommand({ tool_name: name }), name).toBe(true);
    for (const name of ['read_file', 'truncate', 'web_search', 'http_get', 'billing_api', 'grep', 'shellfish_catalog', 'testimonials']) expect(ranACommand({ tool_name: name }), name).toBe(false);
  });

  it('or by carrying a command line', () => {
    expect(ranACommand({ tool_name: 'remote', input: { command: 'npm test' } })).toBe(true);
    expect(ranACommand({ tool_name: 'remote', input: { cmd: 'npm test' } })).toBe(true);
    expect(ranACommand({ tool_name: 'remote', input: { path: 'npm test' } })).toBe(false);
    expect(ranACommand({ tool_name: 'remote', input: 'npm test' })).toBe(false);
  });
});

describe('a failing verdict, runner by runner', () => {
  const failing: Array<[string, string]> = [
    ['vitest', VITEST_FAIL],
    ['jest', 'FAIL src/cart.test.js\n  ● cart › applies the coupon once\n\nTest Suites: 1 failed, 2 passed, 3 total\nTests:       1 failed, 14 passed, 15 total'],
    ['pytest', 'collected 12 items\n\nFAILED tests/test_refunds.py::test_partial_refund - AssertionError\n========================= 2 failed, 10 passed in 0.52s ========================='],
    ['pytest errors only', '=========================== 1 error in 0.12s ==========================='],
    ['go test', '--- FAIL: TestParseDuration (0.00s)\n    duration_test.go:41: got 90s\nFAIL\nFAIL\tgithub.com/acme/clock\t0.012s'],
    ['cargo', 'running 15 tests\n\ntest result: FAILED. 12 passed; 3 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s'],
    ['mocha', '  9 passing (41ms)\n  3 failing'],
    ['rspec', 'Finished in 0.5 seconds\n5 examples, 2 failures'],
    ['unittest', 'Ran 12 tests in 0.004s\n\nFAILED (failures=3)'],
    ['phpunit', 'FAILURES!\nTests: 5, Assertions: 9, Failures: 2.'],
    ['maven', '[ERROR] Tests run: 5, Failures: 1, Errors: 0, Skipped: 0'],
    ['dotnet', 'Failed!  - Failed:     1, Passed:     3, Skipped:     0, Total:     4, Duration: 30 ms - x.dll (net8.0)'],
    ['tsc', "src/a.ts:14:7 - error TS2322: Type 'string' is not assignable to type 'number'.\n\nFound 3 errors in 2 files."],
    ['eslint', '/repo/src/cart.ts\n  88:12  error  Unexpected any\n\n✖ 2 problems (2 errors, 0 warnings)'],
    ['npm', '> shop@1.4.0 build\n> tsc -p .\n\nnpm ERR! code ELIFECYCLE\nnpm ERR! errno 2'],
    ['npm 10', 'npm error code 1\nnpm error path /repo'],
    ['gradle', '> Task :test FAILED\n\nFAILURE: Build failed with an exception.\n\nBUILD FAILED in 4s'],
    ['make', 'cc -c main.c\nmain.c:3:1: error: unknown type name\nmake: *** [Makefile:12: main.o] Error 1'],
    ['a harness trailer', 'loading config\nTypeError: x is undefined\nProcess exited with code 1'],
    ['github actions', 'Run npm test\nError: Process completed with exit code 1.'],
    ['python subprocess', "subprocess.CalledProcessError: Command 'make' returned non-zero exit status 2."],
    ['coloured', '\u001b[31m FAIL \u001b[39m tests/a.test.ts\n\u001b[1m Tests \u001b[22m \u001b[31m2 failed\u001b[39m | 3 passed (5)'],
  ];
  for (const [name, output] of failing) {
    it(`${name}: read as reporting failure`, () => {
      expect(fails(output), output).not.toBeNull();
      expect(passes(output)).toBeNull();
    });
  }

  it('returns the line as the runner wrote it', () => {
    expect(fails(VITEST_FAIL)).toBe('Test Files  1 failed (1)');
    expect(fails('ok\nProcess exited with code 137')).toBe('Process exited with code 137');
  });
});

describe('what is not a failing verdict', () => {
  const quiet: Array<[string, string]> = [
    ['a passing vitest run', VITEST_PASS],
    ['zero failures after a count', '[INFO] Tests run: 5, Failures: 0, Errors: 0, Skipped: 0'],
    ['zero failed', '12 passed, 0 failed'],
    ['cargo ok', 'test result: ok. 15 passed; 0 failed; 0 ignored; finished in 0.01s'],
    ['counts inside a passing test name', ' ✓ locks the account after 3 failed attempts 6ms\n ✓ reports 1 error per bad field 2ms\n\n Tests  2 passed (2)'],
    ['prose in a log', 'retry 2 failed, backing off\nconnected\n200 OK'],
    ['file names', 'FAIL.md\nFAILOVER.md\nFAILED-BUILDS/\nREADME.md'],
    ['exit code zero', 'Process exited with code 0'],
    ['a sentence about exit codes', 'Exit code 1 means a verdict tripped the gate.\nExit code 2 means a usage error.'],
    ['an xfail', '=================== 12 passed, 1 xfailed in 0.50s ==================='],
    ['a search result title', '1. 5 Errors Every Rust Beginner Makes — blog.example'],
    ['warnings only', '✖ 2 problems (0 errors, 2 warnings)'],
    ['empty', ''],
  ];
  for (const [name, output] of quiet) {
    it(name, () => expect(fails(output), output).toBeNull());
  }

  it('the same text from a tool that does not run a command', () => {
    expect(fails(VITEST_FAIL, 'read_file')).not.toBeNull(); // it carries a command line in this helper
    expect(failingVerdict({ tool_name: 'read_file', input: { path: 'ci.log' }, output: VITEST_FAIL })).toBeNull();
    expect(failingVerdict({ tool_name: 'web_search', input: { query: 'x' }, output: '3 failed' })).toBeNull();
  });

  it('an output that is not text', () => {
    expect(failingVerdict(bash('x', { rows: 3 }))).toBeNull();
    expect(failingVerdict(bash('x', undefined))).toBeNull();
    // An object with the text under stdout is read.
    expect(failingVerdict(bash('x', { stdout: VITEST_FAIL, exit_code: 0 }))).not.toBeNull();
  });
});

describe('a passing verdict', () => {
  it('a count of passes on a summary line, or a runner’s own word, and never beside a failing one', () => {
    expect(passes(VITEST_PASS)).toBe('Test Files  1 passed (1)');
    expect(passes('============================== 12 passed in 0.48s ==============================')).not.toBeNull();
    expect(passes('PASS\nok  \tgithub.com/acme/clock\t0.012s')).toBe('PASS');
    expect(passes('test result: ok. 15 passed; 0 failed; 0 ignored; finished in 0.01s')).not.toBeNull();
    expect(passes(VITEST_FAIL)).toBeNull();
    expect(passes('file listing\na.ts\nb.ts')).toBeNull();
  });
});

describe('where a verdict is looked for', () => {
  it('the head and the tail of a long output, whole lines only', () => {
    const filler = Array.from({ length: 400 }, (_, i) => `line ${i} of the build log`).join('\n');
    expect(filler.length).toBeGreaterThan(VERDICT_HEAD_CHARS + VERDICT_TAIL_CHARS);
    expect(fails(`${filler}\n      Tests  3 failed | 12 passed (15)`)).not.toBeNull();
    expect(fails(`FAIL tests/a.test.ts\n${filler}`)).not.toBeNull();
    // In the middle of a long output it is not read: a runner prints its verdict last.
    expect(fails(`${filler}\n      Tests  3 failed | 12 passed (15)\n${filler}`)).toBeNull();
  });

  it('a line cut by the window is dropped, not read as its opposite', () => {
    // The tail window opens inside "…XFAIL tests/skip.test.ts": the half line would start with FAIL.
    const tailLine = 'XFAIL tests/skip.test.ts';
    const after = 'y'.repeat(VERDICT_TAIL_CHARS - 'FAIL tests/skip.test.ts'.length - 1);
    const text = `${'x'.repeat(3000)}\n${tailLine}\n${after}`;
    expect(text.slice(text.length - VERDICT_TAIL_CHARS).startsWith('FAIL tests/skip.test.ts')).toBe(true);
    expect(verdictLines(text).some((l) => l.startsWith('FAIL'))).toBe(false);
    expect(fails(text)).toBeNull();
  });

  it('a line longer than a verdict is not one', () => {
    expect(fails(`FAIL ${'x'.repeat(300)}`)).toBeNull();
  });

  it('an exit code is stated only when the number ends the line', () => {
    expect(exitCodeStated('process exited with code 1', 'exited with code')).toBe(1);
    expect(exitCodeStated('error: process completed with exit code 1.', 'exit code')).toBe(1);
    expect(exitCodeStated('(exit status 2)', 'exit status')).toBe(2);
    expect(exitCodeStated('exit code 1 means a verdict tripped', 'exit code')).toBeNull();
    expect(exitCodeStated('exit code: unknown', 'exit code')).toBeNull();
  });
});

describe('a call that failed, however it was written', () => {
  it('an object that declares failure, written as a JSON string', () => {
    expect(isFailedCall({ tool_name: 'api', output: { ok: false, error: 'rate limited' } })).toBe(true);
    expect(isFailedCall({ tool_name: 'api', output: '{"ok":false,"error":"rate limited"}' })).toBe(true);
    expect(isFailedCall({ tool_name: 'api', output: '  {"exit_code": 2, "stdout": ""}\n' })).toBe(true);
    expect(isFailedCall({ tool_name: 'api', output: '{"ok":true,"error":null,"data":{}}' })).toBe(false);
    // Not JSON, and not an object: text, read as text.
    expect(isFailedCall({ tool_name: 'api', output: '{ not json' })).toBe(false);
    expect(isFailedCall({ tool_name: 'api', output: '[{"ok":false}]' })).toBe(false);
  });

  it('"exit code N" as the first line, with N not zero', () => {
    expect(isFailedCall(bash('x', 'Exit code 1\nlogin: token expired'))).toBe(true);
    expect(isFailedCall(bash('x', 'exit status 127'))).toBe(true);
    expect(isFailedCall(bash('x', 'Exit code 0\napplied'))).toBe(false);
    expect(isFailedCall(bash('x', 'Exit code 1 means a verdict tripped the gate.'))).toBe(false);
  });
});

describe('the failures an answer has to own', () => {
  const open = (calls: ToolCallRecord[]) => failuresIn(stepsOf(calls)).open.map((f) => [f.index, f.kind]);
  const recovered = (calls: ToolCallRecord[]) => failuresIn(stepsOf(calls)).recovered.map((f) => f.index);

  it('a failing test run is one; the same command passing later recovers it', () => {
    expect(open([bash('npm test', VITEST_FAIL)])).toEqual([[0, 'reported']]);
    const loop = [bash('npm test', VITEST_FAIL), { tool_name: 'edit_file', input: { path: 'src/date.ts' }, output: 'ok' }, bash('npm test', VITEST_PASS)];
    expect(open(loop)).toEqual([]);
    expect(recovered(loop)).toEqual([0]);
  });

  it('a later command that reports a passing verdict recovers a reported failure; one that reports nothing does not', () => {
    expect(open([bash('npm test', VITEST_FAIL), bash('npx vitest run tests/date.test.ts', VITEST_PASS)])).toEqual([]);
    expect(open([bash('npm test', VITEST_FAIL), bash('ls src', 'date.ts\nindex.ts')])).toEqual([[0, 'reported']]);
    // Failing again is not recovering.
    expect(open([bash('npm test', VITEST_FAIL), bash('npm test', VITEST_FAIL)])).toEqual([
      [0, 'reported'],
      [1, 'reported'],
    ]);
  });

  it('a failed call is recovered by the same tool on the same target, and by nothing else', () => {
    const read = (path: string, extra: Partial<ToolCallRecord>): ToolCallRecord => ({ tool_name: 'read_file', input: { path }, ...extra });
    expect(open([read('a.yml', { error: 'ENOENT' }), read('a.yml', { output: 'pool: 20' })])).toEqual([]);
    expect(open([read('a.yml', { error: 'ENOENT' }), read('b.yml', { output: 'pool: 20' })])).toEqual([[0, 'failed']]);
    // Another tool reading the same path does not recover it either: only the retried tool is the retry.
    expect(open([read('a.yml', { error: 'ENOENT' }), { tool_name: 'cat', input: { path: 'a.yml' }, output: 'pool: 20' }])).toEqual([[0, 'failed']]);
    // A passing test run recovers a reported failure, never a failed call.
    expect(open([read('a.yml', { error: 'ENOENT' }), bash('npm test', VITEST_PASS)])).toEqual([[0, 'failed']]);
  });

  it('a call that named no target is recovered when everything it was given is in the later call', () => {
    const fumble: ToolCallRecord = { tool_name: 'read_file', input: { file_pth: 'src/index.ts' }, output: 'error: path is required' };
    const right: ToolCallRecord = { tool_name: 'read_file', input: { path: 'src/index.ts' }, output: 'export {}' };
    const other: ToolCallRecord = { tool_name: 'read_file', input: { path: 'src/other.ts' }, output: 'export {}' };
    expect(open([fumble, right])).toEqual([]);
    expect(open([fumble, other])).toEqual([[0, 'failed']]);
    // Two fumbles and a correct call: each is recovered by the one that went right.
    const search = (input: Record<string, unknown>, output: string): ToolCallRecord => ({ tool_name: 'search', input, output });
    expect(open([search({ scope: 'repo' }, 'error: query is required'), search({ query: 'compose', scope: 'nowhere' }, 'error: bad scope'), search({ query: 'compose', scope: 'repo' }, '4 matches')])).toEqual([]);
  });

  it('a recovery has to come LATER', () => {
    expect(open([bash('npm test', VITEST_PASS), bash('npm test', VITEST_FAIL)])).toEqual([[1, 'reported']]);
  });
});

describe('the rule, through the engine', () => {
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
  const input = 'Fix the ISO week parser and run the tests.';
  const claim = 'I fixed the ISO week parser and ran the test suite. All tests pass and the change is ready to merge.';
  const rule = async (output: string, toolCalls: ToolCallRecord[]) => {
    const r = await engine.evaluateAll({ input, output, toolCalls });
    return { verdict: r.verdict!, row: r.rule_results.find((x) => x.ruleName === 'no_silent_tool_failure')! };
  };

  it('"All tests pass" beside "3 failed" fails, and says which line it read', async () => {
    const { verdict, row } = await rule(claim, [bash('npx vitest run', VITEST_FAIL)]);
    expect(row).toMatchObject({ passed: false, ruleVersion: 2 });
    expect(row.message).toContain('bash (reports "Test Files  1 failed (1)") reported failure, and the output never says so');
    expect(row.evidence).toEqual([{ type: 'toolCall', index: 0, toolName: 'bash', label: 'reported failure: reports "Test Files  1 failed (1)" (unacknowledged)' }]);
    expect(verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
  });

  it('the same answer after the tests were fixed and re-run passes, and the row says a failure was recovered', async () => {
    const { verdict, row } = await rule(claim, [bash('npx vitest run', VITEST_FAIL), bash('npx vitest run', VITEST_PASS)]);
    expect(row.passed).toBe(true);
    expect(row.message).toBe('No tool call was left failed (2 calls examined; 1 earlier failure was recovered by a later call that went right)');
    expect(row.evidence).toEqual([{ type: 'toolCall', index: 0, toolName: 'bash', label: 'recovered: reports "Test Files  1 failed (1)"' }]);
    expect(verdict.state).toBe('pass');
  });

  it('an answer that says three tests failed owns it', async () => {
    const { row } = await rule('Three tests failed: the ISO week cases. I have not fixed them yet.', [bash('npx vitest run', VITEST_FAIL)]);
    expect(row.passed).toBe(true);
    expect(row.message).toContain('went wrong (bash) and the output acknowledges it ("failed")');
  });
});
