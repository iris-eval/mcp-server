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
import { describeInput, normaliseInput, skipWithoutTrajectory, stableStringify } from './trajectory.js';

export const DEFAULT_SEQUENCE_MODE: ExpectedTrajectoryMode = 'ordered_subset';
export const DEFAULT_ARGS_MODE: ExpectedArgsMode = 'subset';
export const DEFAULT_STEP_TOLERANCE = 1.5;
export const SEQUENCE_MODES: readonly ExpectedTrajectoryMode[] = ['strict', 'unordered', 'subset', 'superset', 'ordered_subset'];

/**
 * How many objects and arrays one comparison of two inputs walks before it
 * stops. A request holds a hundred thousand elements at the shipped limit,
 * so nothing a caller sends comes near it. What reaches it is a value that
 * holds itself, which a program can build and JSON cannot carry: written
 * out, such a value ran the stack out, and walked it would never end.
 */
export const MAX_NESTED_COMPARED = 10_000_000;

function tooManyNested(): RangeError {
  return new RangeError(`An input holds more than ${MAX_NESTED_COMPARED} objects and arrays inside it, or holds itself, and is not compared`);
}

/** Whether stableStringify writes a value as `null`: null itself, a value that is absent, a number that is not finite, a symbol. */
function writtenAsNull(value: unknown): boolean {
  return value === null || value === undefined || typeof value === 'symbol' || (typeof value === 'number' && !Number.isFinite(value));
}

/** A function or a BigInt: JSON writes one by its toJSON when it has one, as null when a function has none, and not at all when a BigInt has none. Neither is in a request. */
function leftToTheWriting(value: unknown): boolean {
  return typeof value === 'function' || typeof value === 'bigint';
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
  if (leftToTheWriting(x) || leftToTheWriting(y)) return stableStringify(x) === stableStringify(y) ? ALIKE : UNLIKE;
  if (x === null || typeof x !== 'object') return writtenAsNull(x) && writtenAsNull(y) ? ALIKE : UNLIKE;
  if (y === null || typeof y !== 'object') return UNLIKE;
  const array = Array.isArray(x);
  if (array !== Array.isArray(y)) return UNLIKE;
  return array ? TWO_ARRAYS : TWO_OBJECTS;
}

const { propertyIsEnumerable } = Object.prototype;

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
 * writes nothing.
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
  let waiting: unknown[] | undefined;
  let nested = 0;
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
            if ((nested += 1) > MAX_NESTED_COMPARED) throw tooManyNested();
            (waiting ??= []).push(x, y);
          }
        }
      }
    } else {
      const xo = a as Record<string, unknown>;
      const yo = b as Record<string, unknown>;
      // Each key the first names, the second names too, with a value written alike.
      const xKeys = Object.keys(xo);
      let named = 0;
      for (let n = 0; n < xKeys.length; n += 1) {
        const k = xKeys[n];
        const x = xo[k];
        if (x === undefined) continue;
        named += 1;
        if (!propertyIsEnumerable.call(yo, k)) return false;
        const y = yo[k];
        if (y === undefined) return false;
        if (x === y && typeof x !== 'bigint') continue;
        const inner = pairOf(x, y);
        if (inner === UNLIKE) return false;
        if (inner !== ALIKE) {
          if ((nested += 1) > MAX_NESTED_COMPARED) throw tooManyNested();
          (waiting ??= []).push(x, y);
        }
      }
      // And the second names no key the first does not: it names as many.
      const yKeys = Object.keys(yo);
      for (let n = 0; n < yKeys.length; n += 1) if (yo[yKeys[n]] !== undefined) named -= 1;
      if (named !== 0) return false;
    }
    if (waiting === undefined || waiting.length === 0) return true;
    b = waiting.pop();
    a = waiting.pop();
    pair = Array.isArray(a) ? TWO_ARRAYS : TWO_OBJECTS;
  }
}

