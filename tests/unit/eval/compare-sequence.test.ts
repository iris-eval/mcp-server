/*
 * compareSequence, held to the comparison it replaces.
 *
 * An expected sequence was compared with a run by asking each expected call
 * of each call made, and reading both inputs again at every question: under
 * `exact` both were normalised again, under `subset` every string, number
 * and array was written out on both sides to be compared as text, and the
 * keys of the expected object were listed again. Under `exact` an input is
 * now normalised twice at most (for the first question it is part of, and
 * once more to be kept). Under `subset` nothing a request can carry is
 * written out: two values are compared as they stand, to the first place
 * they differ. An object is read as it always was: an expected object's
 * keys and values are listed, and the call's object is asked whether it
 * holds each key and then for the value.
 *
 * The answers have to be the same ones, to the letter: the family for
 * tool_sequence is labelled against them, and a caller's gate reads them.
 * This file keeps the comparison as it was written, holds the two together
 * on generated runs in every mode and on generated values, and counts what
 * the new one reads, asks and writes.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareSequence, DESCRIBED_INPUT_CHARS, isSubset, LEVELS_ON_THE_STACK, MAX_LEVELS_COMPARED, SEQUENCE_MODES, toolSequence, writtenAlike, writtenOut, type SequenceOutcome } from '../../../src/eval/rules/expected-trajectory.js';
import { describeInput, normaliseInput, stableStringify } from '../../../src/eval/rules/trajectory.js';
import { toSteps } from '../../../src/eval/steps.js';
import type { EvalContext, EvalRuleResult, ExpectedArgsMode, ExpectedToolCall, ExpectedTrajectoryMode } from '../../../src/types/eval.js';
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

/*
 * The answer an expected call's LATER questions get, which are the ones
 * that read the expected input by the list kept of it. superset asks of
 * each step in turn whether an expected call is met by it, so one expected
 * call is asked of every step of its tool, in the order they came. Of
 * three steps that hold an object, the first is its first question of an
 * object (the input is listed and the list let go), the second makes the
 * list that is kept, and the third reads it. A step is outside the expected
 * set exactly when the answer was no. The second and the third hold the
 * same input here, so they must get the same answer, and that is the answer
 * returned.
 */
