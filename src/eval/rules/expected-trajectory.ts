/*
 * The expected-trajectory rules: what the caller expected the
 * agent to DO, compared with what it did.
 *
 *   tool_sequence  the expected calls against the actual ones, in a mode —
 *                  strict (equal, in order), unordered (equal as multisets),
 *                  subset (every expected call present), superset (no call
 *                  outside the expected set), ordered_subset (the expected
 *                  calls appear in order among the actual ones; the default).
 *   step_budget    the count against THIS task's budget × a tolerance.
 *
 * Both are policies: the expectation arrives with the call (`expected_trajectory`
 * on evaluate_output), so the caller has decided, and the rule gates. Both
 * skip — never pass — without a trajectory or without an expectation, and say
 * which. Matching is by tool name, and by arguments only when the expectation
 * carries an input: `exact` compares the normalised input (sorted keys,
 * collapsed whitespace — the loop key), `subset` (the default) asks that every
 * expected key be present with the same value, so an expectation can name the
 * one argument that matters and leave the rest to the agent.
 */
import { MAX_EVIDENCE_ITEMS, type EvalContext, type EvalRule, type EvalRuleResult, type Evidence, type ExpectedArgsMode, type ExpectedToolCall, type ExpectedTrajectoryMode } from '../../types/eval.js';
import type { Step } from '../../types/trace.js';
import { stepScopeNote, stepsOf, trajectoryAbsence } from '../steps.js';
import { describeInput, normaliseInput, skipWithoutTrajectory } from './trajectory.js';

export const DEFAULT_SEQUENCE_MODE: ExpectedTrajectoryMode = 'ordered_subset';
export const DEFAULT_ARGS_MODE: ExpectedArgsMode = 'subset';
export const DEFAULT_STEP_TOLERANCE = 1.5;
export const SEQUENCE_MODES: readonly ExpectedTrajectoryMode[] = ['strict', 'unordered', 'subset', 'superset', 'ordered_subset'];

/**
 * How many levels deep one comparison of two inputs goes before it stops:
 * ten times deeper than a request can be nested at the shipped limits. It
 * is a count of levels and not of values: a value that is merely large,
 * however large, is compared to its end, as it was when it was written
 * out; and no value this deep ever was compared, because the stack holds a
 * few thousand levels. A value that holds itself does not get this far
 * (holdsItself).
 */
export const MAX_LEVELS_COMPARED = 1_000_000;

function tooDeep(): RangeError {
  return new RangeError(`An input is nested more than ${MAX_LEVELS_COMPARED} levels deep and is not compared`);
}

/**
 * A value that holds itself, which a program can build and JSON cannot
 * carry. Written out, it ran the stack out; walked from a list it would
 * never end, and each of the walks here keeps something for every level it
 * is inside, so one stopped by depth alone would have kept a million levels
 * of it first. So each walk looks, as it goes deeper, for what it is inside
 * (Brent's way of finding a loop): it keeps the array or object it is
 * inside at the levels 0, 1, 3, 7, 15 and so on, each about twice as far
 * down as the one before, and compares what it meets with the nearest of
 * those above. That is one comparison a level, and one thing kept for each
 * doubling of the depth. What holds itself is met again before the walk is
 * three times as deep as the place where its loop closes, and the walk
 * stops there. What is kept for a level is always what the walk is inside
 * at that level: so a value met twice side by side is not taken for one
 * that holds itself, and a deep value beside the loop, which the walk goes
 * all the way into and comes back out of at every round, does not put the
 * stop off. Where two values are compared, what is kept is the pair: a
 * value that holds itself is still compared with one that does not, to the
 * place where they differ, and the walk stops only when it meets both again
 * together, which is when it would never end.
 */
function holdsItself(): RangeError {
  return new RangeError('An input holds itself and is not compared');
}

/**
 * Whether a walk has met again what it is inside (holdsItself). `a` and `b`
 * are what it has just gone into, `level` levels down, one or more; `marks`
 * holds what it is inside at each kept level, two values a level, beginning
 * with the two the walk began with. They are compared with the nearest kept
 * level above, and kept in their turn when their own level is a kept one.
 */
function metAgain(marks: unknown[], level: number, a: unknown, b: unknown): boolean {
  // The kept levels are those one short of a power of two. The nearest above `level` is the one of the greatest power of two that is not more than `level`.
  const k = 31 - Math.clz32(level);
  if (a === marks[2 * k] && b === marks[2 * k + 1]) return true;
  if ((level & (level + 1)) === 0) {
    marks[2 * k + 2] = a;
    marks[2 * k + 3] = b;
  }
  return false;
}

/** Whether stableStringify writes a value as `null`: null itself, a value that is absent, a number that is not finite, a symbol. */
function writtenAsNull(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'symbol' || (typeof value === 'number' && !Number.isFinite(value));
}

/**
 * A function or a BigInt: JSON writes one by its toJSON when it has one, as
 * null when a function has none, and not at all when a BigInt has none. A
 * request carries neither. It can still bring a function here: a key an
 * expectation names that the call's object only inherits (`toString`,
 * `constructor`) is held by that object as a function.
 */
