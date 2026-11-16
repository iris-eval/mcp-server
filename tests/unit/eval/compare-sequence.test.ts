/*
 * compareSequence, held to the comparison it replaces.
 *
 * An expected sequence was compared with a run by asking each expected call
 * of each call made, and reading both inputs again at every question: under
 * `exact` both were normalised again, under `subset` every string, number
 * and array was written out on both sides to be compared as text, and the
 * keys of the expected object were listed again. Under `exact` an input is
 * now normalised twice at most (for the first question it is part of, and
 * once more to be kept). Under `subset` nothing is written out at all: two
 * values are compared as they stand, to the first place they differ.
 *
 * The answers have to be the same ones, to the letter: the family for
 * tool_sequence is labelled against them, and a caller's gate reads them.
 * This file keeps the comparison as it was written, holds the two together
 * on generated runs in every mode and on generated values, and counts what
 * the new one reads and writes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareSequence, isSubset, LEVELS_ON_THE_STACK, MAX_NESTED_COMPARED, SEQUENCE_MODES, writtenAlike, type SequenceOutcome } from '../../../src/eval/rules/expected-trajectory.js';
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

/** A value nested `depth` levels deep, built without a function that calls itself. */
function nest(depth: number, leaf: unknown, wrap: (inner: unknown, level: number) => unknown): unknown {
  let value = leaf;
  for (let level = depth; level >= 1; level -= 1) value = wrap(value, level);
  return value;
}
const inObjects = (inner: unknown): unknown => ({ a: inner });
const inArrays = (inner: unknown): unknown => [inner];