const secondAnswer = (want: unknown, have: unknown): boolean => {
  const steps = toSteps({ toolCalls: [{ tool_name: 't', input: { asked: 'first' } }, { tool_name: 't', input: have }, { tool_name: 't', input: have }] });
  const outside = compareSequence([{ tool_name: 't', input: want }], steps, 'superset', 'subset').unexpected;
  if (outside.includes(1) !== outside.includes(2)) throw new Error('the second and the third question of one expected call were answered differently');
  return !outside.includes(1);
};

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

  it('many expected calls of one tool against many calls of it, where the order of matching decides the outcome: the outcome is the one the old matching gave', () => {
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

  it('isSubset gives what writing both values out gave, on pairs of strings, numbers, booleans and values written as null, alone and under a key', () => {
    const next = rng(31);
    const values: unknown[] = [...VALUES, '', '1', 'true', 'null', undefined, NaN, Infinity, -Infinity, 1e21, 0.1 + 0.2, 0.3, 'x'.repeat(400), { a: { b: [1, { c: 2 }] } }, { a: { b: [1, { c: 3 }] } }, {}, []];
    for (let i = 0; i < 20_000; i += 1) {
      const want = values[Math.floor(next() * values.length)];
      const have = values[Math.floor(next() * values.length)];
      expect(isSubset(want, have), `${stableStringify(want)} in ${stableStringify(have)}`).toBe(isSubsetAsWritten(want, have));
    }
    for (const a of values) for (const b of values) expect(isSubset({ k: a, other: 1 }, { k: b, other: 1, more: 2 })).toBe(isSubsetAsWritten({ k: a, other: 1 }, { k: b, other: 1, more: 2 }));
  });

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
    // Through compareSequence as well, at an expected call's first question of an object, its second and its third: the key it only inherits is asked of none of the three calls.
    const held = toSteps({ toolCalls: [0, 1, 2].map((): ToolCallRecord => ({ tool_name: 't', input: { mode: 'r' } })) });
    expect(compareSequence([{ tool_name: 't', input: inherited }], held, 'superset', 'subset').unexpected).toEqual([]);
    expect(compareAsWritten([{ tool_name: 't', input: inherited }], held, 'superset', 'subset').unexpected).toEqual([]);
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
    // And each of them written from a list is written as stableStringify writes it.
    for (const a of pool) expect(writtenOut(a)).toBe(stableStringify(a));
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
    // Two objects whose keys come in another order are written alike, key by key: after keys that stand in one place in both, and where one of the two also names a key it sets to nothing.
    for (const [a, b] of [
      [{ a: 1, b: 2 }, { b: 2, a: 1 }],
      [{ a: 1, b: 2, c: 3 }, { a: 1, c: 3, b: 2 }],
      [{ a: 1, b: 2 }, { b: 2, a: 1, u: undefined }],
      [{ u: undefined, a: 1, b: 2 }, { b: 2, u: undefined, a: 1 }],
      [{ a: 1, b: { d: 4, c: [3] } }, { b: { c: [3], d: 4 }, a: 1 }],
    ] as const) {
      expect(stableStringify([a]) === stableStringify([b])).toBe(true);
      expect(writtenAlike([a], [b])).toBe(true);
      expect(writtenAlike([b], [a])).toBe(true);
    }
    // And two that name as many keys in another order, but not the same ones, are not: the key one of them lacks is set to null in the other, or stands between two they share, or comes after them.
    for (const [a, b] of [
      [{ a: null, b: 2 }, { b: 2, c: 5 }],
      [{ a: 1, c: 3 }, { c: 3, b: 2, a: 1 }],
      [{ a: 1, c: 3 }, { a: 1, b: 2, c: 3 }],
      [{ a: 1, b: 2, c: 3 }, { a: 1, c: 3, b: 2, d: 4 }],
      [{ a: 1, b: 2 }, { b: 2, a: 2 }],
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

  it('a hole in the list of expected calls, which JSON cannot carry: a mode that asks the hole a question fails on it as it did, and subset and superset pass over it', () => {
    const steps = toSteps({ toolCalls: [{ tool_name: 'a', input: { n: 1 } }, { tool_name: 'b', input: { n: 2 } }, { tool_name: 'c', input: { n: 3 } }] });
    /** Three expected calls of which the second was never set. */
    const holed = (first: string): ExpectedToolCall[] => {
      const list: ExpectedToolCall[] = [];
      list[0] = { tool_name: first, input: { n: 1 } };
      list[2] = { tool_name: 'c', input: { n: 3 } };
      return list;
    };
    const outcomeOf = (run: () => SequenceOutcome): string => {
      try {
        return JSON.stringify(run());
      } catch (error) {
        return `threw ${error instanceof Error ? error.constructor.name : typeof error}`;
      }
    };
    let threw = 0;
    let answered = 0;
    for (const args of ['subset', 'exact'] as const) {
      // The first expected call is made, so the walk reaches the hole; or it is not, and strict stops asking before it.
      for (const first of ['a', 'z']) {
        for (const mode of ['strict', 'ordered_subset', 'unordered'] as const) {
          const now = outcomeOf(() => compareSequence(holed(first), steps, mode, args));
          expect(now, `${mode}, ${args}, first ${first}`).toBe(outcomeOf(() => compareAsWritten(holed(first), steps, mode, args)));
          if (now === 'threw TypeError') threw += 1;
          else answered += 1;
        }
        // subset and superset used to fail on the hole in the pairing they worked out first and never read. Their own statements pass over a hole, as they always did.
        for (const mode of ['subset', 'superset'] as const) {
          expect(outcomeOf(() => compareAsWritten(holed(first), steps, mode, args)), `${mode}, ${args}, first ${first}`).toBe('threw TypeError');
          expect(outcomeOf(() => compareSequence(holed(first), steps, mode, args)).startsWith('{"passed":'), `${mode}, ${args}, first ${first}`).toBe(true);
        }
      }
    }
    // Both: the modes that reach the hole fail on it, and strict answers when it stops before it.
    expect(threw).toBe(10);
    expect(answered).toBe(2);
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

  it('the rule itself (toolSequence.evaluate), asked an input fifty thousand levels deep under both ways of matching arguments: it passes the same input, fails another with its sentence, and answers an array under a key the call only inherits', () => {
    const ask = (expectedInput: unknown, callInput: unknown, mode: ExpectedTrajectoryMode, args: ExpectedArgsMode): EvalRuleResult =>
      toolSequence.evaluate({ output: 'done', toolCalls: [{ tool_name: 'apply', input: callInput }], expectedTrajectory: { tool_calls: [{ tool_name: 'apply', input: expectedInput }], mode, args } } as EvalContext);
    for (const args of ['subset', 'exact'] as const) {
      for (const mode of SEQUENCE_MODES) {
        const met = ask(nest(DEPTH, 1, inObjects), nest(DEPTH, 1, inObjects), mode, args);
        expect(met.skipped, `${mode}, ${args}`).toBeUndefined();
        expect(met.passed, `${mode}, ${args}`).toBe(true);
        expect(met.message, `${mode}, ${args}`).toBe(`1 expected call satisfied by the 1 made (${mode}, args ${args})`);
        // One level fewer is another input under both: a number where the call holds an object, and a key of another length.
        const missed = ask(nest(DEPTH - 1, 1, inObjects), nest(DEPTH, 1, inObjects), mode, args);
        expect(missed.passed, `${mode}, ${args}`).toBe(false);
        expect(missed.score, `${mode}, ${args}`).toBeLessThan(1);
        expect(missed.message.startsWith(`Trajectory differs from the expected (${mode}, args ${args}): `), `${mode}, ${args}: ${missed.message.slice(0, 120)}`).toBe(true);
      }
    }
    // The sentence of the default mode names the expected call by the beginning of its input.
    expect(ask(nest(DEPTH - 1, 1, inObjects), nest(DEPTH, 1, inObjects), 'ordered_subset', 'subset').message).toBe(
      `Trajectory differs from the expected (ordered_subset, args subset): expected call 1 of 1, apply(${describeInput(nest(100, 1, inObjects))}), never came (0 of 1 in order)`,
    );
    // An array under a key the call's object only inherits: the rule answers, where it ran the stack out.
    const inherited = ask({ toString: nest(DEPTH, 1, inArrays) }, {}, 'ordered_subset', 'subset');
    expect(inherited.passed).toBe(false);
    expect(inherited.message.endsWith('never came (0 of 1 in order)')).toBe(true);
  });

  it('through compareSequence: an expected input fifty thousand levels deep is met by the same input, in every mode', () => {
    const steps = toSteps({ toolCalls: [{ tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }, { tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }] });
    for (const mode of SEQUENCE_MODES) {
      const outcome = compareSequence([{ tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }, { tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }], steps, mode, 'subset');
      expect(outcome.passed, mode).toBe(true);
    }
  });

  it('and where it is not met, the outcome fails with the sentence a shallower input of the same beginning gets: the expected input is shown by its first characters, however deep it is', () => {
    // The comparison has its answer without writing anything out. The sentence shows the beginning of the expected input, which is the beginning of the same nest a hundred levels deep, and that one can be written out whole.
    const steps = toSteps({ toolCalls: [{ tool_name: 'apply', input: nest(DEPTH, 2, inObjects) }] });
    const expected: ExpectedToolCall[] = [{ tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }];
    const shown = describeInput(nest(100, 1, inObjects));
    expect(shown).toHaveLength(DESCRIBED_INPUT_CHARS);
    expect(shown.startsWith('{"a":{"a":')).toBe(true);
    expect(shown.endsWith('…')).toBe(true);
    const WHY: Array<[mode: ExpectedTrajectoryMode, why: string]> = [
      ['strict', `call 1 was apply, expected apply(${shown})`],
      ['ordered_subset', `expected call 1 of 1, apply(${shown}), never came (0 of 1 in order)`],
      ['subset', `1 of 1 expected calls never came (first: apply(${shown}))`],
      ['unordered', `1 of 1 expected calls never came (first: apply(${shown}))`],
      ['superset', '1 call outside the expected set (first: #0 apply)'],
    ];
    for (const [mode, why] of WHY) {
      const outcome = compareSequence(expected, steps, mode, 'subset');
      expect(outcome.passed, mode).toBe(false);
      expect(outcome.why, mode).toBe(why);
    }
    // As it was written, the comparison wrote both inputs out whole, ran the stack out and gave no sentence at all.
    expect(() => compareAsWritten(expected, steps, 'subset', 'subset')).toThrow(RangeError);
    // Arrays nested as deep, and a deep value under the hundred-and-twentieth key of a wide object, which the sentence never reaches.
    const listed = compareSequence([{ tool_name: 'apply', input: nest(DEPTH, 1, inArrays) }], toSteps({ toolCalls: [{ tool_name: 'apply', input: nest(DEPTH, 2, inArrays) }] }), 'subset', 'subset');
    expect(listed.why).toBe(`1 of 1 expected calls never came (first: apply(${describeInput(nest(200, 1, inArrays))}))`);
    const wide = (deep: unknown): Record<string, unknown> => ({ ...Object.fromEntries(Array.from({ length: 130 }, (_, n) => [`k${String(n).padStart(3, '0')}`, n])), z: deep });
    const under = compareSequence([{ tool_name: 'apply', input: wide(nest(DEPTH, 1, inObjects)) }], toSteps({ toolCalls: [{ tool_name: 'apply', input: wide(nest(DEPTH, 2, inObjects)) }] }), 'subset', 'subset');
    expect(under.passed).toBe(false);
    expect(under.why).toBe(`1 of 1 expected calls never came (first: apply(${describeInput(wide(1))}))`);
    // An input that can be written out is shown as it always was.
    const shallow = compareSequence([{ tool_name: 'apply', input: nest(3, 1, inObjects) }], toSteps({ toolCalls: [{ tool_name: 'apply', input: nest(3, 2, inObjects) }] }), 'subset', 'subset');
    expect(shallow.why).toBe('1 of 1 expected calls never came (first: apply({"a":{"a":{"a":1}}}))');
    // A BigInt in an expected input the comparison did not have to reach still fails loudly when the sentence reaches it,
    expect(() => compareSequence([{ tool_name: 'apply', input: { a: 1, n: 1n } }], toSteps({ toolCalls: [{ tool_name: 'apply', input: { a: 2, n: 1n } }] }), 'subset', 'subset')).toThrow(TypeError);
    // and so does one that stands past what the sentence shows: the input is written out whole for it, as it always was.
    const pastTheSentence = [{ tool_name: 'apply', input: wide(1n) }];
    const differsFirst = toSteps({ toolCalls: [{ tool_name: 'apply', input: { k000: 'another' } }] });
    expect(() => compareAsWritten(pastTheSentence, differsFirst, 'subset', 'subset')).toThrow(TypeError);
    expect(() => compareSequence(pastTheSentence, differsFirst, 'subset', 'subset')).toThrow(TypeError);
  });

  it('under exact as well: an input too deep to normalise by a function that calls itself is written from a list, and its key is the one its text gives', () => {
    // What stableStringify writes of a nest of one-key objects, made without building the nest: the key of an input is made from this text.
    const text = (depth: number, leaf: number): string => `${'{"a":'.repeat(depth)}${leaf}${'}'.repeat(depth)}`;
    expect(text(3, 1)).toBe(stableStringify(nest(3, 1, inObjects)));
    expect(() => normaliseInput(nest(DEPTH, 1, inObjects))).toThrow(RangeError);
    expect(writtenOut(nest(DEPTH, 1, inObjects)) === text(DEPTH, 1)).toBe(true);
    const made = toSteps({ toolCalls: [{ tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }] });
    for (const mode of SEQUENCE_MODES) {
      // The same input is met.
      expect(compareSequence([{ tool_name: 'apply', input: nest(DEPTH, 1, inObjects) }], made, mode, 'exact').passed, mode).toBe(true);
      // One level fewer is another input: its key is of another length.
      expect(compareSequence([{ tool_name: 'apply', input: nest(DEPTH - 1, 1, inObjects) }], made, mode, 'exact').passed, mode).toBe(false);
    }
    expect(normaliseInput(text(DEPTH, 1))).not.toBe(normaliseInput(text(DEPTH - 1, 1)));
    expect(compareSequence([{ tool_name: 'apply', input: nest(DEPTH - 1, 1, inObjects) }], made, 'subset', 'exact').why).toBe(`1 of 1 expected calls never came (first: apply(${describeInput(text(DEPTH - 1, 1))}))`);
    // The key of a long input is its first characters and its length, as it always was: two this long that differ at the bottom alone have one key.
    expect(normaliseInput(text(DEPTH, 2))).toBe(normaliseInput(text(DEPTH, 1)));
    expect(compareSequence([{ tool_name: 'apply', input: nest(DEPTH, 2, inObjects) }], made, 'subset', 'exact').passed).toBe(true);
    // Keys in another order and white space in a string are normalised as they always were, at this depth too.
    const ordered = nest(DEPTH, 'a  b', (inner) => ({ b: 1, a: inner }));
    const reordered = nest(DEPTH, 'a b', (inner) => ({ a: inner, b: 1 }));
    expect(compareSequence([{ tool_name: 'apply', input: ordered }], toSteps({ toolCalls: [{ tool_name: 'apply', input: reordered }] }), 'strict', 'exact').passed).toBe(true);
    // Asked many times over, each input is still normalised twice at most: three expected calls against three calls, the last pair the same.
    const several = toSteps({ toolCalls: [3, 2, 1].map((less): ToolCallRecord => ({ tool_name: 'apply', input: nest(DEPTH - less, 1, inObjects) })) });
    const outcome = compareSequence([6, 5, 1].map((less): ExpectedToolCall => ({ tool_name: 'apply', input: nest(DEPTH - less, 1, inObjects) })), several, 'subset', 'exact');
    expect(outcome.matched).toBe(1);
    // A value that holds itself has no text to its end. Written out it ran the stack out; written from a list it is refused when the writing meets it again.
    const selfHeld: Record<string, unknown> = { n: 1 };
    selfHeld.self = selfHeld;
    expect(() => normaliseInput(selfHeld)).toThrow(RangeError);
    expect(() => writtenOut(selfHeld)).toThrow('An input holds itself and is not compared');
    expect(() => compareSequence([{ tool_name: 'apply', input: selfHeld }], toSteps({ toolCalls: [{ tool_name: 'apply', input: selfHeld }] }), 'strict', 'exact')).toThrow(RangeError);
    // The sentence of a failed outcome needs the beginning alone, and has it.
    expect(describeInput(writtenOut(selfHeld, DESCRIBED_INPUT_CHARS + 1)).startsWith('{"n":1,"self":{"n":1,"self":{')).toBe(true);
    // The same value met twice, one beside the other, is not a value that holds itself.
    const shared = { a: [1] };
    expect(writtenOut([shared, shared, { again: shared }])).toBe(stableStringify([shared, shared, { again: shared }]));
  }, 60_000);

  it('the sentence of a failed outcome is the one writing the whole input out gave, for inputs longer and shorter than it shows', () => {
    const next = rng(73);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    const WORDS: unknown[] = ['a.ts', 'two  spaces', ' lead', 'trail ', 'tab\there', 'line\nbreak', 'é', ' nbsp', '"quoted"', 'back\\slash', '', 'x'.repeat(130), ' '.repeat(140), `a${' '.repeat(125)}b`, 0, -0, 1.5, 1e21, NaN, Infinity, true, false, null, undefined];
    const KEYS = ['path', 'b', 'a', 'key with  spaces', '10', '9', '', 'é', 'Z', 'a.b'];
    const value = (depth: number): unknown => {
      const kind = depth > 3 ? 0 : Math.floor(next() * 3);
      if (kind === 1) return Array.from({ length: Math.floor(next() * 7) }, () => value(depth + 1));
      if (kind === 2) return Object.fromEntries(Array.from({ length: Math.floor(next() * 7) }, () => [pick(KEYS), value(depth + 1)]));
      return pick(WORDS);
    };
    const never = toSteps({ toolCalls: [{ tool_name: 't', input: { never: 'held' } }] });
    let longer = 0;
    let shorter = 0;
    let failed = 0;
    for (let i = 0; i < 4_000; i += 1) {
      // An input that is absent is not an input: the expectation would name none.
      let input = value(0);
      if (input === undefined) input = [value(1), value(1)];
      const whole = stableStringify(input);
      expect(writtenOut(input)).toBe(whole);
      // The beginning the sentence is made from, against the sentence made from the whole text.
      if (typeof input !== 'string') expect(describeInput(writtenOut(input, DESCRIBED_INPUT_CHARS + 1)), whole).toBe(describeInput(input));
      if (normaliseInput(input).length > DESCRIBED_INPUT_CHARS) longer += 1;
      else shorter += 1;
      // And through compareSequence, wherever the outcome fails naming the expected call.
      for (const mode of ['subset', 'ordered_subset', 'strict'] as const) {
        const now = compareSequence([{ tool_name: 't', input }], never, mode, 'subset');
        const was = compareAsWritten([{ tool_name: 't', input }], never, mode, 'subset');
        expect(now, whole).toEqual(was);
        if (!now.passed) failed += 1;
      }
    }
    expect(longer).toBeGreaterThan(800);
    expect(shorter).toBeGreaterThan(800);
    expect(failed).toBeGreaterThan(9_000);
    // The number the list is written to is the number describeInput shows: an input of that many characters is shown whole, and one of more is cut to that many, the last of them the mark that it was cut.
    expect(describeInput('y'.repeat(DESCRIBED_INPUT_CHARS))).toBe('y'.repeat(DESCRIBED_INPUT_CHARS));
    expect(describeInput('y'.repeat(DESCRIBED_INPUT_CHARS + 1))).toBe(`${'y'.repeat(DESCRIBED_INPUT_CHARS - 1)}…`);
    // At the very length the sentence shows, and one character past it.
    for (const length of [DESCRIBED_INPUT_CHARS - 3, DESCRIBED_INPUT_CHARS - 2, DESCRIBED_INPUT_CHARS - 1, DESCRIBED_INPUT_CHARS, DESCRIBED_INPUT_CHARS + 1]) {
      // A list of one string: the text is the string, two quotation marks and two brackets.
      const input = ['y'.repeat(length - 4)];
      expect(stableStringify(input)).toHaveLength(length);
      expect(describeInput(writtenOut(input, DESCRIBED_INPUT_CHARS + 1))).toBe(describeInput(input));
      // A list of single digits: as many pieces as characters, so the writing stops on the very piece the sentence needs last.
      const count = (length - 1) / 2;
      if (!Number.isInteger(count)) continue;
      const digits = Array.from({ length: count }, (_, n) => n % 10);
      expect(stableStringify(digits)).toHaveLength(length);
      expect(describeInput(writtenOut(digits, DESCRIBED_INPUT_CHARS + 1))).toBe(describeInput(digits));
    }
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

  it('a value that holds itself is not compared for ever: the walk stops when it meets it again, however wide the value and however long its loop, and says why', () => {
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
    expect((stopped as RangeError).message).toBe('An input holds itself and is not compared');
    const loop: unknown[] = [];
    loop.push(loop);
    const other: unknown[] = [];
    other.push(other);
    expect(thrownBy(() => writtenAlike(loop, other))).toBeInstanceOf(RangeError);
    expect(thrownBy(() => writtenAlike([a], [selfHeld()]))).toBeInstanceOf(RangeError);
    // However wide. A thousand keys, or a thousand elements, beside the one that holds the value: stopped by depth alone, the walk kept a million levels of a thousand entries first, and the process ran out of memory.
    const wide = (keys = 1_000): Record<string, unknown> => {
      const o: Record<string, unknown> = Object.fromEntries(Array.from({ length: keys }, (_, n) => [`k${n}`, n]));
      o.self = o;
      return o;
    };
    const wideList = (): unknown[] => {
      const list: unknown[] = Array.from({ length: 1_000 }, (_, n) => n);
      list.push(list);
      return list;
    };
    // However long its loop, and however far in it begins: three objects (or arrays) that hold one another in turn, under five thousand that hold nothing twice.
    const looped = (): unknown => {
      const first: Record<string, unknown> = { n: 1 };
      const second: Record<string, unknown> = { n: 2, next: first };
      const third: Record<string, unknown> = { n: 3, next: second };
      first.next = third;
      return nest(5_000, third, (inner) => ({ next: inner }));
    };
    const loopedList = (): unknown => {
      const first: unknown[] = [1];
      const second: unknown[] = [2, first];
      const third: unknown[] = [3, second];
      first.push(third);
      return nest(5_000, third, inArrays);
    };
    const WALKS: Array<[what: string, walk: () => unknown]> = [
      ['a wide object, expected', () => isSubset(wide(), wide())],
      ['a wide object under more levels than the comparison calls itself for', () => isSubset(nest(LEVELS_ON_THE_STACK + 5, wide(), inObjects), nest(LEVELS_ON_THE_STACK + 5, wide(), inObjects))],
      ['a wide array', () => writtenAlike(wideList(), wideList())],
      ['a wide object inside an array', () => writtenAlike([wide()], [wide()])],
      ['a wide object, written from a list', () => writtenOut(wide())],
      ['a wide array, written from a list', () => writtenOut(wideList())],
      ['a loop of three objects under five thousand', () => isSubset(looped(), looped())],
      ['the same inside an array', () => writtenAlike([looped()], [looped()])],
      ['a loop of three arrays under five thousand', () => writtenAlike(loopedList(), loopedList())],
      ['a loop of three objects, written from a list', () => writtenOut(looped())],
      ['a loop of three arrays, written from a list', () => writtenOut(loopedList())],
      // Through compareSequence, forty keys: under exact the input is first written out as it always was, which runs the stack out a level at a time, and that alone is slow for a wider one.
      ['under exact, through compareSequence', () => compareSequence([{ tool_name: 't', input: wide(40) }], toSteps({ toolCalls: [{ tool_name: 't', input: wide(40) }] }), 'strict', 'exact')],
      ['under subset, through compareSequence', () => compareSequence([{ tool_name: 't', input: wide(40) }], toSteps({ toolCalls: [{ tool_name: 't', input: wide(40) }] }), 'strict', 'subset')],
    ];
    for (const [what, walk] of WALKS) {
      const error = thrownBy(walk);
      expect(error, what).toBeInstanceOf(RangeError);
      expect((error as RangeError).message, what).toBe('An input holds itself and is not compared');
    }
    // Against a value that does not hold itself it differs somewhere, and that is found: what stops the walk is the pair met again, not one of the two.
    expect(isSubset(a, { n: 1, self: { n: 1, self: { n: 2 } } })).toBe(false);
    expect(writtenAlike(loop, [[[1]]])).toBe(false);
    expect(writtenAlike([[[1]]], loop)).toBe(false);
    expect(writtenAlike([a], [{ n: 1, self: { n: 1, self: { n: 1, self: { n: 2 } } } }])).toBe(false);
    const beneath = (held: unknown): unknown => nest(LEVELS_ON_THE_STACK + 5, held, inObjects);
    expect(isSubset(beneath(a), beneath({ n: 1, self: { n: 1, self: { n: 1, self: { n: 1, self: { n: 2 } } } } }))).toBe(false);
    // A value met twice side by side, and once more a level down, is not a value that holds itself: what a walk compares it with is always something the walk is still inside. On each of the three walks, and at the levels on each side of the ones a walk keeps.
    const once = { a: [1, { b: 2 }] };
    const twin = { a: [1, { b: 2 }] };
    expect(writtenAlike([once, once, [once]], [twin, twin, [twin]])).toBe(true);
    expect(writtenAlike([[once, once], [[once, once]]], [[twin, twin], [[twin, twin]]])).toBe(true);
    expect(writtenOut([once, once, [once], [[once, once]]])).toBe(stableStringify([once, once, [once], [[once, once]]]));
    for (let levels = 0; levels <= 18; levels += 1) {
      const sideBySide = (held: unknown): unknown => nest(levels, [held, held, [held, { again: held }], held], inArrays);
      expect(writtenAlike(sideBySide(once), sideBySide(twin)), `${levels} levels`).toBe(true);
      expect(writtenAlike(sideBySide(once), sideBySide({ a: [1, { b: 3 }] })), `${levels} levels`).toBe(false);
      expect(writtenOut(sideBySide(once)), `${levels} levels`).toBe(stableStringify(sideBySide(once)));
    }
    for (let levels = LEVELS_ON_THE_STACK - 1; levels <= LEVELS_ON_THE_STACK + 12; levels += 1) {
      const expected = nest(levels, { x: once, y: once, z: { w: once, v: once } }, inObjects);
      expect(isSubset(expected, nest(levels, { x: twin, y: twin, z: { w: twin, v: twin } }, inObjects)), `${levels} levels`).toBe(true);
    }
    // And the very same value is not walked at all.
    expect(isSubset(a, a)).toBe(true);
    expect(isSubset({ held: a }, { held: a })).toBe(true);
    expect(writtenAlike(loop, loop)).toBe(true);
    expect(writtenAlike([a, loop], [a, loop])).toBe(true);
  }, 60_000);

  it('a value that holds itself and holds a deep value beside its loop is stopped as soon: the deep value is walked a few times and no more, however deep it is, and once more for each level the comparison calls itself for', () => {
    // The deep value ends in an object that counts how often it is listed, which each walk does to read it.
    const DEEP = 3_000;
    let listed = 0;
    const counted = (): unknown =>
      new Proxy(
        { k: 1 },
        {
          ownKeys: (target) => {
            listed += 1;
            return Reflect.ownKeys(target);
          },
        },
      );
    const deepObjects = (): unknown => nest(DEEP, counted(), (inner) => ({ k: inner }));
    const deepArrays = (): unknown => nest(DEEP, counted(), inArrays);
    // Five values that hold themselves, each made afresh for each side: the deep value before the loop or after it in the order a walk takes them, in an object and in an array, and a loop of three with a deep value beside each.
    const SHAPES: Array<[what: string, make: () => unknown]> = [
      ['an object: the deep value, then itself', () => {
        const o: Record<string, unknown> = { deep: deepObjects() };
        o.self = o;
        return o;
      }],
      ['an object: itself, then the deep value', () => {
        const o: Record<string, unknown> = {};
        o.self = o;
        o.zdeep = deepObjects();
        return o;
      }],
      ['an array: the deep value, then itself', () => {
        const list: unknown[] = [deepArrays()];
        list.push(list);
        return list;
      }],
      ['an array: itself, then the deep value', () => {
        const list: unknown[] = [];
        list.push(list, deepArrays());
        return list;
      }],
      ['a loop of three objects, a deep value beside each', () => {
        const first: Record<string, unknown> = { deep: deepObjects() };
        const second: Record<string, unknown> = { deep: deepObjects(), next: first };
        const third: Record<string, unknown> = { deep: deepObjects(), next: second };
        first.next = third;
        return first;
      }],
    ];
    const beneath = (held: unknown): unknown => nest(LEVELS_ON_THE_STACK + 1, held, inObjects);
    /*
     * How often a walk may list the bottom of a deep value before it stops. Compared from a list or written from one,
     * a few times: it goes into the deep value at most once for each round of the loop, and meets the loop again
     * before it is three rounds down. Where the comparison calls itself for the first LEVELS_ON_THE_STACK levels it
     * looks for nothing, so the loop is gone round that many levels first, the deep value walked at each. Were the
     * deep value to carry the mark away, the walk went into it once for each of its DEEP levels.
     */
    const FEW = 12;
    const WALKS: Array<[what: string, walk: (make: () => unknown) => unknown, most: number]> = [
      ['writtenAlike', (make) => writtenAlike([make()], [make()]), FEW],
      ['isSubset, from the top', (make) => isSubset({ x: make() }, { x: make() }), LEVELS_ON_THE_STACK + FEW],
      ['isSubset, past the levels the comparison calls itself for', (make) => isSubset(beneath(make()), beneath(make())), FEW],
      ['writtenOut', (make) => writtenOut(make()), FEW],
      ['compareSequence under subset', (make) => compareSequence([{ tool_name: 't', input: { x: [make()] } }], toSteps({ toolCalls: [{ tool_name: 't', input: { x: [make()] } }] }), 'strict', 'subset'), FEW],
    ];
    expect(DEEP).toBeGreaterThan(20 * (LEVELS_ON_THE_STACK + FEW));
    let walkedIntoTheDeepValue = 0;
    for (const [walk, run, most] of WALKS) {
      for (const [shape, make] of SHAPES) {
        listed = 0;
        let error: unknown;
        try {
          run(make);
        } catch (thrown) {
          error = thrown;
        }
        expect(error, `${walk}; ${shape}`).toBeInstanceOf(RangeError);
        expect((error as RangeError).message, `${walk}; ${shape}`).toBe('An input holds itself and is not compared');
        expect(listed, `${walk}; ${shape}`).toBeLessThanOrEqual(most);
        if (listed > 0) walkedIntoTheDeepValue += 1;
      }
    }
    // Not vacuous: in most of those the walk did go into a deep value, to its bottom, before it met the loop again.
    expect(walkedIntoTheDeepValue).toBeGreaterThanOrEqual(12);
  }, 60_000);

  it('a value held in memory and nested deeper than the stop, which holds nothing twice, is stopped there and told so', () => {
    const stop = `An input is nested more than ${MAX_LEVELS_COMPARED} levels deep and is not compared`;
    // Objects under objects: a hundred levels on the stack, a million on the list, and more below them.
    const deeper = MAX_LEVELS_COMPARED + LEVELS_ON_THE_STACK + 50;
    expect(() => isSubset(nest(deeper, 1, inObjects), nest(deeper, 1, inObjects))).toThrow(stop);
    // Arrays, compared and written from a list.
    expect(() => writtenAlike(nest(MAX_LEVELS_COMPARED + 50, 1, inArrays), nest(MAX_LEVELS_COMPARED + 50, 1, inArrays))).toThrow(stop);
    // Objects inside an array.
    expect(() => writtenAlike([nest(MAX_LEVELS_COMPARED + 50, 1, inObjects)], [nest(MAX_LEVELS_COMPARED + 50, 1, inObjects)])).toThrow(stop);
    expect(() => writtenOut(nest(MAX_LEVELS_COMPARED + 50, 1, inArrays))).toThrow(stop);
  }, 120_000);

  it('what stops the comparison is depth, never size: a value that holds more values than the stop counts levels is compared to its end', () => {
    // A value met twice inside another is two values to a comparison, as it was to the writing. Twenty-one levels of pairs, each level holding the one below twice, are more than two million values and twenty-one levels deep.
    const LEVELS = 21;
    expect(2 ** LEVELS).toBeGreaterThan(2 * MAX_LEVELS_COMPARED);
    const doubled = (leaf: unknown, wrap: (inner: unknown) => unknown): unknown => {
      let value = leaf;
      for (let level = 0; level < LEVELS; level += 1) value = wrap(value);
      return value;
    };
    const inPairs = (inner: unknown): unknown => [inner, inner];
    const inTwoKeys = (inner: unknown): unknown => ({ a: inner, b: inner });
    // Arrays, and objects inside an array: two that are equal and not the same one, walked to the last of them.
    expect(writtenAlike(doubled(1, inPairs), doubled(1, inPairs))).toBe(true);
    expect(writtenAlike(doubled(1, inPairs), doubled(2, inPairs))).toBe(false);
    expect(writtenAlike([doubled(1, inTwoKeys)], [doubled(1, inTwoKeys)])).toBe(true);
    // Objects under more levels than the comparison calls itself for, where they are kept on a list.
    const under = (held: unknown): unknown => nest(LEVELS_ON_THE_STACK + 1, held, inObjects);
    expect(isSubset(under(doubled(1, inTwoKeys)), under(doubled(1, inTwoKeys)))).toBe(true);
    expect(isSubset(under(doubled(1, inTwoKeys)), under(doubled(2, inTwoKeys)))).toBe(false);
  }, 120_000);

  it('a value nested more than half as deep as the stop is compared, and written, to the bottom', () => {
    // The stop is where it says it is: a value that holds itself reaches it (above), and one this deep does not.
    const DEEP = MAX_LEVELS_COMPARED / 2 + 1_000;
    expect(isSubset(nest(DEEP, 1, inObjects), nest(DEEP, 1, inObjects))).toBe(true);
    expect(isSubset(nest(DEEP, 1, inObjects), nest(DEEP, 2, inObjects))).toBe(false);
    expect(writtenAlike(nest(DEEP, 1, inArrays), nest(DEEP, 1, inArrays))).toBe(true);
    expect(writtenAlike([nest(DEEP, 1, inObjects)], [nest(DEEP, 1, inObjects)])).toBe(true);
    // (Compared as a whole and not shown: a text a million characters long is no use in a failure's message.)
    expect(writtenOut(nest(DEEP, 1, inArrays)) === `${'['.repeat(DEEP)}1${']'.repeat(DEEP)}`).toBe(true);
    // Two such values side by side are more values than the stop counts levels, and no deeper than one: every one of them is compared.
    const sideBySide = (leaf: number): unknown[] => [nest(DEEP, leaf, inArrays), nest(DEEP, leaf, inArrays)];
    expect(2 * DEEP).toBeGreaterThan(MAX_LEVELS_COMPARED);
    expect(writtenAlike(sideBySide(1), sideBySide(1))).toBe(true);
    expect(writtenAlike(sideBySide(1), [nest(DEEP, 2, inArrays), nest(DEEP, 1, inArrays)])).toBe(false);
  }, 120_000);
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

  it('under subset, nothing a request can carry is written out to compare two inputs, however many questions are put', () => {
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

  it('under subset, the keys of an expected input are listed for its first question and once more to be kept, however many questions follow; an object under one of them is listed as often as it always was', () => {
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
    // An object under an expected key is listed whenever a question reaches it, as it always was. The modes that give each expected call a call of its own put the same questions as they always did, so there it is read exactly as often as the comparison as it was written read it.
    const under = Array.from({ length: 4 }, () => counted(5));
    const nested = under.map((u): ExpectedToolCall => ({ tool_name: 'apply', input: { opts: u.input } }));
    const holding = toSteps({ toolCalls: Array.from({ length: 6 }, (_, j): ToolCallRecord => ({ tool_name: 'apply', input: { opts: { n: j }, other: true } })) });
    for (const mode of ['unordered', 'ordered_subset'] as const) {
      const before = under.map((c) => c.reads());
      const now = compareSequence(nested, holding, mode, 'subset');
      const reads = under.map((c, k) => c.reads() - before[k]);
      const then = under.map((c) => c.reads());
      const was = compareAsWritten(nested, holding, mode, 'subset');
      expect(reads, mode).toEqual(under.map((c, k) => c.reads() - then[k]));
      // Once a question, of five or six calls. (The outcomes are compared last: writing an outcome out reads the expected calls it names.)
      expect(Math.min(...reads), mode).toBeGreaterThanOrEqual(5);
      expect(JSON.stringify(was), mode).toBe(JSON.stringify(now));
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
    // When calls that hold an object come, however late, the first of them is the expected call's first question of an object (its keys listed, the list let go) and the second is the one whose list is kept: two readings for the three, and the answers are the ones reading them in place gives.
    const asked = counted(5);
    const calls: ToolCallRecord[] = [{ tool_name: 'apply', input: 'a string' }, { tool_name: 'apply', input: [5] }, { tool_name: 'apply', input: { n: 5 } }, { tool_name: 'apply', input: { n: 6 } }, { tool_name: 'apply', input: { n: 5, more: true } }];
    const outcome = compareSequence([{ tool_name: 'apply', input: asked.input }], toSteps({ toolCalls: calls }), 'superset', 'subset');
    expect(outcome.unexpected).toEqual([0, 1, 3]);
    expect(asked.reads()).toBe(2);
    // An expected input that is not an object is never listed at all: it is compared whole with what each call holds.
    const listedNever = countedList([1, 2, 3]);
    const lists: ToolCallRecord[] = [{ tool_name: 'apply', input: 'a string' }, { tool_name: 'apply', input: { n: 5 } }, { tool_name: 'apply', input: [1, 2, 4] }, { tool_name: 'apply', input: [1, 2, 3] }];
    expect(compareSequence([{ tool_name: 'apply', input: listedNever.list }], toSteps({ toolCalls: lists }), 'superset', 'subset').unexpected).toEqual([0, 1, 2]);
    // Read through for the two calls that hold a list of its length, and not for the string or the object.
    expect(listedNever.reads()).toBe(6);
  });

  it('subset and superset put each question once: the pairing that only unordered reads is not worked out first', () => {
    /** A call's input that counts each time it is asked whether it holds a key: once a question that reaches it. */
    const questioned = (n: number): { input: Record<string, unknown>; times: () => number } => {
      let times = 0;
      const input = new Proxy<Record<string, unknown>>(
        { n },
        {
          has: (target, key) => {
            times += 1;
            return Reflect.has(target, key);
          },
        },
      );
      return { input, times: () => times };
    };
    const made = Array.from({ length: 6 }, (_, j) => questioned(j));
    const steps = toSteps({ toolCalls: made.map((m): ToolCallRecord => ({ tool_name: 'apply', input: m.input })) });
    // Four expected calls that no call satisfies: each is asked of all six.
    const expected = Array.from({ length: 4 }, (): ExpectedToolCall => ({ tool_name: 'apply', input: { n: 9 } }));
    /** How often each call was asked while `run` ran. */
    const during = (run: () => unknown): number[] => {
      const before = made.map((m) => m.times());
      run();
      return made.map((m, k) => m.times() - before[k]);
    };
    for (const mode of ['subset', 'superset'] as const) {
      expect(during(() => expect(compareSequence(expected, steps, mode, 'subset').passed, mode).toBe(false)), mode).toEqual([4, 4, 4, 4, 4, 4]);
      // As it was written, each question was put twice: once for a pairing these two modes never read, and once for the mode.
      expect(during(() => compareAsWritten(expected, steps, mode, 'subset')), mode).toEqual([8, 8, 8, 8, 8, 8]);
    }
    // unordered is the pairing, and ordered_subset words its finding by it: they put the questions they always put.
    for (const mode of ['unordered', 'ordered_subset'] as const) {
      const now = during(() => compareSequence(expected, steps, mode, 'subset'));
      expect(now, mode).toEqual(during(() => compareAsWritten(expected, steps, mode, 'subset')));
      expect(now, mode).toEqual(mode === 'unordered' ? [4, 4, 4, 4, 4, 4] : [5, 5, 5, 5, 5, 5]);
    }
    // strict asks each expected call of the call in its place, once, where it asked twice of a run that did not pass at its first call.
    const inPlace = [0, 1, 2, 9].map((n): ExpectedToolCall => ({ tool_name: 'apply', input: { n } }));
    expect(during(() => expect(compareSequence(inPlace, steps, 'strict', 'subset').matched).toBe(3))).toEqual([1, 1, 1, 1, 0, 0]);
    expect(during(() => expect(compareAsWritten(inPlace, steps, 'strict', 'subset').matched).toBe(3))).toEqual([2, 2, 2, 2, 0, 0]);
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

  it('a call that differs from the expected one in its first key is answered at that key: the call\'s keys after it are not read', () => {
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
    /** How often the nine keys of each were read while `run` ran. */
    const readsDuring = (run: () => unknown, ...inputs: Array<{ reads: () => number }>): number[] => {
      const before = inputs.map((c) => c.reads());
      run();
      return inputs.map((c, k) => c.reads() - before[k]);
    };
    const want = guarded(1);
    const have = guarded(2);
    // The expected object is listed whole, as it always was, which reads its nine keys; the call is asked for the first key and no other.
    expect(isSubset(want.input, have.input)).toBe(false);
    expect(readsDuring(() => isSubset(want.input, have.input), want, have)).toEqual([9, 0]);
    expect(readsDuring(() => isSubsetAsWritten(want.input, have.input), want, have)).toEqual([9, 0]);
    // Where they agree in the first key, every key of the call is read, once.
    const same = guarded(1);
    expect(isSubset(want.input, same.input)).toBe(true);
    expect(readsDuring(() => isSubset(want.input, same.input), want, same)).toEqual([9, 9]);
    expect(readsDuring(() => isSubsetAsWritten(want.input, same.input), want, same)).toEqual([9, 9]);
    // Asked through compareSequence three times, the expected input is listed for its first question and once more to be kept, and each call still stops at its first key.
    const expected = guarded(1);
    const calls = [guarded(2), guarded(3), guarded(4)];
    const steps = toSteps({ toolCalls: calls.map((c): ToolCallRecord => ({ tool_name: 'apply', input: c.input })) });
    expect(compareSequence([{ tool_name: 'apply', input: expected.input }], steps, 'superset', 'subset').unexpected).toEqual([0, 1, 2]);
    expect(expected.reads()).toBe(18);
    expect(calls.map((c) => c.reads())).toEqual([0, 0, 0]);
    // The same a level down: inside an object under a key, a difference under its first key is answered there, and the call's key after it is not read.
    const inside = (first: number): { input: Record<string, unknown>; reads: () => number } => {
      let reads = 0;
      const input: Record<string, unknown> = { first: { v: first } };
      Object.defineProperty(input, 'later', {
        enumerable: true,
        get: () => {
          reads += 1;
          return { v: 0 };
        },
      });
      return { input, reads: () => reads };
    };
    const asked = inside(1);
    const other = inside(2);
    const equal = inside(1);
    expect(readsDuring(() => expect(isSubset({ opts: asked.input }, { opts: other.input })).toBe(false), asked, other)).toEqual([1, 0]);
    expect(readsDuring(() => expect(isSubset({ opts: asked.input }, { opts: equal.input })).toBe(true), asked, equal)).toEqual([1, 1]);
    // And under more levels than the comparison calls itself for.
    const under = (held: unknown): unknown => nest(LEVELS_ON_THE_STACK + 5, held, inObjects);
    expect(readsDuring(() => expect(isSubset(under(asked.input), under(other.input))).toBe(false), asked, other)).toEqual([1, 0]);
    expect(readsDuring(() => expect(isSubset(under(asked.input), under(equal.input))).toBe(true), asked, equal)).toEqual([1, 1]);
  });

  it('the call is asked for each expected key as it always was: whether it holds the key, and then for the value', () => {
    /** A call's object that keeps each question it is asked, in the order they come: whether it holds a key, and for a key's value. */
    const watched = (target: Record<string, unknown>): { held: Record<string, unknown>; asked: () => string[] } => {
      const asked: string[] = [];
      const held = new Proxy(target, {
        has: (t, k) => {
          asked.push(`holds ${String(k)}?`);
          return Reflect.has(t, k);
        },
        get: (t, k, receiver) => {
          asked.push(`value of ${String(k)}`);
          return Reflect.get(t, k, receiver) as unknown;
        },
      });
      return { held, asked: () => [...asked] };
    };
    // The three roads an expected object is read by: in place, by the list kept of its entries (the later questions of its call: the same call is asked twice there), and from the list that takes over past LEVELS_ON_THE_STACK levels.
    const ROADS: Array<[road: string, ask: (want: unknown, have: unknown) => boolean, times: number]> = [
      ['in place', (want, have) => isSubset(want, have), 1],
      ['by its list', (want, have) => secondAnswer(want, have), 2],
      ['past the hundredth level', (want, have) => isSubset(nest(LEVELS_ON_THE_STACK + 5, want, inObjects), nest(LEVELS_ON_THE_STACK + 5, have, inObjects)), 1],
    ];
    const repeated = (asked: string[], times: number): string[] => Array.from({ length: times }, () => asked).flat();
    const symbol = Symbol('s');
    const plain = (): number => 1;
    const named = Object.assign((): number => 1, { toJSON: (): unknown => 'a.ts' });
    // Expected values of every kind: those written as themselves, and those written as a key held with no value is.
    const EXPECTED: unknown[] = [{ a: 1 }, {}, [1], [], 'a.ts', '', true, false, 5, 0, -0, 1e21, null, NaN, Infinity, -Infinity, symbol, plain, named];
    // What the call may hold under the key: nothing, the key with no value, each of those values, one more.
    const HELD: Array<[how: string, make: (v: unknown) => Record<string, unknown>]> = [
      ['the key is absent', () => ({ other: 1 })],
      ['the key is held as undefined', () => ({ k: undefined })],
      ['the key is held with the same value', (v) => ({ k: v, more: true })],
      ['the key is held with another value', () => ({ k: 'another' })],
      ['the key is held as null', () => ({ k: null })],
      ['the key is inherited', (v) => Object.create({ k: v }) as Record<string, unknown>],
      ['the key is read as undefined each time', () => Object.defineProperty({}, 'k', { enumerable: true, get: () => undefined }) as Record<string, unknown>],
      ['the key holds a function written as a string', () => ({ k: named })],
    ];
    let cases = 0;
    let held = 0;
    for (const [road, ask, times] of ROADS) {
      for (const [how, make] of HELD) {
        for (const v of EXPECTED) {
          const label = `${road}: ${how}, expected ${typeof v === 'symbol' || typeof v === 'function' ? typeof v : stableStringify(v)}`;
          const now = watched(make(v));
          const was = watched(make(v));
          const answer = isSubsetAsWritten({ k: v }, was.held);
          expect(ask({ k: v }, now.held), label).toBe(answer);
          // The same questions in the same order: asked once whether it holds the key, and then for the value only when it does.
          expect(now.asked(), label).toEqual(repeated(was.asked(), times));
          expect(was.asked()[0], label).toBe('holds k?');
          if (was.asked().length === 2) {
            expect(was.asked()[1], label).toBe('value of k');
            held += 1;
          } else expect(was.asked(), label).toHaveLength(1);
          cases += 1;
        }
      }
    }
    expect(cases).toBe(ROADS.length * HELD.length * EXPECTED.length);
    // Both: a key the call holds, and one it does not.
    expect(held).toBeGreaterThan(cases / 2);
    expect(cases - held).toBeGreaterThan(cases / 10);
    // A call that holds the first expected key and not the second is asked for the first's value, and for nothing of the second or of the third.
    for (const [road, ask, times] of ROADS) {
      const now = watched({ first: 1 });
      const was = watched({ first: 1 });
      expect(isSubsetAsWritten({ first: 1, second: 2, third: 3 }, was.held)).toBe(false);
      expect(ask({ first: 1, second: 2, third: 3 }, now.held), road).toBe(false);
      expect(was.asked(), road).toEqual(['holds first?', 'value of first', 'holds second?']);
      expect(now.asked(), road).toEqual(repeated(was.asked(), times));
    }
  });

  it('an object inside an array is read as its writing read it: once a comparison, each key once, in whatever order the keys come', () => {
    /** An object whose keys count, each for itself, how often it is read. */
    const keyed = (keys: readonly string[], valueOf: (k: string) => unknown = (k) => `value of ${k}`): { held: Record<string, unknown>; reads: () => number[] } => {
      const reads = keys.map(() => 0);
      const held: Record<string, unknown> = {};
      keys.forEach((k, n) => {
        Object.defineProperty(held, k, {
          enumerable: true,
          get: () => {
            reads[n] += 1;
            return valueOf(k);
          },
        });
      });
      return { held, reads: () => [...reads] };
    };
    const KEYS = ['path', 'mode', '10', '9', '4294967295', 'z'];
    const CASES: Array<[what: string, a: readonly string[], b: readonly string[], alike: boolean]> = [
      ['the same keys in the same order', KEYS, KEYS, true],
      ['the same keys in the reverse order', KEYS, [...KEYS].reverse(), true],
      ['the same keys, two of them exchanged', KEYS, ['mode', 'path', '10', '9', '4294967295', 'z'], true],
      ['the second lacks the last key', KEYS, KEYS.slice(0, -1), false],
      ['the second lacks the first key', KEYS, KEYS.slice(1), false],
      ['the second names one key more, in the middle', KEYS, ['path', 'mode', 'more', '10', '9', '4294967295', 'z'], false],
      ['the second names one key more, at the end', KEYS, [...KEYS, 'more'], false],
      ['the second names another key in place of one', KEYS, ['path', 'mode', '10', '9', '4294967295', 'y'], false],
      ['neither names a key', [], [], true],
      ['the first names none', [], KEYS, false],
    ];
    for (const [what, aKeys, bKeys, alike] of CASES) {
      const a = keyed(aKeys);
      const b = keyed(bKeys);
      expect(stableStringify([a.held]) === stableStringify([b.held]), what).toBe(alike);
      const written = [a.reads(), b.reads()];
      expect(writtenAlike([a.held], [b.held]), what).toBe(alike);
      // Each key of both was read once more, as the writing read each once: none twice, none skipped.
      expect(a.reads(), what).toEqual(written[0].map((n) => n + 1));
      expect(b.reads(), what).toEqual(written[1].map((n) => n + 1));
    }
    // Two that differ in the value of their first key are both listed whole, and that is all that is read of them.
    const a = keyed(KEYS);
    const b = keyed(KEYS, (k) => (k === '9' ? 'another' : `value of ${k}`));
    expect(writtenAlike([a.held], [b.held])).toBe(false);
    expect([a.reads(), b.reads()]).toEqual([KEYS.map(() => 1), KEYS.map(() => 1)]);
  });

  it('objects whose keys are whole numbers, short and long, or come in another order, are compared as their writings were', () => {
    const next = rng(211);
    const pick = <T,>(items: readonly T[]): T => items[Math.floor(next() * items.length)];
    // Keys the engine keeps apart from the rest, each in its own way: whole numbers it can use as places in a list, ones too long for that, ones it keeps as names, and names every object inherits.
    const KEYS = ['a', 'b', 'path', '', '0', '1', '2', '10', '34', '35', '36', '007', '-1', '1.5', '9999999', '10000000', '4294967294', '4294967295', '4294967296', '1731715200000', '9007199254740991', '9007199254740992', '__proto__', 'constructor', 'length'];
    const SCALARS: unknown[] = [1, 2, 'x', null, undefined, true];
    const object = (depth: number): Record<string, unknown> =>
      Object.fromEntries(
        Array.from({ length: Math.floor(next() * 5) }, (): [string, unknown] => {
          const inner = depth < 2 ? next() : 1;
          return [pick(KEYS), inner < 0.15 ? object(depth + 1) : inner < 0.3 ? [object(depth + 1)] : pick(SCALARS)];
        }),
      );
    /** The same object with its keys set in another order, or one key dropped, added, changed, or set to undefined. */
    const varied = (o: Record<string, unknown>): Record<string, unknown> => {
      const entries = Object.entries(o);
      const how = Math.floor(next() * 7);
      if (how === 0) return Object.fromEntries([...entries].reverse());
      if (how === 1 && entries.length > 0) return Object.fromEntries([...entries.slice(1), entries[0]]);
      if (how === 2 && entries.length > 0) return Object.fromEntries(entries.filter((_, n) => n !== Math.floor(next() * entries.length)));
      if (how === 3) return Object.fromEntries([...entries, [pick(KEYS), pick(SCALARS)]]);
      if (how === 4 && entries.length > 0) return Object.fromEntries(entries.map(([k, v], n): [string, unknown] => (n === 0 ? [k, pick(SCALARS)] : [k, v])));
      if (how === 5 && entries.length > 0) return Object.fromEntries(entries.map(([k, v], n): [string, unknown] => (n === entries.length - 1 ? [k, undefined] : [k, v])));
      return Object.fromEntries(entries);
    };
    let alike = 0;
    let subsets = 0;
    const TRIED = 30_000;
    for (let i = 0; i < TRIED; i += 1) {
      const x = object(0);
      const y = next() < 0.8 ? varied(x) : object(0);
      const label = `${stableStringify(x)} and ${stableStringify(y)}`;
      const asWritten = stableStringify([x]) === stableStringify([y]);
      if (writtenAlike([x], [y]) !== asWritten) expect(writtenAlike([x], [y]), label).toBe(asWritten);
      if (writtenAlike([y], [x]) !== asWritten) expect(writtenAlike([y], [x]), label).toBe(asWritten);
      if (asWritten) alike += 1;
      for (const [want, have] of [[x, y], [y, x]]) {
        const answer = isSubsetAsWritten(want, have);
        if (isSubset(want, have) !== answer) expect(isSubset(want, have), label).toBe(answer);
        if (i % 10 === 0 && secondAnswer(want, have) !== answer) expect(secondAnswer(want, have), label).toBe(answer);
        if (answer) subsets += 1;
      }
    }
    // Both answers, many times over.
    expect(alike).toBeGreaterThan(TRIED / 5);
    expect(TRIED - alike).toBeGreaterThan(TRIED / 5);
    expect(subsets).toBeGreaterThan(TRIED / 2);
    expect(2 * TRIED - subsets).toBeGreaterThan(TRIED / 4);
  }, 30_000);

  it('the sentence of an expected input too deep to write out whole is made from its beginning: the rest of it is not written', () => {
    const never = toSteps({ toolCalls: [{ tool_name: 't', input: { other: 1 } }] });
    // Two hundred thousand levels. Writing it out whole is tried first, as it always was, and runs the stack out some thousands of levels down, a key written at each; then the beginning is written from a list, a key and a value a piece.
    const LEVELS = 200_000;
    const now = written(() => compareSequence([{ tool_name: 't', input: nest(LEVELS, 1, inObjects) }], never, 'subset', 'subset'));
    expect(now.value.passed).toBe(false);
    expect(now.value.why).toBe(`1 of 1 expected calls never came (first: t(${describeInput(nest(100, 1, inObjects))}))`);
    expect(now.writes).toBeLessThan(LEVELS / 2);
    // Written out whole from a list, it would be a key for each level.
    expect(written(() => writtenOut(nest(LEVELS, 1, inObjects))).writes).toBeGreaterThan(LEVELS);
    expect(written(() => writtenOut(nest(LEVELS, 1, inObjects), DESCRIBED_INPUT_CHARS + 1)).writes).toBeLessThan(DESCRIBED_INPUT_CHARS);
    // An input that can be written out whole is written out whole for its sentence, as it always was: five thousand keys and five thousand values.
    const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_, n) => [`key_${String(n).padStart(4, '0')}`, n]));
    const whole = written(() => compareSequence([{ tool_name: 't', input: wide }], never, 'subset', 'subset'));
    expect(whole.writes).toBe(10_000);
    expect(written(() => compareAsWritten([{ tool_name: 't', input: wide }], never, 'subset', 'subset')).writes).toBe(10_000);
    expect(whole.value.why).toBe(compareAsWritten([{ tool_name: 't', input: wide }], never, 'subset', 'subset').why);
  });

  it('a key the call only inherits, named by an expectation with a value of any depth under it: answered by the kinds of the two, the value neither written out nor read', () => {
    // `toString`, `constructor` and their like are on every object, so a call that does not name such a key still holds it, as a function; and JSON writes a function that has no toJSON as null. A request can carry no function, and brings one to the comparison this way.
    const INHERITED = ['toString', 'constructor', 'valueOf', 'hasOwnProperty'];
    const LEVELS = 50_000;
    for (const key of INHERITED) {
      // Where both can be written out: an array, an object, a string, a number and a boolean under the key are unlike a function, and null is written as one is.
      for (const value of [[1, [2]], [], { a: 1 }, {}, 'x', 'null', 7, true, null]) {
        const label = `${key}: ${JSON.stringify(value)}`;
        expect(isSubsetAsWritten({ [key]: value }, {}), label).toBe(value === null);
        expect(isSubset({ [key]: value }, {}), label).toBe(value === null);
        expect(secondAnswer({ [key]: value }, {}), `${label}, by the list`).toBe(value === null);
        expect(isSubset(nest(LEVELS_ON_THE_STACK + 5, { [key]: value }, inObjects), nest(LEVELS_ON_THE_STACK + 5, {}, inObjects)), `${label}, past the hundredth level`).toBe(value === null);
      }
      // Fifty thousand levels under the key. Written out, the value ran the stack out and the rule gave no answer.
      expect(isSubset({ [key]: nest(LEVELS, 1, inArrays) }, {}), key).toBe(false);
      expect(isSubset({ [key]: nest(LEVELS, 1, inObjects) }, {}), key).toBe(false);
      expect(() => isSubsetAsWritten({ [key]: nest(LEVELS, 1, inArrays) }, {}), key).toThrow(RangeError);
    }
    // Through compareSequence, in every mode, the first question of the expected call and the ones after it.
    const steps = toSteps({ toolCalls: [{ tool_name: 't', input: {} }, { tool_name: 't', input: { other: 1 } }, { tool_name: 't', input: {} }] });
    for (const mode of SEQUENCE_MODES) {
      const outcome = compareSequence([{ tool_name: 't', input: { toString: nest(LEVELS, 1, inArrays) } }], steps, mode, 'subset');
      expect(outcome.passed, mode).toBe(false);
      expect(outcome.matched, mode).toBe(mode === 'superset' ? 1 : 0);
    }
    // The value under the key is not read, and nothing a request can carry is written: what is written is the function, in one step.
    const big = countedList(Array.from({ length: 5_000 }, (_, n) => n));
    const now = written(() => isSubset({ toString: big.list }, {}));
    expect(now.value).toBe(false);
    expect(big.reads()).toBe(0);
    expect(now.writes).toBe(1);
    // As it was written, the whole of it was read and written out to be compared with the word null.
    expect(written(() => isSubsetAsWritten({ toString: big.list }, {})).writes).toBeGreaterThan(5_000);
    expect(big.reads()).toBe(5_000);
    // Nor is a string, a number or a boolean under such a key written: whether it is written as null is asked of its kind. As it was written, it was written out at every question.
    for (const value of ['x'.repeat(5_000), 'null', 12_345, NaN, true, null]) {
      const asked = written(() => isSubset({ toString: value, valueOf: value }, {}));
      const alike = value === null || (typeof value === 'number' && Number.isNaN(value));
      expect(asked.value, String(value).slice(0, 12)).toBe(alike);
      // One function for each key the comparison reaches: it stops at the first that is unlike.
      expect(asked.writes, String(value).slice(0, 12)).toBe(alike ? 2 : 1);
      const before = written(() => isSubsetAsWritten({ toString: value, valueOf: value }, {}));
      expect(before.value, String(value).slice(0, 12)).toBe(alike);
      expect(before.writes, String(value).slice(0, 12)).toBe(alike ? 4 : 2);
    }
    // A function that writes itself as an array is still written alike to that array, and unlike another: the one case in which an array is written out here, from a list.
    const listed = Object.assign((): number => 1, { toJSON: (): unknown => [1, [2]] });
    expect(writtenAlike([listed], [[1, [2]]])).toBe(true);
    expect(writtenAlike([[1, [2]]], [listed])).toBe(true);
    expect(writtenAlike([listed], [[1, [3]]])).toBe(false);
    expect(writtenAlike([listed], [{ 0: 1 }])).toBe(false);
    // Against an array too deep to write out by a function that calls itself, it is unlike, and found so: the array is written from a list.
    expect(writtenAlike([listed], [nest(LEVELS, 1, inArrays)])).toBe(false);
    expect(writtenAlike([nest(LEVELS, 1, inArrays)], [listed])).toBe(false);
    // A function that writes itself as a string, a number or the word null is alike to what is written so, and to nothing else.
    const worded = Object.assign((): number => 1, { toJSON: (): unknown => 'x' });
    const counted = Object.assign((): number => 1, { toJSON: (): unknown => 7 });
    const absent = Object.assign((): number => 1, { toJSON: (): unknown => null });
    for (const [made, same, others] of [[worded, 'x', ['y', 7, null, ['x'], { x: 1 }]], [counted, 7, ['7', 8, null, [7]]], [absent, null, ['null', 0, false, [], {}]]] as Array<[unknown, unknown, unknown[]]>) {
      for (const [a, b] of [[made, same], [same, made]]) {
        expect(writtenAlike([a], [b]), String(same)).toBe(true);
        expect(isSubsetAsWritten([a], [b]), String(same)).toBe(true);
      }
      for (const other of others) {
        expect(writtenAlike([made], [other]), `${String(same)} against ${JSON.stringify(other)}`).toBe(false);
        expect(writtenAlike([other], [made]), `${String(same)} against ${JSON.stringify(other)}`).toBe(false);
        expect(isSubsetAsWritten([made], [other]), `${String(same)} against ${JSON.stringify(other)}`).toBe(false);
      }
    }
    // Two functions that are not the same one: each is written in one step, the first's first, and two with no toJSON are both written as null.
    const plain = (): number => 1;
    const another = (): number => 2;
    const wordedToo = Object.assign((): number => 2, { toJSON: (): unknown => 'x' });
    for (const [a, b, alike] of [[plain, another, true], [another, plain, true], [plain, absent, true], [absent, plain, true], [worded, wordedToo, true], [plain, worded, false], [worded, plain, false], [worded, counted, false], [listed, plain, false], [plain, listed, false]] as Array<[unknown, unknown, boolean]>) {
      expect(writtenAlike([a], [b])).toBe(alike);
      expect(isSubsetAsWritten([a], [b])).toBe(alike);
      expect(isSubset({ k: [a] }, { k: [b] })).toBe(alike);
    }
    // A BigInt has no writing, beside a function as beside anything: the comparison fails on it as it did, whichever of the two comes first.
    for (const [a, b] of [[plain, BigInt(1)], [BigInt(1), plain], [worded, BigInt(1)], [BigInt(1), BigInt(2)]] as Array<[unknown, unknown]>) {
      expect(() => writtenAlike([a], [b])).toThrow(TypeError);
      expect(() => isSubsetAsWritten([a], [b])).toThrow(TypeError);
    }
    // And one that writes itself as an object, to that object, whatever order its keys are written in.
    const shaped = Object.assign((): number => 1, { toJSON: (): unknown => ({ a: 1, b: [2] }) });
    expect(writtenAlike([shaped], [{ a: 1, b: [2] }])).toBe(true);
    expect(writtenAlike([{ a: 1, b: [2] }], [shaped])).toBe(true);
    expect(writtenAlike([shaped], [{ b: [2], a: 1 }])).toBe(true);
    expect(isSubsetAsWritten([shaped], [{ b: [2], a: 1 }])).toBe(true);
    expect(writtenAlike([shaped], [{ a: 1, b: [3] }])).toBe(false);
    expect(writtenAlike([shaped], [[1, [2]]])).toBe(false);
  });

  it('the very same value, held by the expectation and by the call, is not read at all', () => {
    const shared = counted(5);
    const listed = countedList([1, 2, 3]);
    expect(isSubset({ opts: shared.input, list: listed.list, n: 1 }, { opts: shared.input, list: listed.list, n: 1, more: true })).toBe(true);
    expect(writtenAlike([shared.input, listed.list], [shared.input, listed.list])).toBe(true);
    // Under a key of an object inside an array as well.
    expect(writtenAlike([{ opts: shared.input, list: listed.list }], [{ opts: shared.input, list: listed.list }])).toBe(true);
    expect([shared.reads(), listed.reads()]).toEqual([0, 0]);
    // Two that are equal and not the same one are read through.
    const twin = counted(5);
    expect(isSubset({ opts: shared.input }, { opts: twin.input })).toBe(true);
    expect([shared.reads(), twin.reads()]).toEqual([1, 1]);
    // By the list kept of an expected input's entries as well: the second and the third question of an expected call.
    const steps = toSteps({ toolCalls: [{ tool_name: 't', input: { asked: 'first' } }, { tool_name: 't', input: { opts: shared.input } }, { tool_name: 't', input: { opts: shared.input, more: 1 } }] });
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