function leftToTheWriting(value: unknown): boolean {
  return typeof value === 'function' || typeof value === 'bigint';
}

/**
 * Whether two values are written alike when one of them is a function or a
 * BigInt, by what JSON writes of it, and without writing out anything a
 * request can carry.
 *
 * JSON writes a function or a BigInt in one step. When both values are one,
 * their two texts are compared, the first's written first, as they always
 * were. When one is, its text is written, and the other value is not: a
 * function with no toJSON is written as `null`, which is what every
 * function a request can bring here is written as, and whether the other
 * value is written as `null` too is asked of its kind. Only when a toJSON
 * gave some other text, which no request can bring about, is the other
 * value written out to be compared with it; and from a list, so that this
 * road too holds at any depth: the function that wrote both out called
 * itself once a level.
 */
function alikeLeftToTheWriting(x: unknown, y: unknown): boolean {
  const xLeft = leftToTheWriting(x);
  if (xLeft && leftToTheWriting(y)) return (JSON.stringify(x) ?? 'null') === (JSON.stringify(y) ?? 'null');
  const text = JSON.stringify(xLeft ? x : y) ?? 'null';
  const other = xLeft ? y : x;
  if (text === 'null') return writtenAsNull(other);
  return writtenOut(other) === text;
}

/** What is known of two values before either is walked. */
const UNLIKE = 0;
const ALIKE = 1;
const TWO_ARRAYS = 2;
const TWO_OBJECTS = 3;
type Pair = typeof UNLIKE | typeof ALIKE | typeof TWO_ARRAYS | typeof TWO_OBJECTS;

/**
 * Two values that are not the very same one, by their kinds. stableStringify
 * writes a string in quotation marks, a finite number in digits, a boolean
 * as a word, an array in square brackets, an object in braces and the rest
 * as `null`, so two values of different kinds are never written alike, two
 * different strings, numbers or booleans never are, and what is left to
 * walk is two arrays or two objects.
 */
function pairOf(x: unknown, y: unknown): Pair {
  if (leftToTheWriting(x) || leftToTheWriting(y)) return alikeLeftToTheWriting(x, y) ? ALIKE : UNLIKE;
  if (x === null || typeof x !== 'object') return writtenAsNull(x) && writtenAsNull(y) ? ALIKE : UNLIKE;
  if (y === null || typeof y !== 'object') return UNLIKE;
  const array = Array.isArray(x);
  if (array !== Array.isArray(y)) return UNLIKE;
  return array ? TWO_ARRAYS : TWO_OBJECTS;
}

/**
 * Whether stableStringify writes two values alike, asked without writing
 * either out.
 *
 * Two arrays are written alike when they are of one length and each element
 * is written as the one in its place. Two objects are, when each names the
 * keys the other names (its own, set to something) and each value is
 * written as the other's of that key. Writing both out to compare the texts
 * read every element of both at every comparison, to the last one, and made
 * two strings of them; this stops at the first difference it meets, and
 * writes nothing a request can carry (a function or a BigInt, which none
 * does, is left to the writing: pairOf).
 *
 * An object is read the way the writing read it, and in no other: its own
 * keys and their values, listed once (Object.entries). The two lists are
 * then paired place by place, which is all there is to do when both objects
 * name their keys in one order; from the first key that is not in its place,
 * the second object's remaining keys are found by name in a map made of its
 * list. Neither object is asked for a key by its name. What that costs
 * depends on the name, and on what the process has compared before: once a
 * place in the code has read more than one key name, a key that is a whole
 * number of eight digits or more is handed to the slow road at every read.
 *
 * The arrays and objects inside the two are kept on a list until their turn
 * comes, where a function that called itself for each level would run out
 * of stack on a value nested a few thousand levels deep.
 */
