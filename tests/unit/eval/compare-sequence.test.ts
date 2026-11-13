/*
 * compareSequence, held to the comparison it replaces.
 *
 * An expected sequence was compared with a run by asking each expected call
 * of each call made, and reading both inputs again at every question: under
 * `exact` both were normalised again, under `subset` every string, number
 * and array was written out on both sides to be compared as text, and the
 * keys of the expected object were listed again. The comparison now keeps
 * what it has read. Under `exact` each input is normalised once. Under
 * `subset` nothing but an array is written out at all, and from the second
 * question an expected call puts, an array is written out once and the
 * expected input is read by a list of its keys, made once. Nothing is kept
 * for an expected call's first question: many are asked only once.
 *
 * The answers have to be the same ones, to the letter: the family for
 * tool_sequence is labelled against them, and a caller's gate reads them.
 * This file keeps the comparison as it was written, holds the two together
 * on generated runs in every mode, and counts what the new one reads.
 */
import { describe, expect, it } from 'vitest';
import { compareSequence, isSubset, SEQUENCE_MODES, writtenOnce, type SequenceOutcome } from '../../../src/eval/rules/expected-trajectory.js';
import { describeInput, normaliseInput, stableStringify } from '../../../src/eval/rules/trajectory.js';
import { toSteps } from '../../../src/eval/steps.js';
import type { ExpectedArgsMode, ExpectedToolCall, ExpectedTrajectoryMode } from '../../../src/types/eval.js';
import type { Step, ToolCallRecord } from '../../../src/types/trace.js';