/**
 * `want` is a subset of `have`: every key of an object present with a value
 * that is itself a subset; arrays and scalars must be equal, which is to say
 * written alike by stableStringify (writtenAlike).
 *
 * Nothing is written out to be compared. Every string, number and array
 * used to be, on both sides, at every comparison, and that was most of what
 * a comparison cost: 500 expected calls of 96 keys against 500 calls that
 * agree with each in every key but the last took 6 to 12 s of CPU, and take
 * half a second.
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
 * the objects wait on a list instead (isSubsetFromAList).
 *
 * An object's keys are listed with Object.keys, and not walked with for-in.
 * Once a for-in has walked one object whose keys are whole numbers, the
 * engine walks every object the slow way at that place for as long as the
 * process lives: after one such request, 500 expected calls of objects
 * nested 96 deep against 500 calls took 4.1 s of CPU, and take 1.3.
 */
export function isSubset(want: unknown, have: unknown): boolean {
  return isSubsetAt(want, have, 0);
}

/** How many levels of nested objects isSubset compares by calling itself before it keeps a list. No tool's input is known to nest this deep. */
export const LEVELS_ON_THE_STACK = 100;

function isSubsetAt(want: unknown, have: unknown, level: number): boolean {
  if (want === null || typeof want !== 'object' || Array.isArray(want)) return writtenAlike(want, have);
  if (have === null || typeof have !== 'object' || Array.isArray(have)) return false;
  const w = want as Record<string, unknown>;
  const h = have as Record<string, unknown>;
  // The object's own keys: a key it inherits is not one it names, and a key set to undefined asks for nothing.
  const keys = Object.keys(w);
  for (let n = 0; n < keys.length; n += 1) {
    const k = keys[n];
    const v = w[k];
    if (v === undefined) continue;
    if (!(k in h)) return false;
    const x = h[k];
    if (v === x && typeof v !== 'bigint') continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      if (!(level < LEVELS_ON_THE_STACK ? isSubsetAt(v, x, level + 1) : isSubsetFromAList(v as Record<string, unknown>, x))) return false;
    } else if (!writtenAlike(v, x)) return false;
  }
  return true;
}

/** isSubset of an object, with the objects under its keys kept on a list until their turn comes: the same answer at any depth. */
function isSubsetFromAList(want: Record<string, unknown>, have: unknown): boolean {
  let waiting: unknown[] | undefined;
  let nested = 0;
  let w = want;
  let h = have;
  for (;;) {
    if (h === null || typeof h !== 'object' || Array.isArray(h)) return false;
    const held = h as Record<string, unknown>;
    const keys = Object.keys(w);
    for (let n = 0; n < keys.length; n += 1) {
      const k = keys[n];
      const v = w[k];
      if (v === undefined) continue;
      if (!(k in held)) return false;
      const x = held[k];
      if (v === x && typeof v !== 'bigint') continue;
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
        if ((nested += 1) > MAX_NESTED_COMPARED) throw tooManyNested();
        (waiting ??= []).push(v, x);
      } else if (!writtenAlike(v, x)) return false;
    }
    if (waiting === undefined || waiting.length === 0) return true;
    h = waiting.pop();
    w = waiting.pop() as Record<string, unknown>;
  }
}

/** What an expected input that is an object asks for, listed once for the many steps it is asked of: its own keys that are not set to undefined, and their values. */
interface Listed {
  keys: string[];
  values: unknown[];
}
function listedOf(want: object): Listed {
  const w = want as Record<string, unknown>;
  const own: Listed = { keys: [], values: [] };
  for (const k of Object.keys(w)) {
    const v = w[k];
    if (v === undefined) continue;
    own.keys.push(k);
    own.values.push(v);
  }
  return own;
}
/** isSubset of an expected object by its list: the same answer, without reading the object again. */
function listedIsSubset(own: Listed, have: unknown): boolean {
  if (have === null || typeof have !== 'object' || Array.isArray(have)) return false;
  const h = have as Record<string, unknown>;
  const { keys, values } = own;
  for (let n = 0; n < keys.length; n += 1) {
    const k = keys[n];
    const v = values[n];
    const x = h[k];
    // A key the step holds with no value is a key it holds.
    if (x === undefined && !(k in h)) return false;
    if (v === x && typeof v !== 'bigint') continue;
    if (!isSubset(v, x)) return false;
  }
  return true;
}