export function writtenAlike(a: unknown, b: unknown): boolean {
  // The very same value is written as itself. (A BigInt is left to the writing, which has none for it.)
  if (a === b && typeof a !== 'bigint') return true;
  let pair = pairOf(a, b);
  if (pair === ALIKE) return true;
  if (pair === UNLIKE) return false;
  /** The pairs of arrays and of objects still to compare: for each, the two and how many levels down they stand. */
  let waiting: unknown[] | undefined;
  let level = 0;
  /** The two values the walk began with, and the pairs it is inside at the kept levels below them (metAgain). */
  const first = a;
  const firstOther = b;
  let marks: unknown[] | undefined;
  for (;;) {
    if (pair === TWO_ARRAYS) {
      const xs = a as unknown[];
      const ys = b as unknown[];
      const length = xs.length;
      if (length !== ys.length) {
        // A hole is written as nothing, so an array that is one hole is written as the empty array is. No other two lengths are written alike.
        if (length + ys.length !== 1 || 0 in (length === 1 ? xs : ys)) return false;
      } else {
        for (let i = 0; i < length; i += 1) {
          const x = xs[i];
          const y = ys[i];
          if (x === y && x !== undefined && typeof x !== 'bigint') continue;
          // A hole is written as nothing and an element that is undefined as null: a hole is alike only to a hole.
          if ((x === undefined && !(i in xs)) !== (y === undefined && !(i in ys))) return false;
          const inner = pairOf(x, y);
          if (inner === UNLIKE) return false;
          if (inner !== ALIKE) {
            if (level === MAX_LEVELS_COMPARED) throw tooDeep();
            (waiting ??= []).push(x, y, level + 1);
          }
        }
      }
    } else {
      const xe = Object.entries(a as Record<string, unknown>);
      const ye = Object.entries(b as Record<string, unknown>);
      /** The place in the second list where the first's next key is looked for. */
      let place = 0;
      /** Once a key was not in its place: what the second list holds from that place on, by key, and how many of them the first has named. */
      let byKey: Map<string, unknown> | undefined;
      let found = 0;
      // Each key the first names, the second names too, with a value written alike. (A key set to undefined is written as if it were not there.)
      for (let n = 0; n < xe.length; n += 1) {
        const x = xe[n][1];
        if (x === undefined) continue;
        const k = xe[n][0];
        let y: unknown;
        if (byKey === undefined) {
          while (place < ye.length && ye[place][1] === undefined) place += 1;
          if (place === ye.length) return false;
          if (ye[place][0] === k) {
            y = ye[place][1];
            place += 1;
          } else {
            byKey = new Map<string, unknown>();
            for (let m = place; m < ye.length; m += 1) if (ye[m][1] !== undefined) byKey.set(ye[m][0], ye[m][1]);
          }
        }
        if (byKey !== undefined) {
          y = byKey.get(k);
          if (y === undefined) return false;
          found += 1;
        }
        if (x === y && typeof x !== 'bigint') continue;
        const inner = pairOf(x, y);
        if (inner === UNLIKE) return false;
        if (inner !== ALIKE) {
          if (level === MAX_LEVELS_COMPARED) throw tooDeep();
          (waiting ??= []).push(x, y, level + 1);
        }
      }
      // And the second names no key the first does not.
      if (byKey === undefined) {
        for (; place < ye.length; place += 1) if (ye[place][1] !== undefined) return false;
      } else if (found !== byKey.size) return false;
    }
    if (waiting === undefined || waiting.length === 0) return true;
    level = waiting.pop() as number;
    b = waiting.pop();
    a = waiting.pop();
    pair = Array.isArray(a) ? TWO_ARRAYS : TWO_OBJECTS;
    // Every pair taken after one that stands higher than it, and before the next that does not, is inside that one: so the pair last taken at a level is the one the walk is inside at that level.
    if (metAgain((marks ??= [first, firstOther]), level, a, b)) throw holdsItself();
  }
}

/**
 * `want` is a subset of `have`: every key of an object present with a value
 * that is itself a subset; arrays and scalars must be equal, which is to say
 * written alike by stableStringify (writtenAlike).
 *
 * Nothing a request can carry is written out to be compared. Every string,
 * number and array used to be, on both sides, at every comparison, and that
 * was most of what a comparison cost: 500 expected calls of 96 keys against
 * 500 calls that agree with each in every key but the last took 7 to 14 s
 * of CPU, and take about one.
 *
 * The answers are the ones comparing the writings gave, wherever both
 * values can be written out. Where one cannot (it is nested deeper than the
 * stack holds, or holds a BigInt), comparing the writings gave no answer at
 * all, and this gives one when the two differ before that is reached.
 *
 * An object under an expected key is asked in its turn, key by key, and the
 * first key that fails ends the comparison, as it always did: a call that
 * differs from the expected one in its first key costs one key. That is a
 * function calling itself for each level, which a value nested a few
 * thousand levels deep ran out of stack on; past LEVELS_ON_THE_STACK levels
 * the objects the comparison is inside are kept on a list instead, and the
 * questions and their order stay the same (isSubsetFromAList).
 *
 * Each object is read the way it always was, and in no other. The expected
 * object: its own keys and their values, listed once (Object.entries). The
 * step's object: asked whether it holds each expected key, and then for the
 * value. What a question by a key's name costs depends on the name and on
 * what the process has compared before (once a place in the code has read
 * more than one key name, a key that is a whole number of eight digits or
 * more goes the engine's slow road at every read), so no object is asked a
 * question by name that it was not asked before, and none is walked with
 * for-in, which has a slow road of its own for as long as the process lives
 * once it has walked an object whose keys are whole numbers.
 */
export function isSubset(want: unknown, have: unknown): boolean {
  if (want === null || typeof want !== 'object' || Array.isArray(want)) return writtenAlike(want, have);
  if (have === null || typeof have !== 'object' || Array.isArray(have)) return false;
  return holdsEach(Object.entries(want as Record<string, unknown>), have as Record<string, unknown>, 0);
}

/** How many levels of nested objects isSubset compares by calling itself before it keeps a list. No tool's input is known to nest this deep. */
export const LEVELS_ON_THE_STACK = 100;

/**
 * Whether the step's object holds what each entry of an expected object
 * asks: the key, with a value the expected one is a subset of. The entries
 * are the expected object's own keys and their values (a key it inherits is
 * not one it names), and an entry set to undefined asks for nothing.
 */
