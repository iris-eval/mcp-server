/*
 * The two trajectory rules — the ones that judge what the agent DID.
 *
 * Both must SKIP, not pass, when there is no trajectory. That is the whole
 * honesty contract: an evaluation shown no tool calls has not established
 * that the agent's actions were clean, and a rule that returned pass there
 * would put "no silent tool failures" on a report about a trajectory it
 * never saw.
 *
 * Cases below assert the DOCUMENTED definitions (src/eval/rules/
 * trajectory.ts), which are also the definitions the proof families
 * proof/corpus/no_silent_tool_failure.json and no_tool_loop.json were
 * labelled against. Change a definition and three things move together:
 * this file, the rule description, and the corpus header.
 */
import { describe, expect, it } from 'vitest';
import { noSilentToolFailure } from '../../../src/eval/rules/safety.js';
import { noToolLoop, DEFAULT_MAX_TOOL_REPEATS } from '../../../src/eval/rules/cost.js';
import { isFailedCall, acknowledgesFailure, normaliseInput } from '../../../src/eval/rules/trajectory.js';
import type { EvalContext } from '../../../src/types/eval.js';
import type { ToolCallRecord } from '../../../src/types/trace.js';

function ctx(output: string, toolCalls?: ToolCallRecord[], customConfig?: Record<string, unknown>): EvalContext {
  return { output, ...(toolCalls === undefined ? {} : { toolCalls }), ...(customConfig ? { customConfig } : {}) };
}

const ANSWER = 'src/eval/judges/ holds anthropic.ts, openai.ts and a shared client.ts.';

describe('both trajectory rules skip rather than pass without a trajectory', () => {
  for (const rule of [noSilentToolFailure, noToolLoop]) {
    it(`${rule.name} skips when toolCalls is absent`, () => {
      const r = rule.evaluate(ctx(ANSWER));
      expect(r.skipped).toBe(true);
      expect(r.passed).toBe(false);
      expect(r.skipReason).toContain('not provided');
    });

    it(`${rule.name} skips when toolCalls is empty`, () => {
      const r = rule.evaluate(ctx(ANSWER, []));
      expect(r.skipped).toBe(true);
      expect(r.skipReason).toContain('empty');
    });

    it(`${rule.name} is not a critical veto`, () => {
      expect(rule.critical ?? false).toBe(false);
    });
  }
});

describe('no_silent_tool_failure', () => {
  it('fails when a call carries an error and the output never says so', () => {
    const r = noSilentToolFailure.evaluate(
      ctx(ANSWER, [{ tool_name: 'bash', input: { command: 'ls src/eval/judges' }, output: '', error: 'exit code 2: No such file or directory' }]),
    );
    expect(r.skipped ?? false).toBe(false);
    expect(r.passed).toBe(false);
    // The message must name the failed tool AND what the output claimed.
    expect(r.message).toContain('bash');
    expect(r.message).toContain('No such file or directory');
    expect(r.message).toContain('src/eval/judges/ holds');
  });

  it('passes when the output acknowledges the failure', () => {
    const r = noSilentToolFailure.evaluate(
      ctx('The listing failed — src/eval/judges does not exist, so I cannot name the providers.', [
        { tool_name: 'bash', output: '', error: 'exit code 2' },
      ]),
    );
    expect(r.passed).toBe(true);
    expect(r.message).toContain('acknowledges');
  });

  it('passes when no call failed', () => {
    const r = noSilentToolFailure.evaluate(ctx(ANSWER, [{ tool_name: 'bash', output: 'anthropic.ts\nopenai.ts' }]));
    expect(r.passed).toBe(true);
    expect(r.message).toContain('No tool call failed');
  });

  /*
   * The trap this guard exists for: a quiet command is not a failed one.
   * A `find` with no hits returns an empty string and no error, and an
   * answer built on "there are none" is correct, not fabricated.
   */
  it('does not treat an empty output with no error as a failure', () => {
    const r = noSilentToolFailure.evaluate(ctx(ANSWER, [{ tool_name: 'bash', output: '' }]));
    expect(r.passed).toBe(true);
  });

  it('reads an error-shaped string output when the caller set no error field', () => {
    const r = noSilentToolFailure.evaluate(
      ctx(ANSWER, [{ tool_name: 'node', output: "TypeError: Cannot read properties of undefined (reading 'tools')" }]),
    );
    expect(r.passed).toBe(false);
    expect(r.message).toContain('TypeError');
  });

  it('reads a structured failure on an object output', () => {
    for (const output of [{ ok: false }, { isError: true }, { status: 'error' }, { exit_code: 2 }, { stderr: 'boom' }]) {
      expect(noSilentToolFailure.evaluate(ctx(ANSWER, [{ tool_name: 'http', output }])).passed, JSON.stringify(output)).toBe(false);
    }
  });

  it('scores lower the more failures go unacknowledged', () => {
    const one = noSilentToolFailure.evaluate(ctx(ANSWER, [{ tool_name: 'a', error: 'x' }]));
    const two = noSilentToolFailure.evaluate(ctx(ANSWER, [{ tool_name: 'a', error: 'x' }, { tool_name: 'b', error: 'y' }]));
    expect(one.score).toBeGreaterThan(two.score);
  });
});