/** Does an actual step satisfy an expected call? The name must match; the input only when the expectation carries one. */
export function callMatches(step: Step, expected: ExpectedToolCall, args: ExpectedArgsMode): boolean {
  if (step.name !== expected.tool_name) return false;
  if (expected.input === undefined) return true;
  return args === 'exact' ? normaliseInput(step.input) === normaliseInput(expected.input) : isSubset(expected.input, step.input);
}

/**
 * An expected call as a finding names it. Its input is written out to be
 * shown, and a value nested a few thousand levels deep cannot be: the stack
 * runs out. By then the comparison has its answer, and the answer stands;
 * the sentence says what it could not show.
 */
function describeExpected(e: ExpectedToolCall): string {
  if (e.input === undefined) return e.tool_name;
  try {
    return `${e.tool_name}(${describeInput(e.input)})`;
  } catch (error) {
    if (error instanceof RangeError) return `${e.tool_name}(an input nested too deep to write out)`;
    throw error;
  }
}

/** Does the input of step `j` satisfy the input expected call `i` names? Asked by position, of an expected call that names one. */
type InputsMatch = (j: number, i: number) => boolean;

/** An expected call that has put one question about its input, and for which nothing has been listed yet. */
const ASKED_ONCE: Listed = { keys: [], values: [] };

/**
 * The inputs' half of callMatches, for one comparison of an expectation
 * with a run.
 *
 * The answers are callMatches'. What differs is the work. Under `exact`
 * an input is normalised twice at most, where it was normalised again at
 * every question: 500 expected calls against 500 calls with inputs of a
 * thousand characters took 4.5 to 9 s of CPU, and take 0.05 s. Under
 * `subset` nothing is written out at all (isSubset), and from the second
 * question an expected call puts, the keys its input asks for are read from
 * a list made once.
 *
 * What is kept between questions costs something to keep, and a run that
 * made the expected calls in order needs each input once. So nothing is
 * kept the first time an input is needed: under `exact` it is normalised
 * and let go, and kept from the second time; under `subset` an expected
 * input is read in place for its first question and listed for its second.
 * Nor is a list made for a call whose input is not an object, which is
 * answered by its kind; and nothing is made until a question needs it.
 */
function inputsMatchOf(expected: readonly ExpectedToolCall[], steps: readonly Step[], args: ExpectedArgsMode): InputsMatch {
  if (args === 'exact') {
    /** For each call made, and for each expected call: nothing until its input has been normalised for a question, then null (normalised, and not kept), and from the second time it is needed the normalised text. */
    let stepInput: Array<string | null | undefined> | undefined;
    let expectedInput: Array<string | null | undefined> | undefined;
    return (j, i) => {
      stepInput ??= new Array<string | null | undefined>(steps.length);
      expectedInput ??= new Array<string | null | undefined>(expected.length);
      let made = stepInput[j];
      if (typeof made !== 'string') {
        const text = normaliseInput(steps[j].input);
        stepInput[j] = made === null ? text : null;
        made = text;
      }
      let asked = expectedInput[i];
      if (typeof asked !== 'string') {
        const text = normaliseInput(expected[i].input);
        expectedInput[i] = asked === null ? text : null;
        asked = text;
      }
      return made === asked;
    };
  }
  /** For each expected call: nothing until it has put a question about its input, then ASKED_ONCE, and from its second question what its input asks for, listed, or null when its input is not an object. */
  let listed: Array<Listed | null | undefined> | undefined;
  return (j, i) => {
    const want = expected[i].input;
    const have = steps[j].input;
    listed ??= new Array<Listed | null | undefined>(expected.length);
    let own = listed[i];
    if (own === undefined) {
      listed[i] = ASKED_ONCE;
      return isSubset(want, have);
    }
    if (own === ASKED_ONCE) {
      if (want === null || typeof want !== 'object' || Array.isArray(want)) own = listed[i] = null;
      else {
        // An expected object is a subset of nothing but an object: a call that holds anything else is answered by its kind, and no list is made for that.
        if (have === null || typeof have !== 'object' || Array.isArray(have)) return false;
        own = listed[i] = listedOf(want);
      }
    }
    return own === null ? isSubset(want, have) : listedIsSubset(own, have);
  };
}