/** isSubset as it was: every scalar and array written out and compared as text. */
function isSubsetAsWritten(want: unknown, have: unknown): boolean {
  if (want === null || typeof want !== 'object' || Array.isArray(want)) return stableStringify(want) === stableStringify(have);
  if (have === null || typeof have !== 'object' || Array.isArray(have)) return false;
  const h = have as Record<string, unknown>;
  return Object.entries(want as Record<string, unknown>).every(([k, v]) => v === undefined || (k in h && isSubsetAsWritten(v, h[k])));
}
function matchesAsWritten(step: Step, expected: ExpectedToolCall, args: ExpectedArgsMode): boolean {
  if (step.name !== expected.tool_name) return false;
  if (expected.input === undefined) return true;
  return args === 'exact' ? normaliseInput(step.input) === normaliseInput(expected.input) : isSubsetAsWritten(expected.input, step.input);
}
const describeAsWritten = (e: ExpectedToolCall): string => (e.input === undefined ? e.tool_name : `${e.tool_name}(${describeInput(e.input)})`);
function consumeAsWritten(expected: readonly ExpectedToolCall[], steps: readonly Step[], args: ExpectedArgsMode): { matchedExpected: Set<number>; matchedSteps: Set<number> } {
  const matchedExpected = new Set<number>();
  const matchedSteps = new Set<number>();
  const order = expected.map((_, i) => i).sort((a, b) => Number(expected[b].input !== undefined) - Number(expected[a].input !== undefined) || a - b);
  for (const i of order) {
    for (let j = 0; j < steps.length; j += 1) {
      if (matchedSteps.has(j)) continue;
      if (matchesAsWritten(steps[j], expected[i], args)) {
        matchedExpected.add(i);
        matchedSteps.add(j);
        break;
      }
    }
  }
  return { matchedExpected, matchedSteps };
}
/** compareSequence as it was through 0.21.0, word for word: each expected call asked of each step. */
function compareAsWritten(expected: readonly ExpectedToolCall[], steps: readonly Step[], mode: ExpectedTrajectoryMode, args: ExpectedArgsMode): SequenceOutcome {
  if (mode === 'strict') {
    const misplaced = expected.findIndex((e, k) => k >= steps.length || !matchesAsWritten(steps[k], e, args));
    const extra = steps.length > expected.length ? steps.slice(expected.length).map((s) => s.index) : [];
    const matched = expected.filter((e, k) => k < steps.length && matchesAsWritten(steps[k], e, args)).length;
    if (misplaced === -1 && extra.length === 0) return { passed: true, matched, why: '', unexpected: [], missing: [] };
    const why =
      misplaced === -1
        ? `${extra.length} call${extra.length === 1 ? '' : 's'} beyond the ${expected.length} expected (first: #${extra[0]} ${steps[extra[0]]?.name ?? ''})`
        : misplaced >= steps.length
          ? `expected call ${misplaced + 1} of ${expected.length}, ${describeAsWritten(expected[misplaced])}, never came (${steps.length} calls made)`
          : `call ${misplaced + 1} was ${steps[misplaced].name}, expected ${describeAsWritten(expected[misplaced])}`;
    return { passed: false, matched, why, unexpected: extra, missing: misplaced === -1 ? [] : [expected[misplaced]] };
  }
  if (mode === 'ordered_subset') {
    let i = 0;
    for (let j = 0; j < steps.length && i < expected.length; j += 1) if (matchesAsWritten(steps[j], expected[i], args)) i += 1;
    if (i === expected.length) return { passed: true, matched: i, why: '', unexpected: [], missing: [] };
    const present = consumeAsWritten(expected, steps, args).matchedExpected.has(i);
    return {
      passed: false,
      matched: i,
      why: present
        ? `expected call ${i + 1} of ${expected.length}, ${describeAsWritten(expected[i])}, came out of order (${i} of ${expected.length} in order)`
        : `expected call ${i + 1} of ${expected.length}, ${describeAsWritten(expected[i])}, never came (${i} of ${expected.length} in order)`,
      unexpected: [],
      missing: expected.slice(i),
    };
  }
  const { matchedExpected, matchedSteps } = consumeAsWritten(expected, steps, args);
  const missing = expected.filter((_, i) => !matchedExpected.has(i));
  const unexpectedSteps = steps.filter((_, j) => !matchedSteps.has(j));
  if (mode === 'subset') {
    const absent = expected.filter((e) => !steps.some((s) => matchesAsWritten(s, e, args)));
    return absent.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length - absent.length, why: `${absent.length} of ${expected.length} expected calls never came (first: ${describeAsWritten(absent[0])})`, unexpected: [], missing: absent };
  }
  if (mode === 'superset') {
    const outside = steps.filter((s) => !expected.some((e) => matchesAsWritten(s, e, args)));
    return outside.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length, why: `${outside.length} call${outside.length === 1 ? '' : 's'} outside the expected set (first: #${outside[0].index} ${outside[0].name})`, unexpected: outside.map((s) => s.index), missing: [] };
  }
  if (missing.length === 0 && unexpectedSteps.length === 0) return { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] };
  const why =
    missing.length > 0
      ? `${missing.length} of ${expected.length} expected calls never came (first: ${describeAsWritten(missing[0])})`
      : `${unexpectedSteps.length} call${unexpectedSteps.length === 1 ? '' : 's'} beyond the expected set (first: #${unexpectedSteps[0].index} ${unexpectedSteps[0].name})`;
  return { passed: false, matched: expected.length - missing.length, why, unexpected: unexpectedSteps.map((s) => s.index), missing };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

const TOOLS = ['read_file', 'search', 'send_invoice', 'bash'];
const VALUES: unknown[] = ['a.ts', 'b.ts', ' a.ts ', 1, 1.0, 0, -0, true, false, null, [1, 2], [2, 1], { deep: 'x' }, { deep: 'y' }, 'A.TS'];