function holdsEach(entries: ReadonlyArray<[string, unknown]>, h: Record<string, unknown>, level: number): boolean {
  for (let n = 0; n < entries.length; n += 1) {
    const entry = entries[n];
    const v = entry[1];
    if (v === undefined) continue;
    const k = entry[0];
    if (!(k in h)) return false;
    const x = h[k];
    if (v === x && typeof v !== 'bigint') continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // An expected object is a subset of nothing but an object.
      if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
      const under = v as Record<string, unknown>;
      const held = x as Record<string, unknown>;
      if (!(level < LEVELS_ON_THE_STACK ? holdsEach(Object.entries(under), held, level + 1) : isSubsetFromAList(under, held))) return false;
    } else if (!writtenAlike(v, x)) return false;
  }
  return true;
}

/**
 * isSubset of an object, for the levels past LEVELS_ON_THE_STACK: the same
 * questions in the same order, and the same answer at any depth. Where
 * holdsEach calls itself for an object under a key and comes back to the
 * key after it, this keeps the objects it is inside on a list and comes
 * back to each from there. So here too an object under an expected key is
 * compared before the keys after it are looked at, and the first key that
 * fails ends the comparison.
 */
function isSubsetFromAList(want: Record<string, unknown>, have: Record<string, unknown>): boolean {
  /** The expected objects the comparison is inside, outermost first: for each, its entries, the step's object beside it, and the entry to go on from. */
  const inside: unknown[] = [];
  let entries = Object.entries(want);
  let held = have;
  let next = 0;
  /** The pairs of objects the comparison is inside at the kept levels (the expected one and the step's), beginning with the two it began with (metAgain). */
  let marks: unknown[] | undefined;
  for (;;) {
    if (next === entries.length) {
      // Every key of this object is held as asked: back to the object that holds it, or done.
      if (inside.length === 0) return true;
      next = inside.pop() as number;
      held = inside.pop() as Record<string, unknown>;
      entries = inside.pop() as Array<[string, unknown]>;
      continue;
    }
    const entry = entries[next];
    const v = entry[1];
    const k = entry[0];
    next += 1;
    if (v === undefined) continue;
    if (!(k in held)) return false;
    const x = held[k];
    if (v === x && typeof v !== 'bigint') continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
      // The list holds three things for each object the comparison is inside: the object under this key stands one level below them.
      if (metAgain((marks ??= [want, have]), inside.length / 3 + 1, v, x)) throw holdsItself();
      if (inside.length === 3 * MAX_LEVELS_COMPARED) throw tooDeep();
      inside.push(entries, held, next);
      entries = Object.entries(v as Record<string, unknown>);
      held = x as Record<string, unknown>;
      next = 0;
    } else if (!writtenAlike(v, x)) return false;
  }
}

/** Does an actual step satisfy an expected call? The name must match; the input only when the expectation carries one. */
export function callMatches(step: Step, expected: ExpectedToolCall, args: ExpectedArgsMode): boolean {
  if (step.name !== expected.tool_name) return false;
  if (expected.input === undefined) return true;
  return args === 'exact' ? normalisedAtAnyDepth(step.input) === normalisedAtAnyDepth(expected.input) : isSubset(expected.input, step.input);
}

/** An array or an object the writing is inside, and how far through it the writing is. */
interface Open {
  /** The array; or, for an object, its entries as stableStringify orders them. */
  array?: readonly unknown[];
  entries?: ReadonlyArray<[string, unknown]>;
  length: number;
  next: number;
}

/**
 * What stableStringify writes of a value, or the beginning of it, written
 * without a function calling itself for each level.
 *
 * stableStringify calls itself once a level, and a value nested a few
 * thousand levels deep runs it out of stack. How many levels that takes is
 * not a number a caller can know: it depends on what the process has run
 * before (a function the engine has compiled uses less stack a call than
 * one it has not). This writes the same text piece by piece, and keeps the
 * arrays and objects it is inside on a list.
 *
 * It stops once `pieces` pieces are written. Each piece holds at least one
 * character that is not white space and ends on one, so the first `pieces`
 * characters of the text, with its white space collapsed, are in what is
 * returned.
 *
 * Written to its end, a value that holds itself has no end: the writing
 * stops when it meets it again (holdsItself), as the comparison does. The
 * beginning of one can be written, like the beginning of any value.
 */