describe('compareSequence — the same answers', () => {
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
   * that reads the expected input by its list. superset asks an expected
   * call of every step of its tool, so the second of two steps is its second
   * question whatever the first answered, and that step is outside the
   * expected set exactly when the answer was no.
   */
  const secondAnswer = (want: unknown, have: unknown): boolean => {
    const steps = toSteps({ toolCalls: [{ tool_name: 't', input: 'the first question' }, { tool_name: 't', input: have }] });
    return !compareSequence([{ tool_name: 't', input: want }], steps, 'superset', 'subset').unexpected.includes(1);
  };

  it('on nested values asked again and again, read in place or by the list of an expected input\'s keys, the answers are the ones writing both out gave', () => {
    const next = rng(47);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    const SCALARS: unknown[] = ['a.ts', '', 1, 0, -0, 2.5, true, false, null, undefined, NaN];
    const value = (depth: number): unknown => {
      const kind = depth > 2 ? 0 : Math.floor(next() * 4);
      if (kind === 1) return Array.from({ length: Math.floor(next() * 4) }, () => value(depth + 1));
      if (kind === 2) return Object.fromEntries(Array.from({ length: Math.floor(next() * 4) }, () => [pick(['a', 'b', 'c', 'toString']), value(depth + 1)]));
      return pick(SCALARS);
    };
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
      expect(isSubset(want, have), label).toBe(answer);
      expect(writtenAlike(want, have), label).toBe(stableStringify(want) === stableStringify(have));
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
    for (const ask of [isSubset, secondAnswer]) {
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
      // A key the step only inherits is a key it holds, as it was: `constructor` is on every object.
      expect(ask({ constructor: null }, {})).toBe(isSubsetAsWritten({ constructor: null }, {}));
      expect(ask({ a: { constructor: null } }, { a: { other: 1 } })).toBe(isSubsetAsWritten({ a: { constructor: null } }, { a: { other: 1 } }));
    }
    // Inside an array two objects are equal, not one a subset of the other: an inherited key is not a key there.
    expect(writtenAlike([{ constructor: null }], [{ other: 1 }])).toBe(false);
    expect(stableStringify([{ constructor: null }]) === stableStringify([{ other: 1 }])).toBe(false);
    expect(isSubset([1, 2], [1, 2, 3])).toBe(false);
    expect(isSubset([1, 2], '[1,2]')).toBe(false);
    expect(isSubset([1, [2, { a: null }]], [1, [2, { a: null }]])).toBe(true);
    expect(isSubset([1, [2, { a: null }]], [1, [2, { a: null, b: 1 }]])).toBe(false);
    expect(isSubset({ list: [{ a: 1 }] }, { list: [{ a: 1, b: 2 }] })).toBe(false);
    expect(isSubset({ list: [{ a: 1, b: undefined }] }, { list: [{ a: 1 }] })).toBe(true);
  });

  it('writtenAlike is what comparing the two writings was, on values no request can carry as well as those one can', () => {
    const next = rng(101);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    const holed = (length: number, filled: number[]): unknown[] => {
      const list = new Array<unknown>(length);
      for (const i of filled) list[i] = i;
      return list;
    };
    const hidden = (): Record<string, unknown> => {
      const o: Record<string, unknown> = { a: 1 };
      Object.defineProperty(o, 'b', { value: 2, enumerable: false });
      return o;
    };
    const heir = Object.create({ a: 1 }) as Record<string, unknown>;
    heir.b = 2;
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: 1 });
    const named = Object.assign((): number => 1, { toJSON: (): unknown => 'a.ts' });
    const listed = Object.assign((): number => 1, { toJSON: (): unknown => [1, 2] });
    const symbol = Symbol('s');
    const plain = (): number => 1;
    // What JSON writes for each of these is not what its kind suggests, which is why they are here.
    const ODD: unknown[] = [
      undefined, NaN, Infinity, -Infinity, symbol, Symbol('t'), plain, named, listed,
      [], [undefined], [null], holed(1, []), holed(2, []), holed(2, [0]), holed(2, [1]), holed(3, [0, 2]), [0, undefined, 2], [0, null, 2], [undefined, 1], [null, 1],
      {}, { a: undefined }, { a: null }, { a: 1 }, { a: 1, b: undefined }, { a: 1, b: 2 }, { b: 2, a: 1 }, hidden(), heir, bare, { b: 2 },
      new Date(0), new Number(5), new String('ab'), { 0: 'a', 1: 'b' }, new Map([[1, 2]]), new Uint8Array([1, 2]), { 0: 1, 1: 2 }, [1, 2],
      'a.ts', '', 0, -0, 1, true, false, null, 'null', '[1,2]',
    ];
    const value = (depth: number): unknown => {
      const kind = depth > 1 ? 0 : Math.floor(next() * 3);
      if (kind === 1) return Array.from({ length: Math.floor(next() * 3) }, () => value(depth + 1));
      if (kind === 2) return Object.fromEntries(Array.from({ length: Math.floor(next() * 3) }, () => [pick(['a', 'b', 'constructor']), value(depth + 1)]));
      return pick(ODD);
    };
    const pool = [...ODD, ...Array.from({ length: 160 }, () => value(0))];
    let alike = 0;
    let unlike = 0;
    for (const a of pool) {
      for (const b of pool) {
        const asWritten = stableStringify(a) === stableStringify(b);
        if (writtenAlike(a, b) !== asWritten) expect(writtenAlike(a, b), `${stableStringify(a)} and ${stableStringify(b)}`).toBe(asWritten);
        if (isSubset(a, b) !== isSubsetAsWritten(a, b)) expect(isSubset(a, b), `${stableStringify(a)} in ${stableStringify(b)}`).toBe(isSubsetAsWritten(a, b));
        if (asWritten) alike += 1;
        else unlike += 1;
      }
    }
    expect(alike + unlike).toBe(pool.length * pool.length);
    // Many more pairs are written alike than a value and itself.
    expect(alike).toBeGreaterThan(pool.length * 4);
    expect(unlike).toBeGreaterThan(pool.length * 100);
    // A hole is written as nothing: an array of one hole is written as the empty array, and a hole is alike only to a hole.
    expect(writtenAlike(holed(1, []), [])).toBe(true);
    expect(writtenAlike([], holed(1, []))).toBe(true);
    expect(writtenAlike(holed(1, []), [undefined])).toBe(false);
    expect(writtenAlike(holed(2, []), [])).toBe(false);
    expect(writtenAlike(holed(3, [0, 2]), holed(3, [0, 2]))).toBe(true);
    expect(writtenAlike(holed(3, [0, 2]), [0, undefined, 2])).toBe(false);
    // A function is written by its toJSON when it has one, and as null when it has none.
    expect(writtenAlike(named, 'a.ts')).toBe(true);
    expect(writtenAlike([listed], [[1, 2]])).toBe(true);
    expect(writtenAlike(plain, null)).toBe(true);
    // A key an object does not list is not written, and a key it only inherits is not its own.
    expect(writtenAlike([hidden()], [{ a: 1 }])).toBe(true);
    expect(writtenAlike([{ a: 1, b: 2 }], [hidden()])).toBe(false);
    expect(writtenAlike([heir], [{ b: 2 }])).toBe(true);
    expect(writtenAlike([{ a: 1, b: 2 }], [heir])).toBe(false);
    // Two objects that name as many keys, where the one key they seem to share is one the second does not list, or lists with no value.
    const hiddenAndMore = Object.assign(hidden(), { c: 3 });
    for (const [a, b] of [
      [{ a: 1, b: 2 }, hiddenAndMore],
      [{ a: null }, { a: undefined, j: 5 }],
      [{ a: 1 }, { a: undefined, j: 1 }],
    ] as const) {
      expect(stableStringify([a]) === stableStringify([b])).toBe(false);
      expect(writtenAlike([a], [b])).toBe(false);
      expect(writtenAlike([b], [a])).toBe(false);
    }
    // An array inside an array is still an array there: an element that is undefined is written as null is.
    expect(writtenAlike([[undefined, 1]], [[null, 1]])).toBe(true);
    expect(stableStringify([[undefined, 1]]) === stableStringify([[null, 1]])).toBe(true);
    expect(writtenAlike([{ a: [undefined] }], [{ a: [null] }])).toBe(true);
  });

  it('a BigInt, which JSON has no writing for, still fails loudly where the comparison reaches it', () => {
    expect(() => isSubset(1n, 1n)).toThrow(TypeError);
    expect(() => isSubsetAsWritten(1n, 1n)).toThrow(TypeError);
    expect(() => isSubset('1', 1n)).toThrow(TypeError);
    expect(() => isSubsetAsWritten('1', 1n)).toThrow(TypeError);
    expect(() => isSubset({ n: 1n }, { n: 1n })).toThrow(TypeError);
    expect(() => isSubset([1, 2n], [1, 2n])).toThrow(TypeError);
    expect(() => isSubset([{ n: 1n }], [{ n: 1n }])).toThrow(TypeError);
    // By the list of an expected input's keys as well, and under more than a hundred levels.
    expect(() => secondAnswer({ n: 1n }, { n: 1n })).toThrow(TypeError);
    expect(() => isSubset(nest(LEVELS_ON_THE_STACK + 5, { n: 1n }, inObjects), nest(LEVELS_ON_THE_STACK + 5, { n: 1n }, inObjects))).toThrow(TypeError);
    // Two arrays that differ before the BigInt are unequal there. Written out, they could not be compared at all.
    expect(isSubset([1, 2n], [2, 2n])).toBe(false);
    expect(() => isSubsetAsWritten([1, 2n], [2, 2n])).toThrow(TypeError);
  });
});

