/*
 * compareSequence, held to the comparison it replaces.
 *
 * An expected sequence is compared with a run by asking each expected call
 * of each call made. Under `subset` every string, number and array was
 * written out on both sides at every question to be compared as text; now
 * nothing a request can carry is written out: two values are compared as
 * they stand, to the first place they differ. An object is read as it
 * always was: an expected object's keys and values are listed, and the
 * call's object is asked whether it holds each key and then for the value.
 * The questions themselves, and `exact`, are as they were.
 *
 * The answers have to be the same ones, to the letter: the family for
 * tool_sequence is labelled against them, and a caller's gate reads them.
 * This file keeps the comparison as it was written, holds the two together
 * on generated runs in every mode and on generated values, and counts what
 * the new one reads, asks and writes.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compareSequence, isSubset, SEQUENCE_MODES, writtenAlike, type SequenceOutcome } from '../../../src/eval/rules/expected-trajectory.js';
import { describeInput, normaliseInput, stableStringify } from '../../../src/eval/rules/trajectory.js';
import { toSteps } from '../../../src/eval/steps.js';
import { MAX_EVALUATED_DEPTH } from '../../../src/utils/element-count.js';
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

/*
 * The answer an expected call gets through compareSequence, after a
 * question asked of another step. superset asks of each step in turn
 * whether an expected call is met by it, so one expected call is asked of
 * every step of its tool, in the order they came, and a step is outside the
 * expected set exactly when the answer was no. The second and the third
 * steps hold the same input here, so they must get the same answer, and
 * that is the answer returned.
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

  it('on nested values asked again and again, alone and through compareSequence, the answers are the ones writing both out gave', () => {
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
    // A key the expectation inherits is not one it names, and a key set to undefined asks for nothing: alone, or through compareSequence.
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
    // Through compareSequence as well, and under a hundred levels of objects.
    expect(() => secondAnswer({ n: 1n }, { n: 1n })).toThrow(TypeError);
    expect(() => isSubset(nest(100, { n: 1n }, inObjects), nest(100, { n: 1n }, inObjects))).toThrow(TypeError);
    // Two arrays that differ before the BigInt are unequal there. Written out, they could not be compared at all.
    expect(isSubset([1, 2n], [2, 2n])).toBe(false);
    expect(() => isSubsetAsWritten([1, 2n], [2, 2n])).toThrow(TypeError);
  });

  it('the very same array or object on both sides is read as it was when both were written out: what the writing met inside it, the comparison meets', () => {
    // An embedder can hand the expectation and the call one object; a request, parsed, never does. Written out, each side was read whole.
    for (const shared of [{ n: 1n }, [1n], { list: [{ deep: 1n }] }, [[{ deep: [1n] }]]]) {
      expect(() => isSubset(shared, shared)).toThrow(TypeError);
      expect(() => isSubsetAsWritten(shared, shared)).toThrow(TypeError);
      expect(() => isSubset({ k: shared }, { k: shared, more: 1 })).toThrow(TypeError);
      expect(() => isSubsetAsWritten({ k: shared }, { k: shared, more: 1 })).toThrow(TypeError);
      expect(() => writtenAlike([shared], [shared])).toThrow(TypeError);
      expect(() => secondAnswer({ k: shared }, { k: shared })).toThrow(TypeError);
    }
    // A function is written by its toJSON on each side, as it was: one that is the same one on both sides is still written twice.
    let written = 0;
    const counting = Object.assign((): number => 1, {
      toJSON: (): unknown => {
        written += 1;
        return 'x';
      },
    });
    expect(writtenAlike(counting, counting)).toBe(true);
    expect(written).toBe(2);
    expect(writtenAlike([counting], [counting])).toBe(true);
    expect(written).toBe(4);
    // And the same string, number, boolean, null or absent value on both sides is alike, as its two writings were.
    const symbol = Symbol('s');
    for (const same of ['a.ts', '', 0, -0, 7, true, false, null, undefined, NaN, symbol]) {
      expect(writtenAlike(same, same), String(same)).toBe(true);
      expect(writtenAlike([same], [same]), String(same)).toBe(true);
      expect(isSubset({ k: same }, { k: same }), String(same)).toBe(true);
      expect(stableStringify([same]) === stableStringify([same]), String(same)).toBe(true);
    }
  });

  it('inputs nested as deep as the engine evaluates are compared as their writings were, in every mode and both ways of matching arguments', () => {
    // No request brings a deeper one: a door refuses it (security.maxInputDepth), and the engine refuses an evaluation nested deeper than this.
    const SHAPES: Array<[what: string, wrap: (inner: unknown, level: number) => unknown]> = [
      ['objects', inObjects],
      ['arrays', inArrays],
      ['objects and arrays in turn', (inner, level) => (level % 2 === 0 ? { a: inner } : [inner])],
      ['objects with a key before and a key after', (inner, level) => ({ before: level, a: inner, z: [level] })],
    ];
    let compared = 0;
    for (const [what, wrap] of SHAPES) {
      const deep = (leaf: unknown): unknown => nest(MAX_EVALUATED_DEPTH, leaf, wrap);
      for (const [want, have, alike] of [[deep(1), deep(1), true], [deep(1), deep(2), false], [deep({ k: 1 }), deep({ k: 1, more: 2 }), false]] as Array<[unknown, unknown, boolean]>) {
        expect(stableStringify(want) === stableStringify(have), what).toBe(alike);
        expect(writtenAlike(want, have), what).toBe(alike);
        expect(isSubset(want, have), what).toBe(isSubsetAsWritten(want, have));
        expect(secondAnswer({ k: want }, { k: have }), what).toBe(isSubsetAsWritten({ k: want }, { k: have }));
        const steps = toSteps({ toolCalls: [{ tool_name: 't', input: have }, { tool_name: 't', input: have }] });
        for (const mode of SEQUENCE_MODES) {
          for (const args of ['exact', 'subset'] as const) {
            const now = compareSequence([{ tool_name: 't', input: want }], steps, mode, args);
            expect(JSON.stringify(now), `${what}, ${mode}, ${args}`).toBe(JSON.stringify(compareAsWritten([{ tool_name: 't', input: want }], steps, mode, args)));
            compared += 1;
          }
        }
      }
    }
    expect(compared).toBe(SHAPES.length * 3 * SEQUENCE_MODES.length * 2);
  });

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
    // An expected array of the same length that differs in its first element is answered at that element: the 4,999 after it are not read.
    const sameLength = Array.from({ length: 5_000 }, (_, n) => ({ b: n === 0 ? -1 : n, a: n }));
    const before = big.reads();
    expect(isSubset([sameLength], [big.list])).toBe(false);
    expect(big.reads() - before).toBe(1);
    // One that differs in its last element is read through to it, each element once.
    const lastDiffers = Array.from({ length: 5_000 }, (_, n) => ({ b: n === 4_999 ? -1 : n, a: n }));
    const through = big.reads();
    expect(isSubset([lastDiffers], [big.list])).toBe(false);
    expect(big.reads() - through).toBe(5_000);
    // An expected array of another length is unequal by its length: nothing is read.
    const again = big.reads();
    expect(isSubset([[{ b: 0, a: 0 }]], [big.list])).toBe(false);
    expect(big.reads() - again).toBe(0);
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
    // A question of a call that holds an object lists the expected input's keys, as it always did: four here (superset pairs first, then asks each call), as many as the comparison as it was written made.
    const asked = counted(5);
    const askedThen = counted(5);
    const calls: ToolCallRecord[] = [{ tool_name: 'apply', input: 'a string' }, { tool_name: 'apply', input: [5] }, { tool_name: 'apply', input: { n: 5 } }, { tool_name: 'apply', input: { n: 6 } }, { tool_name: 'apply', input: { n: 5, more: true } }];
    const outcome = compareSequence([{ tool_name: 'apply', input: asked.input }], toSteps({ toolCalls: calls }), 'superset', 'subset');
    expect(outcome.unexpected).toEqual([0, 1, 3]);
    expect(compareAsWritten([{ tool_name: 'apply', input: askedThen.input }], toSteps({ toolCalls: calls }), 'superset', 'subset').unexpected).toEqual([0, 1, 3]);
    expect(asked.reads()).toBe(4);
    expect(askedThen.reads()).toBe(4);
    // An expected input that is not an object is never listed at all: it is compared whole with what each call holds.
    const listedNever = countedList([1, 2, 3]);
    const listedThen = countedList([1, 2, 3]);
    const lists: ToolCallRecord[] = [{ tool_name: 'apply', input: 'a string' }, { tool_name: 'apply', input: { n: 5 } }, { tool_name: 'apply', input: [1, 2, 4] }, { tool_name: 'apply', input: [1, 2, 3] }];
    expect(compareSequence([{ tool_name: 'apply', input: listedNever.list }], toSteps({ toolCalls: lists }), 'superset', 'subset').unexpected).toEqual([0, 1, 2]);
    expect(compareAsWritten([{ tool_name: 'apply', input: listedThen.list }], toSteps({ toolCalls: lists }), 'superset', 'subset').unexpected).toEqual([0, 1, 2]);
    // Read through at each question of the two calls that hold a list of its length (two each), and not for the string or the object; as it was written, every question wrote it out whole.
    expect(listedNever.reads()).toBe(12);
    expect(listedThen.reads()).toBe(24);
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
    // Asked through compareSequence, the expected input is listed at each of its six questions (superset pairs first, then asks each call), as it always was, and each call still stops at its first key.
    const expected = guarded(1);
    const calls = [guarded(2), guarded(3), guarded(4)];
    const steps = toSteps({ toolCalls: calls.map((c): ToolCallRecord => ({ tool_name: 'apply', input: c.input })) });
    expect(compareSequence([{ tool_name: 'apply', input: expected.input }], steps, 'superset', 'subset').unexpected).toEqual([0, 1, 2]);
    expect(expected.reads()).toBe(54);
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
    // And under a hundred levels of objects.
    const under = (held: unknown): unknown => nest(100, held, inObjects);
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
    // The two places an expected object is read from: where it stands, and under a hundred levels of objects.
    const ROADS: Array<[road: string, ask: (want: unknown, have: unknown) => boolean, times: number]> = [
      ['in place', (want, have) => isSubset(want, have), 1],
      ['under a hundred levels', (want, have) => isSubset(nest(100, want, inObjects), nest(100, have, inObjects)), 1],
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

  it('a key the call only inherits, named by an expectation: answered by the kinds of the two, the value under it neither written out nor read', () => {
    // `toString`, `constructor` and their like are on every object, so a call that does not name such a key still holds it, as a function; and JSON writes a function that has no toJSON as null. A request can carry no function, and brings one to the comparison this way.
    const INHERITED = ['toString', 'constructor', 'valueOf', 'hasOwnProperty'];
    for (const key of INHERITED) {
      // An array, an object, a string, a number and a boolean under the key are unlike a function, and null is written as one is.
      for (const value of [[1, [2]], [], { a: 1 }, {}, 'x', 'null', 7, true, null, nest(500, 1, inArrays), nest(500, 1, inObjects)]) {
        const label = `${key}: ${JSON.stringify(value).slice(0, 40)}`;
        expect(isSubsetAsWritten({ [key]: value }, {}), label).toBe(value === null);
        expect(isSubset({ [key]: value }, {}), label).toBe(value === null);
        expect(secondAnswer({ [key]: value }, {}), `${label}, through compareSequence`).toBe(value === null);
        expect(isSubset(nest(100, { [key]: value }, inObjects), nest(100, {}, inObjects)), `${label}, under a hundred levels`).toBe(value === null);
      }
    }
    // Through compareSequence, in every mode, the first question of the expected call and the ones after it.
    const steps = toSteps({ toolCalls: [{ tool_name: 't', input: {} }, { tool_name: 't', input: { other: 1 } }, { tool_name: 't', input: {} }] });
    for (const mode of SEQUENCE_MODES) {
      for (const under of [[1, [2]], nest(500, 1, inArrays)]) {
        const outcome = compareSequence([{ tool_name: 't', input: { toString: under } }], steps, mode, 'subset');
        expect(JSON.stringify(outcome), mode).toBe(JSON.stringify(compareAsWritten([{ tool_name: 't', input: { toString: under } }], steps, mode, 'subset')));
        expect(outcome.passed, mode).toBe(false);
        expect(outcome.matched, mode).toBe(mode === 'superset' ? 1 : 0);
      }
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
    // A function that writes itself as an array is still written alike to that array, and unlike another: the one case in which an array is written out here, as both always were.
    const listed = Object.assign((): number => 1, { toJSON: (): unknown => [1, [2]] });
    expect(writtenAlike([listed], [[1, [2]]])).toBe(true);
    expect(writtenAlike([[1, [2]]], [listed])).toBe(true);
    expect(writtenAlike([listed], [[1, [3]]])).toBe(false);
    expect(writtenAlike([listed], [{ 0: 1 }])).toBe(false);
    expect(written(() => writtenAlike([listed], [[1, [2]]])).writes).toBe(written(() => stableStringify([listed]) === stableStringify([[1, [2]]])).writes);
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

  it('the sentence of a failed outcome writes out the expected input it names, once, as it always did', () => {
    const never = toSteps({ toolCalls: [{ tool_name: 't', input: { other: 1 } }] });
    const wide = Object.fromEntries(Array.from({ length: 5_000 }, (_, n) => [`key_${String(n).padStart(4, '0')}`, n]));
    const now = written(() => compareSequence([{ tool_name: 't', input: wide }], never, 'subset', 'subset'));
    // Five thousand keys and five thousand values, for the sentence: the comparison itself wrote none of them.
    expect(now.writes).toBe(10_000);
    const was = written(() => compareAsWritten([{ tool_name: 't', input: wide }], never, 'subset', 'subset'));
    expect(was.writes).toBe(10_000);
    expect(now.value.passed).toBe(false);
    expect(now.value.why).toBe(was.value.why);
  });
});

describe('the changelog says what the comparison does and what it costs', () => {
  it('the whole entry and what an embedder sees, word for word, under Fixed in the release to come', () => {
    const changelog = readFileSync(resolve(__dirname, '..', '..', '..', 'CHANGELOG.md'), 'utf8').replace(/\r\n/g, '\n');
    const unreleased = changelog.split('\n## [Unreleased]\n')[1]?.split('\n## [')[0] ?? '';
    const fixed = unreleased.split('\n### Fixed\n')[1]?.split('\n### ')[0] ?? '';
    expect(fixed).toContain(
      [
        '- **`tool_sequence` compares inputs without writing them out under `args: "subset"`, the default.** Under `"subset"` it compared an expected input with a call\'s by writing out each array or scalar the expected object holds, beside the call\'s value under the same key, and an expected input that is not an object whole, beside the call\'s, at every question; each writing read every element of what it wrote and made a string of it, however early the two differed. It now asks the same question of the two values as they stand and stops at the first difference. The questions it puts, how it reads an object, and `"exact"` are as they were, and every answer is as it was. Measured with the code before this change and after it in one process, each alternated, held to one kind of core, on 3,000 drawn requests of at most 40 expected calls across every mode, both ways of matching arguments and keys of every kind, the CPU of the rule against before: half below 0.51, nine in ten below 1.01, in each of two runs; the requests that cost more, by at most about a tenth, each took under 3 microseconds. On 28 requests near the server\'s limits (up to 500 expected calls, 25,000 calls, 870 KB), none took longer than before by more than its own timing varied, and those that compare objects under `"subset"` took about a sixth to a half of the time.',
        '  - What an embedder sees: where writing a value of its own out threw, the comparison may now answer as the writing would have had it finished, when two values differ before a BigInt in them, or a place where one holds itself, is reached, and when they are nested deeper than the writing could go. A value is read only as far as it takes to tell the two apart, where writing it out read all of it, so one that answers otherwise each time it is read may be compared by another of its answers. A request carries none of these.',
      ].join('\n'),
    );
  });
});