export function writtenOut(value: unknown, pieces = Infinity): string {
  const out: string[] = [];
  const inside: Open[] = [];
  /** Written whole, the value may have no end: the arrays and objects the writing is inside at the kept levels, beginning with the value itself (metAgain). */
  const whole = pieces === Infinity;
  let marks: unknown[] | undefined;
  const begin = (v: unknown): void => {
    if (v === null || typeof v !== 'object') {
      out.push(JSON.stringify(v) ?? 'null');
      return;
    }
    if (whole && inside.length > 0 && metAgain((marks ??= [value, undefined]), inside.length, v, undefined)) throw holdsItself();
    if (inside.length === MAX_LEVELS_COMPARED) throw tooDeep();
    if (Array.isArray(v)) {
      out.push('[');
      inside.push({ array: v, length: v.length, next: 0 });
    } else {
      const entries = Object.entries(v as Record<string, unknown>)
        .filter(([, x]) => x !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      out.push('{');
      inside.push({ entries, length: entries.length, next: 0 });
    }
  };
  begin(value);
  while (inside.length > 0 && out.length < pieces) {
    const open = inside[inside.length - 1];
    if (open.next === open.length) {
      out.push(open.array === undefined ? '}' : ']');
      inside.pop();
      continue;
    }
    const n = open.next;
    open.next += 1;
    if (n > 0) out.push(',');
    if (open.array !== undefined) {
      // A hole is written as nothing, between the commas of its place.
      if (n in open.array) begin(open.array[n]);
    } else {
      const [k, v] = open.entries![n];
      out.push(`${JSON.stringify(k)}:`);
      begin(v);
    }
  }
  return out.join('');
}

/**
 * The key of an input that normaliseInput could not make because the stack
 * ran out: its text is written from a list instead (writtenOut) and
 * normalised from the text, which is the same key. Anything else that went
 * wrong is thrown on as it was.
 */
function normalisedFromAList(input: unknown, error: unknown): string {
  if (!(error instanceof RangeError) || typeof input === 'string') throw error;
  return normaliseInput(writtenOut(input));
}

/** normaliseInput, for an input of any depth: normalised as it always was, and from a list when that runs the stack out. */
function normalisedAtAnyDepth(input: unknown): string {
  try {
    return normaliseInput(input);
  } catch (error) {
    return normalisedFromAList(input, error);
  }
}

/**
 * How many characters of an input describeInput shows (trajectory.ts). The
 * number is describeInput's own and stays where it is: this is its name
 * here, for the one place that needs it, and a test holds the two together.
 */
export const DESCRIBED_INPUT_CHARS = 120;

/**
 * An expected call as a finding names it: describeInput's sentence, for an
 * input of any depth. The input is described as it always was; when writing
 * it out runs the stack out, the sentence is made from the beginning of its
 * text, written from a list (writtenOut). The sentence shows the first
 * DESCRIBED_INPUT_CHARS characters of an input, so one piece more than that
 * is all it needs, and the sentence is the same one.
 */
function describeExpected(e: ExpectedToolCall): string {
  if (e.input === undefined) return e.tool_name;
  try {
    return `${e.tool_name}(${describeInput(e.input)})`;
  } catch (error) {
    if (!(error instanceof RangeError) || typeof e.input === 'string') throw error;
    return `${e.tool_name}(${describeInput(writtenOut(e.input, DESCRIBED_INPUT_CHARS + 1))})`;
  }
}

/**
 * What one comparison of an expectation with a run keeps of the inputs it
 * has read, so that a later question does not read them again.
 *
 * What is kept between questions costs something to keep, and a run that
 * made the expected calls in order needs each input once. So nothing is
 * kept the first time an input is needed, and nothing is made until a
 * question needs it.
 */
interface Kept {
  /** How many expected calls, and how many calls made, the comparison is of. */
  readonly expectedCalls: number;
  readonly calls: number;
  /** Under `exact`, for each call made and for each expected call: nothing until its input has been normalised for a question, then null (normalised, and not kept), and from the second time it is needed the normalised text. */
  stepInput: Array<string | null | undefined> | undefined;
  expectedInput: Array<string | null | undefined> | undefined;
  /** Under `subset`, for each expected call whose input is an object: nothing until it has been asked of a step that holds an object, then ASKED_ONCE, and from the second such question the entries of its input. */
  listed: Array<ReadonlyArray<[string, unknown]> | undefined> | undefined;
}

/** An expected call that has put one question about its input, and whose entries have not been kept yet. */
const ASKED_ONCE: ReadonlyArray<[string, unknown]> = [];

/**
 * callMatches' question about two inputs under `exact`, for step `j` and
 * expected call `i` of one comparison: do the two normalise to one key?
 *
 * An input is normalised twice at most, where it was normalised again at
 * every question: 500 expected calls against 500 calls with inputs of a
 * thousand characters took 4.5 to 9 s of CPU, and take 0.05 s. It is
 * normalised and let go the first time it is needed, and kept from the
 * second.
 */
function normalisedAlike(kept: Kept, j: number, i: number, want: unknown, have: unknown): boolean {
  const stepInput = (kept.stepInput ??= new Array<string | null | undefined>(kept.calls));
  let made = stepInput[j];
  if (typeof made !== 'string') {
    let text: string;
    try {
      text = normaliseInput(have);
    } catch (error) {
      text = normalisedFromAList(have, error);
    }
    stepInput[j] = made === null ? text : null;
    made = text;
  }
  const expectedInput = (kept.expectedInput ??= new Array<string | null | undefined>(kept.expectedCalls));
  let asked = expectedInput[i];
  if (typeof asked !== 'string') {
    let text: string;
    try {
      text = normaliseInput(want);
    } catch (error) {
      text = normalisedFromAList(want, error);
    }
    expectedInput[i] = asked === null ? text : null;
    asked = text;
  }
  return made === asked;
}

/**
 * callMatches' question about two inputs under `subset`, for expected call
 * `i` of one comparison: isSubset(want, have), with the keys of an expected
 * input listed twice at most, where they were listed again at every
 * question.
 *
 * An expected input is listed and the list let go for its first question,
 * and the list its second question makes is the one kept. That list is the
 * one a question makes in any case (Object.entries), so keeping it costs no
 * work a question would not have done. An object under one of its keys is
 * listed whenever a question reaches it, as it always was. And no list is
 * made for a call whose input is not an object, which is answered by its
 * kind.
 */
function holdsExpected(kept: Kept, i: number, want: unknown, have: unknown): boolean {
  // Answered by kind, as it always was, before anything is listed or kept: an expected input that is not an object is compared whole, and an expected object is a subset of nothing but an object.
  if (want === null || typeof want !== 'object' || Array.isArray(want)) return writtenAlike(want, have);
  if (have === null || typeof have !== 'object' || Array.isArray(have)) return false;
  const listed = (kept.listed ??= new Array<ReadonlyArray<[string, unknown]> | undefined>(kept.expectedCalls));
  let own = listed[i];
  if (own === undefined) {
    // Its first question of an object: listed, and the list let go.
    listed[i] = ASKED_ONCE;
    own = Object.entries(want as Record<string, unknown>);
  } else if (own === ASKED_ONCE) {
    // Its second: the list this question makes is the one kept for the questions after.
    own = listed[i] = Object.entries(want as Record<string, unknown>);
  }
  return holdsEach(own, have as Record<string, unknown>, 0);
}

/**
 * callMatches for one comparison of an expectation with a run: the same
 * questions in the same order, of a step and an expected call handed over
 * as callMatches is handed them, and after them what the comparison keeps
 * and where the two stand (step `j`, expected call `i`), which is what the
 * keeping goes by. The name; whether the expectation names an input at all;
 * then the two inputs, by the way arguments are matched. Most questions end
 * on one of the first two, and those are callMatches' own statements.
 *
 * The question about two inputs is put by a call to a function named here,
 * as callMatches puts it, and not through one made for the comparison and
 * kept in a variable: the engine does not see through a call that has gone
 * to two different functions, and that took 1.5 ns a question longer, a
 * tenth of what a question answered by the kinds of the two inputs takes.
 */
function satisfies(step: Step, expected: ExpectedToolCall, args: ExpectedArgsMode, kept: Kept, j: number, i: number): boolean {
  if (step.name !== expected.tool_name) return false;
  if (expected.input === undefined) return true;
  return args === 'exact' ? normalisedAlike(kept, j, i, expected.input, step.input) : holdsExpected(kept, i, expected.input, step.input);
}

/**
 * A one-to-one matching of expected calls onto actual steps. Expectations
 * that name arguments are placed first: an expectation without arguments
 * accepts any call of that name, so letting it go first could take the
 * one call a stricter expectation needed.
 */
function consume(expected: readonly ExpectedToolCall[], steps: readonly Step[], args: ExpectedArgsMode, kept: Kept): { matchedExpected: Set<number>; matchedSteps: Set<number> } {
  const matchedExpected = new Set<number>();
  const matchedSteps = new Set<number>();
  const order = expected.map((_, i) => i).sort((a, b) => Number(expected[b].input !== undefined) - Number(expected[a].input !== undefined) || a - b);
  for (const i of order) {
    for (let j = 0; j < steps.length; j += 1) {
      if (matchedSteps.has(j)) continue;
      if (satisfies(steps[j], expected[i], args, kept, j, i)) {
        matchedExpected.add(i);
        matchedSteps.add(j);
        break;
      }
    }
  }
  return { matchedExpected, matchedSteps };
}

export interface SequenceOutcome {
  passed: boolean;
  /** Expected calls satisfied, of those expected. */
  matched: number;
  /** The first thing wrong, in the reader's words; empty when nothing is. */
  why: string;
  /** Indices of actual steps the expectation did not account for (superset, unordered, strict). */
  unexpected: number[];
  /** Expected calls nothing satisfied (subset, ordered_subset, unordered, strict). */
  missing: ExpectedToolCall[];
}

/** The comparison, by mode. Pure, so the corpus and the unit tests can call it directly. */
export function compareSequence(expected: readonly ExpectedToolCall[], steps: readonly Step[], mode: ExpectedTrajectoryMode, args: ExpectedArgsMode): SequenceOutcome {
  // One of these for the whole comparison: what it has read of an input, it does not read again.
  const kept: Kept = { expectedCalls: expected.length, calls: steps.length, stepInput: undefined, expectedInput: undefined, listed: undefined };
  if (mode === 'strict') {
    // Each expected call is asked of the step in its place, once. (It was asked twice: once to find the first call out of place, and once more to count the calls in theirs.)
    const misplaced = expected.findIndex((e, k) => k >= steps.length || !satisfies(steps[k], e, args, kept, k, k));
    const extra = steps.length > expected.length ? steps.slice(expected.length).map((s) => s.index) : [];
    // The calls before the first out of place are in theirs, which is how it was found: the count asks only of the ones after it.
    const matched = misplaced === -1 ? expected.length : misplaced + expected.filter((e, k) => k > misplaced && k < steps.length && satisfies(steps[k], e, args, kept, k, k)).length;
    if (misplaced === -1 && extra.length === 0) return { passed: true, matched, why: '', unexpected: [], missing: [] };
    const why =
      misplaced === -1
        ? `${extra.length} call${extra.length === 1 ? '' : 's'} beyond the ${expected.length} expected (first: #${extra[0]} ${steps[extra[0]]?.name ?? ''})`
        : misplaced >= steps.length
          ? `expected call ${misplaced + 1} of ${expected.length}, ${describeExpected(expected[misplaced])}, never came (${steps.length} calls made)`
          : `call ${misplaced + 1} was ${steps[misplaced].name}, expected ${describeExpected(expected[misplaced])}`;
    return { passed: false, matched, why, unexpected: extra, missing: misplaced === -1 ? [] : [expected[misplaced]] };
  }
  if (mode === 'ordered_subset') {
    // Two pointers: O(n + m). An expected call is satisfied by the first later actual call that matches it.
    let i = 0;
    for (let j = 0; j < steps.length && i < expected.length; j += 1) if (satisfies(steps[j], expected[i], args, kept, j, i)) i += 1;
    if (i === expected.length) return { passed: true, matched: i, why: '', unexpected: [], missing: [] };
    const present = consume(expected, steps, args, kept).matchedExpected.has(i);
    return {
      passed: false,
      matched: i,
      why: present
        ? `expected call ${i + 1} of ${expected.length}, ${describeExpected(expected[i])}, came out of order (${i} of ${expected.length} in order)`
        : `expected call ${i + 1} of ${expected.length}, ${describeExpected(expected[i])}, never came (${i} of ${expected.length} in order)`,
      unexpected: [],
      missing: expected.slice(i),
    };
  }
  if (mode === 'subset') {
    // Set semantics: every expected call has SOME matching actual call.
    const absent = expected.filter((e, i) => !steps.some((s, j) => satisfies(s, e, args, kept, j, i)));
    return absent.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length - absent.length, why: `${absent.length} of ${expected.length} expected calls never came (first: ${describeExpected(absent[0])})`, unexpected: [], missing: absent };
  }
  if (mode === 'superset') {
    // Set semantics: every actual call matches SOME expected call.
    const outside = steps.filter((s, j) => !expected.some((e, i) => satisfies(s, e, args, kept, j, i)));
    return outside.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length, why: `${outside.length} call${outside.length === 1 ? '' : 's'} outside the expected set (first: #${outside[0].index} ${outside[0].name})`, unexpected: outside.map((s) => s.index), missing: [] };
  }
  // unordered: equal as multisets — every expected call consumed by a distinct actual, and no actual left over.
  const { matchedExpected, matchedSteps } = consume(expected, steps, args, kept);
  const missing = expected.filter((_, i) => !matchedExpected.has(i));
  const unexpectedSteps = steps.filter((_, j) => !matchedSteps.has(j));
  if (missing.length === 0 && unexpectedSteps.length === 0) return { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] };
  const why =
    missing.length > 0
      ? `${missing.length} of ${expected.length} expected calls never came (first: ${describeExpected(missing[0])})`
      : `${unexpectedSteps.length} call${unexpectedSteps.length === 1 ? '' : 's'} beyond the expected set (first: #${unexpectedSteps[0].index} ${unexpectedSteps[0].name})`;
  return { passed: false, matched: expected.length - missing.length, why, unexpected: unexpectedSteps.map((s) => s.index), missing };
}