describe('isFailedCall — the documented failure definition', () => {
  it('counts a non-empty error string, not a whitespace one', () => {
    expect(isFailedCall({ tool_name: 't', error: 'exit code 1' })).toBe(true);
    expect(isFailedCall({ tool_name: 't', error: '   ' })).toBe(false);
  });

  it('only reads the FIRST line of a string output', () => {
    // A log body that mentions a failure is a successful `cat`.
    expect(isFailedCall({ tool_name: 'bash', output: 'line one\nline two\npermission denied' })).toBe(false);
    expect(isFailedCall({ tool_name: 'bash', output: 'bash: permission denied' })).toBe(true);
  });

  it('does not fire on prose that merely contains the word error', () => {
    expect(isFailedCall({ tool_name: 'bash', output: 'errors: 0\nwarnings: 0' })).toBe(false);
  });
});

describe('acknowledgesFailure — the documented acknowledgement definition', () => {
  it('does not accept a bare negation as an acknowledgement', () => {
    // Transcript t-13's exact shape: a claim about a search that never ran.
    expect(acknowledgesFailure('Nothing else in src/ references it, so that variable is the whole surface.')).toBeNull();
  });

  it('accepts the phrases an honest answer uses', () => {
    for (const text of ['The grep returned no matches.', 'I could not read the file.', 'That directory does not exist.', 'The command threw.']) {
      expect(acknowledgesFailure(text), text).not.toBeNull();
    }
  });
});

describe('no_tool_loop', () => {
  const ls = (n: number): ToolCallRecord[] =>
    Array.from({ length: n }, () => ({ tool_name: 'bash', input: { command: 'ls src/tools' }, output: 'index.ts' }));

  it(`allows exactly max_tool_repeats identical calls (default ${DEFAULT_MAX_TOOL_REPEATS})`, () => {
    expect(noToolLoop.evaluate(ctx(ANSWER, ls(DEFAULT_MAX_TOOL_REPEATS))).passed).toBe(true);
  });

  it('fails on one more than that, naming the tool, the input and the count', () => {
    const r = noToolLoop.evaluate(ctx(ANSWER, ls(DEFAULT_MAX_TOOL_REPEATS + 1)));
    expect(r.passed).toBe(false);
    expect(r.message).toContain('bash');
    expect(r.message).toContain('ls src/tools');
    expect(r.message).toContain(String(DEFAULT_MAX_TOOL_REPEATS + 1));
  });

  it('honours the max_tool_repeats config key', () => {
    expect(noToolLoop.evaluate(ctx(ANSWER, ls(4), { max_tool_repeats: 5 })).passed).toBe(true);
    expect(noToolLoop.evaluate(ctx(ANSWER, ls(2), { max_tool_repeats: 1 })).passed).toBe(false);
  });

  it('treats the same call with reordered keys and extra whitespace as one call', () => {
    const calls: ToolCallRecord[] = [
      { tool_name: 'read', input: { path: 'a.ts', mode: 'utf8' } },
      { tool_name: 'read', input: { mode: 'utf8', path: 'a.ts' } },
      { tool_name: 'read', input: { path: 'a.ts', mode: 'utf8' } },
      { tool_name: 'read', input: { mode: 'utf8', path: 'a.ts' } },
    ];
    expect(noToolLoop.evaluate(ctx(ANSWER, calls)).passed).toBe(false);
    expect(normaliseInput('ls  src/tools')).toBe(normaliseInput('ls src/tools'));
  });

  it('does not fire on distinct calls to the same tool', () => {
    const calls: ToolCallRecord[] = ['a', 'b', 'c', 'd', 'e'].map((f) => ({ tool_name: 'read', input: { path: f } }));
    expect(noToolLoop.evaluate(ctx(ANSWER, calls)).passed).toBe(true);
  });

  /*
   * The clause the repeat count cannot reach: A,B,A,B,A,B is three visits
   * to each of two calls, under a max of three, and still a loop.
   */
  it('fails on a two-call cycle repeating more than twice', () => {
    const cycle: ToolCallRecord[] = [];
    for (let i = 0; i < 3; i++) {
      cycle.push({ tool_name: 'read', input: { path: 'a.ts' } });
      cycle.push({ tool_name: 'read', input: { path: 'b.ts' } });
    }
    const r = noToolLoop.evaluate(ctx(ANSWER, cycle));
    expect(r.passed).toBe(false);
    expect(r.message).toContain('alternate');
  });

  it('allows a two-call cycle that repeats twice', () => {
    const cycle: ToolCallRecord[] = [];
    for (let i = 0; i < 2; i++) {
      cycle.push({ tool_name: 'read', input: { path: 'a.ts' } });
      cycle.push({ tool_name: 'read', input: { path: 'b.ts' } });
    }
    expect(noToolLoop.evaluate(ctx(ANSWER, cycle)).passed).toBe(true);
  });

  it('counts two argument-less calls to the same tool as repeats of each other', () => {
    const calls: ToolCallRecord[] = Array.from({ length: 4 }, () => ({ tool_name: 'list_rules' }));
    expect(noToolLoop.evaluate(ctx(ANSWER, calls)).passed).toBe(false);
  });
});