/**
 * Does step `j` satisfy expected call `i`? callMatches, asked by position.
 * The name is asked here, and whether the expectation names an input at
 * all: most questions end on one or the other, and those cost what they
 * always did. Only a question about two inputs goes on to inputsMatch.
 */
function satisfies(expected: readonly ExpectedToolCall[], steps: readonly Step[], j: number, i: number, inputsMatch: InputsMatch): boolean {
  const e = expected[i];
  if (steps[j].name !== e.tool_name) return false;
  return e.input === undefined || inputsMatch(j, i);
}

/**
 * A one-to-one matching of expected calls onto actual steps. Expectations
 * that name arguments are placed first: an expectation without arguments
 * accepts any call of that name, so letting it go first could take the
 * one call a stricter expectation needed.
 */
function consume(expected: readonly ExpectedToolCall[], steps: readonly Step[], inputsMatch: InputsMatch): { matchedExpected: Set<number>; matchedSteps: Set<number> } {
  const matchedExpected = new Set<number>();
  const matchedSteps = new Set<number>();
  const order = expected.map((_, i) => i).sort((a, b) => Number(expected[b].input !== undefined) - Number(expected[a].input !== undefined) || a - b);
  for (const i of order) {
    for (let j = 0; j < steps.length; j += 1) {
      if (matchedSteps.has(j)) continue;
      if (satisfies(expected, steps, j, i, inputsMatch)) {
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
  const inputsMatch = inputsMatchOf(expected, steps, args);
  if (mode === 'strict') {
    // Each expected call is asked of the step in its place, once: the first out of place, and how many are in theirs.
    let misplaced = -1;
    let matched = 0;
    for (let k = 0; k < expected.length; k += 1) {
      if (k < steps.length && satisfies(expected, steps, k, k, inputsMatch)) matched += 1;
      else if (misplaced === -1) misplaced = k;
    }
    const extra = steps.length > expected.length ? steps.slice(expected.length).map((s) => s.index) : [];
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
    for (let j = 0; j < steps.length && i < expected.length; j += 1) if (satisfies(expected, steps, j, i, inputsMatch)) i += 1;
    if (i === expected.length) return { passed: true, matched: i, why: '', unexpected: [], missing: [] };
    const present = consume(expected, steps, inputsMatch).matchedExpected.has(i);
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
    const absent = expected.filter((_, i) => !steps.some((_step, j) => satisfies(expected, steps, j, i, inputsMatch)));
    return absent.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length - absent.length, why: `${absent.length} of ${expected.length} expected calls never came (first: ${describeExpected(absent[0])})`, unexpected: [], missing: absent };
  }
  if (mode === 'superset') {
    // Set semantics: every actual call matches SOME expected call. Asked one expected call at a time, of the steps no expected call has matched yet.
    const inside: boolean[] = new Array<boolean>(steps.length).fill(false);
    for (let i = 0; i < expected.length; i += 1) for (let j = 0; j < steps.length; j += 1) if (!inside[j] && satisfies(expected, steps, j, i, inputsMatch)) inside[j] = true;
    const outside = steps.filter((_, j) => !inside[j]);
    return outside.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length, why: `${outside.length} call${outside.length === 1 ? '' : 's'} outside the expected set (first: #${outside[0].index} ${outside[0].name})`, unexpected: outside.map((s) => s.index), missing: [] };
  }
  // unordered: equal as multisets — every expected call consumed by a distinct actual, and no actual left over.
  const { matchedExpected, matchedSteps } = consume(expected, steps, inputsMatch);
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