const modeOf = (raw: unknown): ExpectedTrajectoryMode => (typeof raw === 'string' && (SEQUENCE_MODES as readonly string[]).includes(raw) ? (raw as ExpectedTrajectoryMode) : DEFAULT_SEQUENCE_MODE);
const argsOf = (raw: unknown): ExpectedArgsMode => (raw === 'exact' ? 'exact' : DEFAULT_ARGS_MODE);

function skipWithoutExpectation(ruleName: string, what: string): EvalRuleResult {
  return {
    ruleName,
    passed: false,
    score: 0,
    skipped: true,
    skipReason: `context.expectedTrajectory.${what} not provided — pass expected_trajectory on evaluate_output to say what the agent was expected to do`,
    message: 'No expected trajectory provided',
  };
}

export const toolSequence: EvalRule = {
  name: 'tool_sequence',
  description:
    'The calls the caller expected against the calls the agent made, in a mode: strict (equal, in order), unordered (equal as multisets), subset (every expected call present), superset (no call outside the expected set) or ordered_subset (the expected calls appear in order among the actual ones — the default; two pointers, linear time). A call matches by tool name, and by arguments only when the expectation names an input: exact compares the normalised input, subset (the default) asks that every expected key be present with the same value. Fails naming the first missing, extra or misplaced call. An explicit empty list of tool calls is judged as no calls made, which fails an expectation of calls. Skips when no tool calls were sent at all, or without expected_trajectory.tool_calls',
  evalType: 'completeness',
  weight: 1,
  kind: 'policy',
  mechanism: 'formula',
  needs: ['tool_calls', 'expected_trajectory'],
  expects: (context) => (context.expectedTrajectory?.tool_calls?.length ?? 0) > 0,
  question: 'complete',
  classes: ['wrong_trajectory'],
  // 2 (0.20.0): an explicit empty list of tool calls is judged against the expectation instead of skipped.
  version: 2,
  evaluate(context: EvalContext): EvalRuleResult {
    const expected = context.expectedTrajectory?.tool_calls;
    if (expected === undefined || expected.length === 0) return skipWithoutExpectation('tool_sequence', 'tool_calls');
    /*
     * `tool_calls: []` is a trajectory: the caller says no calls were made,
     * and against an expectation of calls that is the finding. Until 0.20.0
     * it skipped, so "expected a search, made none" passed. Calls that were
     * not sent at all still skip: there is nothing to compare.
     */
    const skip = skipWithoutTrajectory('tool_sequence', context);
    if (skip && trajectoryAbsence(context) !== 'empty_calls') return skip;
    const steps = stepsOf(context);
    const mode = modeOf(context.expectedTrajectory?.mode);
    const args = argsOf(context.expectedTrajectory?.args);
    const outcome = compareSequence(expected, steps, mode, args);
    const scope = stepScopeNote(context);
    const evidence: Evidence[] = [
      { type: 'count', stat: 'expected_calls_matched', unit: 'calls', value: outcome.matched, threshold: expected.length, thresholdSource: 'call' },
      ...outcome.unexpected.slice(0, MAX_EVIDENCE_ITEMS - 1).map((index): Evidence => ({ type: 'toolCall', index, toolName: steps.find((s) => s.index === index)?.name ?? '', label: 'outside the expected set' })),
    ];
    return {
      ruleName: 'tool_sequence',
      passed: outcome.passed,
      score: outcome.passed ? 1 : expected.length === 0 ? 0 : Math.max(0, Math.min(1, outcome.matched / expected.length - (outcome.unexpected.length > 0 ? 0.25 : 0))),
      value: { stat: 'expected_calls_matched', unit: 'calls', value: outcome.matched },
      evidence: evidence.slice(0, MAX_EVIDENCE_ITEMS),
      message: outcome.passed
        ? `${expected.length} expected call${expected.length === 1 ? '' : 's'} satisfied by the ${steps.length} made (${mode}, args ${args})${scope}`
        : `Trajectory differs from the expected (${mode}, args ${args}): ${outcome.why}${scope}`,
    };
  },
};