describe('compareSequence — an input nested deeper than the stack holds', () => {
  /*
   * Written out, a value called a function once for each level, and a few
   * thousand levels ran the stack out: the rule gave no answer. Compared as
   * it stands, the levels past the first hundred wait on a list.
   */
  const DEPTH = 50_000;

  it('objects nested fifty thousand deep are compared, equal or not, to the bottom', () => {
    const deep = nest(DEPTH, 1, inObjects);
    expect(isSubset(deep, nest(DEPTH, 1, inObjects))).toBe(true);
    expect(isSubset(deep, nest(DEPTH, 2, inObjects))).toBe(false);
    expect(isSubset(deep, nest(DEPTH - 1, 1, inObjects))).toBe(false);
    expect(isSubset(nest(DEPTH - 1, 1, inObjects), deep)).toBe(false);
    // A subset at every level: the call holds a key more at each, and the expectation is still met.
    expect(isSubset(deep, nest(DEPTH, 1, (inner) => ({ a: inner, more: true })))).toBe(true);
    expect(isSubset(nest(DEPTH, 1, (inner) => ({ a: inner, more: true })), deep)).toBe(false);
    expect(() => stableStringify(deep)).toThrow(RangeError);
  });

  it('arrays nested fifty thousand deep, and objects inside arrays, are compared to the bottom', () => {
    const deep = nest(DEPTH, 1, inArrays);
    expect(isSubset(deep, nest(DEPTH, 1, inArrays))).toBe(true);
    expect(writtenAlike(deep, nest(DEPTH, 2, inArrays))).toBe(false);
    expect(writtenAlike(deep, nest(DEPTH - 1, 1, inArrays))).toBe(false);
    const mixed = (leaf: unknown, extra: boolean): unknown => nest(DEPTH, leaf, (inner, level) => (level % 2 === 0 ? [inner] : extra && level === DEPTH - 1 ? { a: inner, more: true } : { a: inner }));
    expect(isSubset({ list: mixed(1, false) }, { list: mixed(1, false) })).toBe(true);
    expect(isSubset({ list: mixed(1, false) }, { list: mixed(2, false) })).toBe(false);
    // Inside an array an object must be equal, not a subset: a key more at the bottom is a difference.
    expect(isSubset({ list: mixed(1, false) }, { list: mixed(1, true) })).toBe(false);
  });

  it('through the rule: an expected input fifty thousand levels deep is met by the same input, in every mode', () => {
    const steps = toSteps({ toolCalls: [{ tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }, { tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }] });
    for (const mode of SEQUENCE_MODES) {
      const outcome = compareSequence([{ tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }, { tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }], steps, mode, 'subset');
      expect(outcome.passed, mode).toBe(true);
    }
  });

  it('and where it is not met, the outcome fails and says so: the sentence names the call, and that its input is too deep to show', () => {
    // The comparison has its answer without writing anything out. The sentence would write the expected input out to show it, and cannot.
    const steps = toSteps({ toolCalls: [{ tool_name: 'apply', input: nest(DEPTH, 2, inObjects) }] });
    const expected: ExpectedToolCall[] = [{ tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }];
    const WHY: Array<[mode: ExpectedTrajectoryMode, why: string]> = [
      ['strict', 'call 1 was apply, expected apply(an input nested too deep to write out)'],
      ['ordered_subset', 'expected call 1 of 1, apply(an input nested too deep to write out), never came (0 of 1 in order)'],
      ['subset', '1 of 1 expected calls never came (first: apply(an input nested too deep to write out))'],
      ['unordered', '1 of 1 expected calls never came (first: apply(an input nested too deep to write out))'],
      ['superset', '1 call outside the expected set (first: #0 apply)'],
    ];
    for (const [mode, why] of WHY) {
      const outcome = compareSequence(expected, steps, mode, 'subset');
      expect(outcome.passed, mode).toBe(false);
      expect(outcome.why, mode).toBe(why);
    }
    // An input that can be written out is shown as it always was.
    const shallow = compareSequence([{ tool_name: 'apply', input: nest(3, 1, inObjects) }], toSteps({ toolCalls: [{ tool_name: 'apply', input: nest(3, 2, inObjects) }] }), 'subset', 'subset');
    expect(shallow.why).toBe('1 of 1 expected calls never came (first: apply({"a":{"a":{"a":1}}}))');
    // Only the depth is taken for what it is. A BigInt in an expected input the comparison did not have to reach still fails loudly when the sentence reaches it.
    expect(() => compareSequence([{ tool_name: 'apply', input: { a: 1, n: 1n } }], toSteps({ toolCalls: [{ tool_name: 'apply', input: { a: 2, n: 1n } }] }), 'subset', 'subset')).toThrow(TypeError);
    // Under exact both inputs are written out to be compared at all, and one this deep still cannot be.
    expect(() => compareSequence(expected, steps, 'subset', 'exact')).toThrow(RangeError);
  });

  it('the answers are the same on each side of the level where the list takes over', () => {
    // As it was written the comparison holds a few hundred levels with ease, so it is the reference here.
    const heir = (): unknown => {
      const o = Object.create({ path: 'a.ts' }) as Record<string, unknown>;
      o.mode = 'r';
      return o;
    };
    const shared = { n: 1, list: [1, { deep: true }] };
    // What stands at the bottom of each side, made afresh each time (but for the one both sides share): every way a key can be asked for, held, or missing.
    const BOTTOMS: Array<() => unknown> = [
      () => ({ leaf: 1, list: [1] }),
      () => ({ leaf: 1, list: [1], more: true }),
      () => ({ leaf: 2, list: [1] }),
      () => ({ leaf: 1, list: [2] }),
      () => ({ leaf: 1, list: [1, 2] }),
      () => ({ leaf: 1 }),
      () => ({ leaf: 1, list: undefined }),
      () => ({ leaf: null, list: [1] }),
      () => ({ leaf: undefined, list: [1] }),
      () => ({ list: [1] }),
      () => ({}),
      () => [1],
      () => [],
      () => null,
      () => 1,
      () => 'leaf',
      () => ({ constructor: null }),
      () => ({ toString: null, leaf: 1 }),
      heir,
      () => ({ mode: 'r' }),
      () => ({ path: 'a.ts', mode: 'r' }),
      () => shared,
      () => ({ n: 1, list: [1, { deep: true }] }),
      () => ({ n: 1, list: [1, { deep: true, more: 1 }] }),
      () => ({ deeper: { again: { leaf: 1 } } }),
      () => ({ deeper: { again: { leaf: 1, more: 1 } } }),
      () => ({ deeper: { again: { leaf: 2 } } }),
    ];
    let compared = 0;
    let subsets = 0;
    for (const depth of [LEVELS_ON_THE_STACK - 2, LEVELS_ON_THE_STACK - 1, LEVELS_ON_THE_STACK, LEVELS_ON_THE_STACK + 1, LEVELS_ON_THE_STACK + 2, LEVELS_ON_THE_STACK + 3, 3 * LEVELS_ON_THE_STACK]) {
      for (const [w, wantBottom] of BOTTOMS.entries()) {
        const want = nest(depth, wantBottom(), inObjects);
        for (const [h, haveBottom] of BOTTOMS.entries()) {
          const have = nest(depth, haveBottom(), inObjects);
          const answer = isSubsetAsWritten(want, have);
          if (isSubset(want, have) !== answer) expect(isSubset(want, have), `depth ${depth}: bottom ${w} in bottom ${h}`).toBe(answer);
          compared += 1;
          if (answer) subsets += 1;
        }
      }
      // And the levels themselves: one fewer, one more, and near where the list takes over a key renamed, a key more, an array in place of an object.
      const want = nest(depth, { leaf: 1, list: [1] }, inObjects);
      const others: unknown[] = [
        nest(depth - 1, { leaf: 1, list: [1] }, inObjects),
        nest(depth + 1, { leaf: 1, list: [1] }, inObjects),
        ...[-2, -1, 0, 1, 2].map((offset) => nest(depth, { leaf: 1, list: [1] }, (inner, level) => (level === LEVELS_ON_THE_STACK + offset ? { b: inner } : { a: inner }))),
        ...[-2, -1, 0, 1, 2].map((offset) => nest(depth, { leaf: 1, list: [1] }, (inner, level) => (level === LEVELS_ON_THE_STACK + offset ? { a: inner, more: 1 } : { a: inner }))),
        ...[-2, -1, 0, 1, 2].map((offset) => nest(depth, { leaf: 1, list: [1] }, (inner, level) => (level === LEVELS_ON_THE_STACK + offset ? [inner] : { a: inner }))),
        ...[-2, -1, 0, 1, 2].map((offset) => nest(depth, { leaf: 1, list: [1] }, (inner, level) => (level === LEVELS_ON_THE_STACK + offset ? { a: inner, gone: undefined } : { a: inner }))),
      ];
      for (const [n, have] of others.entries()) {
        expect(isSubset(want, have), `depth ${depth}, level variant ${n}`).toBe(isSubsetAsWritten(want, have));
        expect(isSubset(have, want), `depth ${depth}, level variant ${n}, the other way`).toBe(isSubsetAsWritten(have, want));
        compared += 2;
      }
    }
    expect(compared).toBe(7 * (BOTTOMS.length * BOTTOMS.length + 44));
    // Both answers many times over, at every depth.
    expect(subsets).toBeGreaterThan(7 * 60);
    expect(compared - subsets).toBeGreaterThan(7 * 400);
  });

  it('a value that holds itself is not compared for ever: the comparison stops and says why', () => {
    const selfHeld = (): Record<string, unknown> => {
      const o: Record<string, unknown> = { n: 1 };
      o.self = o;
      return o;
    };
    const a = selfHeld();
    const thrownBy = (run: () => unknown): unknown => {
      try {
        run();
      } catch (error) {
        return error;
      }
      return undefined;
    };
    // Written out, it ran the stack out.
    expect(() => stableStringify(a)).toThrow(RangeError);
    const stopped = thrownBy(() => isSubset(a, selfHeld()));
    expect(stopped).toBeInstanceOf(RangeError);
    expect((stopped as RangeError).message).toContain(`more than ${MAX_NESTED_COMPARED} objects and arrays`);
    const loop: unknown[] = [];
    loop.push(loop);
    const other: unknown[] = [];
    other.push(other);
    expect(thrownBy(() => writtenAlike(loop, other))).toBeInstanceOf(RangeError);
    expect(thrownBy(() => writtenAlike([a], [selfHeld()]))).toBeInstanceOf(RangeError);
    // Against a value that does not hold itself it differs somewhere, and that is found.
    expect(isSubset(a, { n: 1, self: { n: 1, self: { n: 2 } } })).toBe(false);
    expect(writtenAlike(loop, [[[1]]])).toBe(false);
    // And the very same value is not walked at all.
    expect(isSubset(a, a)).toBe(true);
    expect(isSubset({ held: a }, { held: a })).toBe(true);
    expect(writtenAlike(loop, loop)).toBe(true);
    expect(writtenAlike([a, loop], [a, loop])).toBe(true);
  }, 60_000);
});