describe('compareSequence — each input read once, the same answers', () => {
  it('gives the outcome the comparison as it was written gives, to the letter, on 6,000 generated runs in every mode and both ways of matching arguments', () => {
    let compared = 0;
    let passed = 0;
    for (let seed = 1; seed <= 6_000; seed += 1) {
      const next = rng(seed);
      const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
      const input = (): unknown => {
        const shape = next();
        if (shape < 0.15) return undefined;
        if (shape < 0.3) return pick(VALUES);
        const keys = ['path', 'query', 'n', 'opts'].filter(() => next() < 0.6);
        return Object.fromEntries(keys.map((k) => [k, pick(VALUES)]));
      };
      const calls = Array.from({ length: Math.floor(next() * 14) }, (): ToolCallRecord => ({ tool_name: pick(TOOLS), input: input() }));
      // Half of the expectations are drawn from the run itself, so that passes are as common as failures.
      const fromRun = next() < 0.5 && calls.length > 0;
      const expected = Array.from({ length: 1 + Math.floor(next() * 6) }, (): ExpectedToolCall => {
        if (fromRun) {
          const call = pick(calls);
          return next() < 0.5 ? { tool_name: call.tool_name } : { tool_name: call.tool_name, input: call.input };
        }
        return next() < 0.4 ? { tool_name: pick(TOOLS) } : { tool_name: pick(TOOLS), input: input() };
      });
      if (fromRun && next() < 0.5) expected.sort((a, b) => calls.findIndex((c) => c.tool_name === a.tool_name) - calls.findIndex((c) => c.tool_name === b.tool_name));
      const steps = toSteps({ toolCalls: calls });
      for (const mode of SEQUENCE_MODES) {
        for (const args of ['exact', 'subset'] as const) {
          const now = compareSequence(expected, steps, mode, args);
          const was = compareAsWritten(expected, steps, mode, args);
          // The whole outcome as text: pass or not, the count, the sentence, the steps left over, the expected calls missing.
          if (JSON.stringify(now) !== JSON.stringify(was)) expect(now, `seed ${seed}, ${mode}, ${args}`).toEqual(was);
          compared += 1;
          if (now.passed) passed += 1;
        }
      }
    }
    expect(compared).toBe(60_000);
    // The generator reaches both answers many times over.
    expect(passed).toBeGreaterThan(8_000);
    expect(compared - passed).toBeGreaterThan(20_000);
  }, 30_000);

  it('many expected calls of one tool against many calls of it: each expected call is given the call the old matching gave it', () => {
    // Where order decides: unordered gives each expected call a call of its own, and ordered_subset words its finding by whether one was left for it.
    let compared = 0;
    for (let seed = 1; seed <= 300; seed += 1) {
      const next = rng(seed * 7919);
      const variants = 1 + Math.floor(next() * 4);
      const input = (v: number, extra: boolean): Record<string, unknown> => ({ list: [v % 2, 'x'], opts: { deep: 1 }, v, ...(extra ? { more: true } : {}) });
      const expected = Array.from({ length: 5 + Math.floor(next() * 30) }, (): ExpectedToolCall => (next() < 0.2 ? { tool_name: 'x' } : { tool_name: next() < 0.9 ? 'x' : 'y', input: input(Math.floor(next() * variants), false) }));
      const calls = Array.from({ length: 5 + Math.floor(next() * 60) }, (): ToolCallRecord => ({ tool_name: next() < 0.9 ? 'x' : 'y', input: next() < 0.1 ? undefined : input(Math.floor(next() * (variants + 1)), next() < 0.3) }));
      const steps = toSteps({ toolCalls: calls });
      for (const mode of SEQUENCE_MODES) {
        for (const args of ['exact', 'subset'] as const) {
          const now = compareSequence(expected, steps, mode, args);
          const was = compareAsWritten(expected, steps, mode, args);
          if (JSON.stringify(now) !== JSON.stringify(was)) expect(now, `seed ${seed}, ${mode}, ${args}`).toEqual(was);
          compared += 1;
        }
      }
    }
    expect(compared).toBe(3_000);
  }, 30_000);

  it('isSubset compares two strings, two numbers and two booleans directly, and gives what writing them out gave', () => {
    const next = rng(31);
    const values: unknown[] = [...VALUES, '', '1', 'true', 'null', undefined, NaN, Infinity, -Infinity, 1e21, 0.1 + 0.2, 0.3, 'x'.repeat(400), { a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 3 }] } }, {}, []];
    for (let i = 0; i < 20_000; i += 1) {
      const want = values[Math.floor(next() * values.length)];
      const have = values[Math.floor(next() * values.length)];
      expect(isSubset(want, have), `${stableStringify(want)} in ${stableStringify(have)}`).toBe(isSubsetAsWritten(want, have));
    }
    for (const a of values) for (const b of values) expect(isSubset({ k: a, other: 1 }, { k: b, other: 1, more: 2 })).toBe(isSubsetAsWritten({ k: a, other: 1 }, { k: b, other: 1, more: 2 }));
  });

  /*
   * The answer an expected call's SECOND question gets, which is the one
   * that reads the expected input by its list and keeps what it writes out.
   * superset asks an expected call of every step of its tool, so the second
   * of two steps is its second question whatever the first answered, and
   * that step is outside the expected set exactly when the answer was no.
   */
  const secondAnswer = (want: unknown, have: unknown): boolean => {
    const steps = toSteps({ toolCalls: [{ tool_name: 't', input: 'the first question' }, { tool_name: 't', input: have }] });
    return !compareSequence([{ tool_name: 't', input: want }], steps, 'superset', 'subset').unexpected.includes(1);
  };

  it('with an array written out once and the keys of an expected input listed once, the answers are the ones reading both again each time gave', () => {
    const next = rng(47);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    const SCALARS: unknown[] = ['a.ts', '', 1, 0, -0, 2.5, true, false, null, undefined, NaN];
    const value = (depth: number): unknown => {
      const kind = depth > 2 ? 0 : Math.floor(next() * 4);
      if (kind === 1) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
      if (kind === 2) return Object.fromEntries(Array.from({ length: Math.floor(next() * 4) }, () => [pick(['a', 'b', 'c', 'toString']), value(depth + 1)]));
      return pick(SCALARS);
    };
    const written = writtenOnce();
    // The same values are asked again and again, as an expectation's are against every step.
    const pool = Array.from({ length: 150 }, () => value(0));
    let subsets = 0;
    let seconds = 0;
    for (let i = 0; i < 40_000; i += 1) {
      const want = pick(pool);
      const have = pick(pool);
      const answer = isSubsetAsWritten(want, have);
      if (answer) subsets += 1;
      const label = `${stableStringify(want)} in ${stableStringify(have)}`;
      expect(isSubset(want, have, written), label).toBe(answer);
      expect(isSubset(want, have), label).toBe(answer);
      // An expected call with no input asks nothing of a step's input, so there is no second question to compare.
      if (want !== undefined) {
        expect(secondAnswer(want, have), label).toBe(answer);
        seconds += 1;
      }
    }
    expect(subsets).toBeGreaterThan(500);
    expect(seconds).toBeGreaterThan(30_000);
    // A key the expectation inherits is not one it names, and a key set to undefined asks for nothing: read in place, or by the list.
    const inherited = Object.create({ path: 'a.ts' }) as Record<string, unknown>;
    inherited.mode = 'r';
    for (const ask of [(want: unknown, have: unknown) => isSubset(want, have), (want: unknown, have: unknown) => isSubset(want, have, written), secondAnswer]) {
      expect(ask(inherited, { mode: 'r' })).toBe(true);
      expect(isSubsetAsWritten(inherited, { mode: 'r' })).toBe(true);
      expect(ask({ path: undefined, mode: 'r' }, { mode: 'r' })).toBe(true);
      expect(ask({ path: undefined, mode: 'r' }, { mode: 'w' })).toBe(false);
      // A key the step holds with no value is a key it holds, and null is written as an absent value is. A key it does not hold at all is not.
      for (const nothing of [null, NaN]) {
        expect(ask({ a: nothing }, { a: undefined })).toBe(true);
        expect(isSubsetAsWritten({ a: nothing }, { a: undefined })).toBe(true);
        expect(ask({ a: nothing }, {})).toBe(false);
        expect(isSubsetAsWritten({ a: nothing }, {})).toBe(false);
      }
      // An expected object is a subset of no array, no string and no null, however it is read.
      for (const other of [[], [1], 'x', null, 7]) expect(ask({}, other)).toBe(false);
      expect(ask({}, { anything: 1 })).toBe(true);
    }
    // An array is equal only to an array of its length, which is settled before either is written out.
    expect(isSubset([1, 2], [1, 2, 3], written)).toBe(false);
    expect(isSubset([1, 2], '[1,2]', written)).toBe(false);
    expect(isSubset([1, [2, { a: null }]], [1, [2, { a: null }]], written)).toBe(true);
  });
});