export const stepBudget: EvalRule = {
  name: 'step_budget',
  description:
    'A task must finish within ITS budget: the number of tool calls made against expected_trajectory.step_budget (or the number of expected calls when only tool_calls was given) times a tolerance (expected_trajectory.tolerance, default 1.5) — fails when calls exceed budget × tolerance, naming the overrun. Where max_steps is one deployment-wide ceiling, this is the budget the caller states for one task. An explicit empty list of tool calls is judged as zero calls. Skips when no tool calls were sent at all, or without an expectation',
  evalType: 'cost',
  weight: 1,
  kind: 'policy',
  mechanism: 'formula',
  needs: ['tool_calls', 'expected_trajectory'],
  expects: (context) => {
    const et = context.expectedTrajectory;
    return (typeof et?.step_budget === 'number' && Number.isFinite(et.step_budget) && et.step_budget >= 1) || (et?.tool_calls?.length ?? 0) > 0;
  },
  question: 'within_budget',
  classes: ['over_budget'],
  // 2 (0.20.0): an explicit empty list of tool calls is judged as zero calls instead of skipped.
  version: 2,
  evaluate(context: EvalContext): EvalRuleResult {
    const et = context.expectedTrajectory;
    const declared = typeof et?.step_budget === 'number' && Number.isFinite(et.step_budget) && et.step_budget >= 1 ? Math.floor(et.step_budget) : undefined;
    const budget = declared ?? (et?.tool_calls !== undefined && et.tool_calls.length > 0 ? et.tool_calls.length : undefined);
    if (budget === undefined) return skipWithoutExpectation('step_budget', 'step_budget (or tool_calls)');
    // An explicit empty list is zero calls, which is within any budget; calls that were not sent at all still skip.
    const skip = skipWithoutTrajectory('step_budget', context);
    if (skip && trajectoryAbsence(context) !== 'empty_calls') return skip;
    const tolerance = typeof et?.tolerance === 'number' && Number.isFinite(et.tolerance) && et.tolerance >= 1 ? et.tolerance : DEFAULT_STEP_TOLERANCE;
    const ceiling = budget * tolerance;
    const calls = stepsOf(context).length;
    const passed = calls <= ceiling;
    const scope = stepScopeNote(context);
    return {
      ruleName: 'step_budget',
      passed,
      score: passed ? 1 : Math.max(0, ceiling / calls),
      value: { stat: 'tool_calls', unit: 'calls', value: calls },
      evidence: [{ type: 'count', stat: 'tool_calls', unit: 'calls', value: calls, threshold: ceiling, thresholdSource: 'call' }],
      message: passed
        ? `${calls} tool call${calls === 1 ? '' : 's'} against a budget of ${budget} × ${tolerance} = ${ceiling}${scope}`
        : `Step budget: ${calls} tool calls exceeds ${budget} × ${tolerance} = ${ceiling} (${calls - Math.floor(ceiling)} over)${scope}`,
    };
  },
};