/*
 * What one comparison reads and writes. The answers above do not say how
 * often an input was read to reach them, nor whether it was written out,
 * and that is the whole of this change: these count it.
 */
describe('compareSequence — what a comparison reads and writes', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

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
  /** An array whose elements count each time one is read. */
  const countedList = (items: unknown[]): { list: unknown[]; reads: () => number } => {
    let reads = 0;
    const list: unknown[] = [];
    list.length = items.length;
    items.forEach((item, i) => {
      Object.defineProperty(list, i, {
        enumerable: true,
        configurable: true,
        get: () => {
          reads += 1;
          return item;
        },
      });
    });
    return { list, reads: () => reads };
  };
  /** What `run` returns, and how many values were written out while it ran: every string, number and key written passes through JSON.stringify. */
  const written = <T,>(run: () => T): { value: T; writes: number } => {
    const spy = vi.spyOn(JSON, 'stringify');
    try {
      const value = run();
      return { value, writes: spy.mock.calls.length };
    } finally {
      spy.mockRestore();
    }
  };

  it('under subset, nothing is written out to compare two inputs, whatever they hold and however many questions are put', () => {
    const input = (v: number): Record<string, unknown> => ({ path: `src/file_${v}.ts`, flags: ['-n', v], opts: { globs: ['*.ts'], depth: v, deep: { list: [{ id: v }] } }, n: v });
    const calls = Array.from({ length: 40 }, (_, j): ToolCallRecord => ({ tool_name: 'grep', input: input(j) }));
    const steps = toSteps({ toolCalls: calls });
    const expected = Array.from({ length: 40 }, (_, i): ExpectedToolCall => ({ tool_name: 'grep', input: input(39 - i) }));
    // Every expected call is made, in the reverse order: each is asked of many calls before the one that is its own.
    for (const mode of ['subset', 'superset', 'unordered'] as const) {
      const now = written(() => compareSequence(expected, steps, mode, 'subset'));
      expect(now.value.passed, mode).toBe(true);
      expect(now.writes, mode).toBe(0);
      // As it was written, the same comparison wrote thousands of values out.
      expect(written(() => compareAsWritten(expected, steps, mode, 'subset')).writes, mode).toBeGreaterThan(2_000);
    }
    // Where the outcome fails, the sentence that says why describes one expected input, and that is all that is written: as much for thirty-nine calls as for four.
    const failing = (count: number): number => {
      const now = written(() => compareSequence(expected, toSteps({ toolCalls: calls.slice(1, 1 + count) }), 'ordered_subset', 'subset'));
      expect(now.value.passed, `${count} calls`).toBe(false);
      return now.writes;
    };
    expect(failing(39)).toBe(failing(4));
    expect(failing(39)).toBeLessThan(40);
    // isSubset itself, on values of every kind.
    const long = 'x'.repeat(1_400);
    const others: unknown[] = [1, 0, true, false, null, undefined, NaN, { a: 1 }, {}, [long], [], 'y'.repeat(1_400), [[1, 2], { a: [3] }]];
    const pairs = written(() => {
      let asked = 0;
      for (const a of [long, ...others]) {
        for (const b of [long, ...others]) {
          isSubset(a, b);
          asked += 1;
        }
      }
      return asked;
    });
    expect(pairs.value).toBe(196);
    expect(pairs.writes).toBe(0);
  });

  it('one call whose input holds a very large array, asked by five hundred expected calls: the array is neither written out nor read through', () => {
    // The request the comparison used to be dearest on: every expected call's question wrote the whole array out.
    const big = countedList(Array.from({ length: 5_000 }, (_, n) => ({ b: n, a: n })));
    const steps = toSteps({ toolCalls: [{ tool_name: 't', input: [big.list] }] });
    const expected = Array.from({ length: 500 }, (): ExpectedToolCall => ({ tool_name: 't', input: [0] }));
    for (const mode of ['subset', 'ordered_subset', 'unordered', 'superset'] as const) {
      const before = big.reads();
      const now = written(() => compareSequence(expected, steps, mode, 'subset'));
      expect(now.value.passed, mode).toBe(false);
      // An expected input of one number is unequal to an array by its kind: no element of the array is read.
      expect(big.reads() - before, mode).toBe(0);
      // What is written is the sentence's: the expected input it names, or nothing at all.
      expect(now.writes, mode).toBeLessThan(10);
    }
    // An expected array of the same length that differs in its first element is answered at that element, each time it is asked.
    const sameLength = Array.from({ length: 5_000 }, (_, n) => ({ b: n === 0 ? -1 : n, a: n }));
    const before = big.reads();
    expect(isSubset([sameLength], [big.list])).toBe(false);
    // Every element is read once to be taken up with its partner, and the pair that differs settles it: none is read twice.
    expect(big.reads() - before).toBe(5_000);
    // An expected array of another length is unequal by its length: nothing is read.
    const again = big.reads();
    expect(isSubset([[{ b: 0, a: 0 }]], [big.list])).toBe(false);
    expect(big.reads() - again).toBe(0);
  });

  it('under exact, an input is normalised for the first question it is part of and once more to be kept, however many questions follow', () => {
    // Four expected calls that only the last of six calls satisfies: each is asked of all six, twenty-four questions.
    const made = Array.from({ length: 6 }, (_, j) => counted(j));
    const asked = Array.from({ length: 4 }, () => counted(5));
    const steps = toSteps({ toolCalls: made.map((m): ToolCallRecord => ({ tool_name: 'apply', input: m.input })) });
    const expected = asked.map((a): ExpectedToolCall => ({ tool_name: 'apply', input: a.input }));
    const before = [...made, ...asked].map((c) => c.reads());
    expect(compareSequence(expected, steps, 'subset', 'exact').passed).toBe(true);
    expect([...made, ...asked].map((c, k) => c.reads() - before[k])).toEqual([2, 2, 2, 2, 2, 2, 2, 2, 2, 2]);
    // The same against sixty calls, 240 questions: what is read does not grow with the questions.
    const many = Array.from({ length: 60 }, (_, j) => counted(j === 59 ? 5 : 100 + j));
    const manySteps = toSteps({ toolCalls: many.map((m): ToolCallRecord => ({ tool_name: 'apply', input: m.input })) });
    const start = [...many, ...asked].map((c) => c.reads());
    expect(compareSequence(expected, manySteps, 'subset', 'exact').passed).toBe(true);
    // The four expected calls were kept by the comparison above only: this is a new one, and each is read twice again.
    expect([...many, ...asked].map((c, k) => c.reads() - start[k])).toEqual(Array.from({ length: 64 }, () => 2));
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

  it('under subset, an expected object asked of calls that hold no object is answered by their kind: its keys are neither read nor listed', () => {
    // A string, a number, an array, null, and no input at all: none can hold what an expected object asks for.
    const others: unknown[] = ['src/file.ts', 7, [1, 2], null, undefined];
    for (const other of others) {
      const asked = counted(5);
      // Three calls of the tool, so the expected call puts a first question, a second and a third.
      const steps = toSteps({ toolCalls: [0, 1, 2].map((): ToolCallRecord => (other === undefined ? { tool_name: 'apply' } : { tool_name: 'apply', input: other })) });
      const outcome = compareSequence([{ tool_name: 'apply', input: asked.input }], steps, 'superset', 'subset');
      expect(outcome.unexpected, String(other)).toEqual([0, 1, 2]);
      expect(asked.reads(), String(other)).toBe(0);
    }
    // When a call that holds an object comes, however late, the keys are listed then, once, and the answer is the one reading them in place gives.
    const asked = counted(5);
    const calls: ToolCallRecord[] = [{ tool_name: 'apply', input: 'a string' }, { tool_name: 'apply', input: [5] }, { tool_name: 'apply', input: { n: 5 } }, { tool_name: 'apply', input: { n: 6 } }, { tool_name: 'apply', input: { n: 5, more: true } }];
    const outcome = compareSequence([{ tool_name: 'apply', input: asked.input }], toSteps({ toolCalls: calls }), 'superset', 'subset');
    expect(outcome.unexpected).toEqual([0, 1, 3]);
    expect(asked.reads()).toBe(1);
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

  it('a call that differs from the expected one in its first key is answered at that key: the keys after it are not read', () => {
    // Ten keys, each holding an object. The first differs; each of the other nine counts when it is read.
    const guarded = (first: number): { input: Record<string, unknown>; reads: () => number } => {
      let reads = 0;
      const input: Record<string, unknown> = { k0: { v: first, list: [first] } };
      for (let k = 1; k < 10; k += 1) {
        Object.defineProperty(input, `k${k}`, {
          enumerable: true,
          get: () => {
            reads += 1;
            return { v: k, list: [k] };
          },
        });
      }
      return { input, reads: () => reads };
    };
    const want = guarded(1);
    const have = guarded(2);
    expect(isSubset(want.input, have.input)).toBe(false);
    expect([want.reads(), have.reads()]).toEqual([0, 0]);
    // Where they agree in the first key, every key is read, once.
    const same = guarded(1);
    expect(isSubset(want.input, same.input)).toBe(true);
    expect([want.reads(), same.reads()]).toEqual([9, 9]);
    // Asked through the rule a second time, the expected input is read by its list (made once, which reads its nine keys), and the call still stops at its first key.
    const expected = guarded(1);
    const calls = [guarded(2), guarded(3), guarded(4)];
    const steps = toSteps({ toolCalls: calls.map((c): ToolCallRecord => ({ tool_name: 'apply', input: c.input })) });
    expect(compareSequence([{ tool_name: 'apply', input: expected.input }], steps, 'superset', 'subset').unexpected).toEqual([0, 1, 2]);
    expect(expected.reads()).toBe(9);
    expect(calls.map((c) => c.reads())).toEqual([0, 0, 0]);
    // The same a level down: inside an object under a key, a difference under its first key is answered there, and the key after it is not read.
    let later = 0;
    const inside = (first: number): Record<string, unknown> => {
      const o: Record<string, unknown> = { first: { v: first } };
      Object.defineProperty(o, 'later', {
        enumerable: true,
        get: () => {
          later += 1;
          return { v: 0 };
        },
      });
      return o;
    };
    expect(isSubset({ opts: inside(1) }, { opts: inside(2) })).toBe(false);
    expect(later).toBe(0);
    expect(isSubset({ opts: inside(1) }, { opts: inside(1) })).toBe(true);
    expect(later).toBe(2);
  });

  it('the very same value, held by the expectation and by the call, is not read at all', () => {
    const shared = counted(5);
    const listed = countedList([1, 2, 3]);
    expect(isSubset({ opts: shared.input, list: listed.list, n: 1 }, { opts: shared.input, list: listed.list, n: 1, more: true })).toBe(true);
    expect(writtenAlike([shared.input, listed.list], [shared.input, listed.list])).toBe(true);
    expect([shared.reads(), listed.reads()]).toEqual([0, 0]);
    // Two that are equal and not the same one are read through.
    const twin = counted(5);
    expect(isSubset({ opts: shared.input }, { opts: twin.input })).toBe(true);
    expect([shared.reads(), twin.reads()]).toEqual([1, 1]);
    // By the list of an expected input's keys as well: the second question of an expected call.
    const steps = toSteps({ toolCalls: [{ tool_name: 't', input: 'the first question' }, { tool_name: 't', input: { opts: shared.input } }] });
    const before = shared.reads();
    expect(compareSequence([{ tool_name: 't', input: { opts: shared.input } }], steps, 'superset', 'subset').unexpected).toEqual([0]);
    expect(shared.reads() - before).toBe(0);
    // And under more levels than the comparison calls itself for, where the objects wait on a list.
    const deep = counted(7);
    const under = (): unknown => nest(LEVELS_ON_THE_STACK + 5, { held: deep.input, n: 1 }, inObjects);
    expect(isSubset(under(), under())).toBe(true);
    expect(deep.reads()).toBe(0);
    const twinBelow = counted(7);
    expect(isSubset(under(), nest(LEVELS_ON_THE_STACK + 5, { held: twinBelow.input, n: 1 }, inObjects))).toBe(true);
    expect([deep.reads(), twinBelow.reads()]).toEqual([1, 1]);
  });
});