/*
 * What one comparison reads. The answers above do not say how often an
 * input was read to reach them, and that is the whole of this change: these
 * count it. The comparison as it was written read an input once for every
 * question it was part of. This one keeps nothing for the first question an
 * expected call puts (many are asked once, and keeping costs something),
 * and from the second reads by what it kept.
 */
describe('compareSequence — what a comparison reads, and how often', () => {
  /** An input whose one key counts each time its value is read. */
  const counted = (value: unknown): { input: Record<string, unknown>; reads: () => number } => {
    let reads = 0;
    const input: Record<string, unknown> = {};
    Object.defineProperty(input, 'n', {
      enumerable: true,
      get: () => {
        reads += 1;
        return value;
      },
    });
    return { input, reads: () => reads };
  };
  /** An array that counts each time it is written out (stableStringify maps over it). */
  const countedArray = (items: unknown[]): { list: unknown[]; writes: () => number } => {
    let writes = 0;
    const list = [...items];
    Object.defineProperty(list, 'map', {
      enumerable: false,
      value: (fn: (item: unknown) => unknown) => {
        writes += 1;
        return Array.prototype.map.call(list, fn);
      },
    });
    return { list, writes: () => writes };
  };

  it('nothing but an array is written out: a string, a number, a boolean and null are unequal to a value of another kind by their kinds', () => {
    let writes = 0;
    const written = (value: unknown): string => {
      writes += 1;
      return stableStringify(value);
    };
    const long = 'x'.repeat(1_400);
    const others: unknown[] = [1, 0, true, false, null, undefined, NaN, { a: 1 }, {}, [long], [], 'y'.repeat(1_400)];
    for (const other of others) {
      expect(isSubset(long, other, written), stableStringify(other)).toBe(false);
      expect(isSubset(other, long, written), stableStringify(other)).toBe(false);
      expect(isSubset({ a: long }, { a: other }, written)).toBe(false);
    }
    expect(isSubset(long, 'x'.repeat(1_400), written)).toBe(true);
    expect(isSubset(null, undefined, written)).toBe(true);
    expect(isSubset(NaN, null, written)).toBe(true);
    expect(isSubset(7, 7, written)).toBe(true);
    expect(writes).toBe(0);
    // Two arrays of one length are what is written out, and an array against anything else is not.
    expect(isSubset([1, 2], [1, 3], written)).toBe(false);
    expect(writes).toBe(2);
    expect(isSubset([1, 2], [1, 2, 3], written)).toBe(false);
    expect(isSubset([1, 2], '[1,2]', written)).toBe(false);
    expect(writes).toBe(2);
    // Two empty arrays are equal without being written out: every empty array is written alike.
    expect(isSubset([], [], written)).toBe(true);
    expect(isSubset({ a: [], b: [[]] }, { a: [], b: [[]], c: 1 }, written)).toBe(true);
    expect(writes).toBe(4);
    expect(isSubset([], [[]], written)).toBe(false);
    expect(isSubset([], {}, written)).toBe(false);
    expect(isSubset([], null, written)).toBe(false);
    expect(writes).toBe(4);
  });

  it('under exact, each input is normalised once, however many questions it is part of', () => {
    // Four expected calls that only the last of six calls satisfies: each is asked of all six, twenty-four questions.
    const made = Array.from({ length: 6 }, (_, j) => counted(j));
    const asked = Array.from({ length: 4 }, () => counted(5));
    const steps = toSteps({ toolCalls: made.map((m): ToolCallRecord => ({ tool_name: 'apply', input: m.input })) });
    const expected = asked.map((a): ExpectedToolCall => ({ tool_name: 'apply', input: a.input }));
    const before = [...made, ...asked].map((c) => c.reads());
    expect(compareSequence(expected, steps, 'subset', 'exact').passed).toBe(true);
    expect([...made, ...asked].map((c, k) => c.reads() - before[k])).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
    // As it was written, an input was normalised at every question it was part of, and the questions were put twice: once to give each expected call a call of its own, which this mode never reads, and once for the mode.
    const again = [...made, ...asked].map((c) => c.reads());
    expect(compareAsWritten(expected, steps, 'subset', 'exact').passed).toBe(true);
    expect([...made, ...asked].map((c, k) => c.reads() - again[k])).toEqual([8, 8, 8, 8, 8, 5, 12, 11, 11, 11]);
  });

  it('under subset, an expected value is read for its first question and once more to be listed, however many questions follow', () => {
    const made = Array.from({ length: 6 }, (_, j): ToolCallRecord => ({ tool_name: 'apply', input: { n: j, other: true } }));
    const asked = Array.from({ length: 4 }, () => counted(5));
    const steps = toSteps({ toolCalls: made });
    const expected = asked.map((a): ExpectedToolCall => ({ tool_name: 'apply', input: a.input }));
    // Only the last call satisfies an expected call, so each is asked of five or six. Where the outcome fails naming an expected call (the second: the first took the one call that satisfies any), describing it reads its input once more.
    const READS: Array<[mode: ExpectedTrajectoryMode, passed: boolean, reads: number[]]> = [
      ['subset', true, [2, 2, 2, 2]],
      ['superset', false, [2, 2, 2, 2]],
      ['unordered', false, [2, 3, 2, 2]],
      ['ordered_subset', false, [2, 3, 2, 2]],
    ];
    for (const [mode, passed, reads] of READS) {
      const before = asked.map((c) => c.reads());
      const now = compareSequence(expected, steps, mode, 'subset');
      expect(now.passed, mode).toBe(passed);
      expect(asked.map((c, k) => c.reads() - before[k]), mode).toEqual(reads);
      // As it was written, an expected value was read at every question its call put.
      const then = asked.map((c) => c.reads());
      expect(JSON.stringify(compareAsWritten(expected, steps, mode, 'subset')), mode).toBe(JSON.stringify(now));
      expect(Math.min(...asked.map((c, k) => c.reads() - then[k])), mode).toBeGreaterThanOrEqual(5);
    }
  });

  it('an expected call asked once is read once: a run that made the expected calls in order', () => {
    // The expectation is the run. strict and ordered_subset ask each expected call of the call in its place; unordered gives each the first call not yet taken, which is its own.
    const made = Array.from({ length: 5 }, (_, j) => counted(j));
    const asked = Array.from({ length: 5 }, (_, j) => counted(j));
    const steps = toSteps({ toolCalls: made.map((m): ToolCallRecord => ({ tool_name: 'apply', input: m.input })) });
    const expected = asked.map((a): ExpectedToolCall => ({ tool_name: 'apply', input: a.input }));
    for (const mode of ['strict', 'ordered_subset', 'unordered'] as const) {
      for (const args of ['subset', 'exact'] as const) {
        const before = [...made, ...asked].map((c) => c.reads());
        expect(compareSequence(expected, steps, mode, args).passed, `${mode}, ${args}`).toBe(true);
        expect([...made, ...asked].map((c, k) => c.reads() - before[k]), `${mode}, ${args}`).toEqual([1, 1, 1, 1, 1, 1, 1, 1, 1, 1]);
      }
    }
    // As it was written, strict asked each pair twice: once to find the first call out of place, once to count the calls in theirs.
    const then = [...made, ...asked].map((c) => c.reads());
    expect(compareAsWritten(expected, steps, 'strict', 'subset').passed).toBe(true);
    expect([...made, ...asked].map((c, k) => c.reads() - then[k])).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
  });

  it('under subset, an array is written out for the first question of each expected call that reaches it, and once after that', () => {
    const made = Array.from({ length: 6 }, (_, j) => countedArray([j, 0]));
    const asked = Array.from({ length: 4 }, () => countedArray([5, 0]));
    const steps = toSteps({ toolCalls: made.map((m): ToolCallRecord => ({ tool_name: 'apply', input: { list: m.list } })) });
    const expected = asked.map((a): ExpectedToolCall => ({ tool_name: 'apply', input: { list: a.list } }));
    const before = [...made, ...asked].map((c) => c.writes());
    expect(compareSequence(expected, steps, 'subset', 'subset').passed).toBe(true);
    // Each of the four expected calls puts its first question to the first call: both arrays are written out as they stand, four times the first call's. From its second question an expected call's array is kept, and so is each later call's: once each.
    expect([...made, ...asked].map((c, k) => c.writes() - before[k])).toEqual([4, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
    const again = [...made, ...asked].map((c) => c.writes());
    // As it was written, both arrays were written out at every question.
    expect(compareAsWritten(expected, steps, 'subset', 'subset').passed).toBe(true);
    expect([...made, ...asked].map((c, k) => c.writes() - again[k])).toEqual([8, 8, 8, 8, 8, 5, 12, 11, 11, 11]);
    // The same against sixty calls, 240 questions: what is written does not grow with the questions.
    const many = Array.from({ length: 60 }, (_, j) => countedArray([j === 59 ? 5 : 100 + j, 0]));
    const manySteps = toSteps({ toolCalls: many.map((m): ToolCallRecord => ({ tool_name: 'apply', input: { list: m.list } })) });
    const start = [...many, ...asked].map((c) => c.writes());
    expect(compareSequence(expected, manySteps, 'subset', 'subset').passed).toBe(true);
    expect([...many, ...asked].map((c, k) => c.writes() - start[k])).toEqual([4, ...Array.from({ length: 59 }, () => 1), 2, 2, 2, 2]);
    // An array a level down, inside an object inside the input, is kept the same way; and so is an input that is itself an array, with no object around it.
    for (const wrap of [(list: unknown[]): unknown => ({ opts: { list } }), (list: unknown[]): unknown => list]) {
      const callsMade = Array.from({ length: 6 }, (_, j) => countedArray([j, 0]));
      const callsAsked = Array.from({ length: 4 }, () => countedArray([5, 0]));
      const wrappedSteps = toSteps({ toolCalls: callsMade.map((c): ToolCallRecord => ({ tool_name: 'apply', input: wrap(c.list) })) });
      const wrappedExpected = callsAsked.map((c): ExpectedToolCall => ({ tool_name: 'apply', input: wrap(c.list) }));
      expect(compareSequence(wrappedExpected, wrappedSteps, 'subset', 'subset').passed).toBe(true);
      expect([...callsMade, ...callsAsked].map((c) => c.writes())).toEqual([4, 1, 1, 1, 1, 1, 2, 2, 2, 2]);
    }
    // An array of another length is never written out: it is unequal by its length. (superset, whose finding names a call made and describes no expected input.)
    const short = countedArray([5]);
    const lengths = [...made].map((c) => c.writes());
    expect(compareSequence([{ tool_name: 'apply', input: { list: short.list } }], steps, 'superset', 'subset').why).toBe('6 calls outside the expected set (first: #0 apply)');
    expect(short.writes()).toBe(0);
    // Nor are the arrays of the calls it was compared with.
    expect(made.map((c, k) => c.writes() - lengths[k])).toEqual([0, 0, 0, 0, 0, 0]);
  });

  it('a value no request can carry: a BigInt still fails loudly where it is written out, and a hole in an array is a length', () => {
    // JSON has no writing for a BigInt, so nothing a caller sends holds one. Asked for, it throws as it always did.
    expect(() => isSubset(1n, 1n)).toThrow(TypeError);
    expect(() => isSubsetAsWritten(1n, 1n)).toThrow(TypeError);
    // Held by a step where a string was asked for, it is unequal by its kind; written out, it threw.
    expect(isSubset('1', 1n)).toBe(false);
    expect(() => isSubsetAsWritten('1', 1n)).toThrow(TypeError);
    // An array with one hole was written as an empty array is; it is an array of length one.
    expect(isSubset(new Array(1), [])).toBe(false);
    expect(isSubsetAsWritten(new Array(1), [])).toBe(true);
    // A function and a symbol are written as null is, and are still equal to it and to each other.
    const unwritten: unknown[] = [null, undefined, NaN, Symbol('s'), () => 1];
    for (const want of unwritten) {
      for (const have of unwritten) {
        expect(isSubset(want, have)).toBe(true);
        expect(isSubsetAsWritten(want, have)).toBe(true);
      }
      expect(isSubset(want, 'null')).toBe(false);
      expect(isSubset(want, 0)).toBe(false);
    }
  });
});
