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
import { MAX_EVIDENCE_ITEMS, type EvalContext, type EvalRule, type RuleAnswer, type Evidence, type ExpectedArgsMode, type ExpectedToolCall, type ExpectedTrajectoryMode } from '../../types/eval.js';
import type { Step } from '../../types/trace.js';
import { stepScopeNote, stepsOf, trajectoryAbsence } from '../steps.js';
import { describeInput, normaliseInput, skipWithoutTrajectory, stableStringify } from './trajectory.js';

export const DEFAULT_SEQUENCE_MODE: ExpectedTrajectoryMode = 'ordered_subset';
export const DEFAULT_ARGS_MODE: ExpectedArgsMode = 'subset';
export const DEFAULT_STEP_TOLERANCE = 1.5;
export const SEQUENCE_MODES: readonly ExpectedTrajectoryMode[] = ['strict', 'unordered', 'subset', 'superset', 'ordered_subset'];

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
 * A value that is alike to itself without being read: a string, a number, a
 * boolean, null, a symbol or an absent value that is the very same one on
 * both sides. An array or an object that is the same one on both sides is
 * still read, and a function or a BigInt still written, as each was when
 * both sides were written out: what the writing met inside one, this meets.
 */
function sameWithoutReading(value: unknown): boolean {
  return value === null || (typeof value !== 'object' && typeof value !== 'function' && typeof value !== 'bigint');
}

/**
 * Whether two values are written alike when one of them is a function or a
 * BigInt, by what JSON writes of it.
 *
 * JSON writes a function or a BigInt in one step. When both values are one,
 * their two texts are compared, the first's written first, as they always
 * were. When one is, its text is written, and the other value is not: a
 * function with no toJSON is written as `null`, which is what every
 * function a request can bring here is written as, and whether the other
 * value is written as `null` too is asked of its kind. Only when a toJSON
 * gave some other text, which no request can bring about, is the other
 * value written out to be compared with it, as both always were.
 */
function alikeLeftToTheWriting(x: unknown, y: unknown): boolean {
  const xLeft = leftToTheWriting(x);
  if (xLeft && leftToTheWriting(y)) return (JSON.stringify(x) ?? 'null') === (JSON.stringify(y) ?? 'null');
  const text = JSON.stringify(xLeft ? x : y) ?? 'null';
  const other = xLeft ? y : x;
  if (text === 'null') return writtenAsNull(other);
  return stableStringify(other) === text;
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
 * An array or an object inside the two is compared where it is met, by a
 * function calling itself once for each level, as the writing called itself
 * for each level. How many levels a request may have is bounded where it
 * comes in (security.maxInputDepth, and the engine's own limit).
 */
export function writtenAlike(a: unknown, b: unknown): boolean {
  if (a === b && sameWithoutReading(a)) return true;
  const pair = pairOf(a, b);
  return pair === ALIKE || (pair !== UNLIKE && alikeInside(a, b, pair));
}

/** writtenAlike of two arrays, or of two objects: what each holds, in its place, to the first difference. */
function alikeInside(a: unknown, b: unknown, pair: typeof TWO_ARRAYS | typeof TWO_OBJECTS): boolean {
  if (pair === TWO_ARRAYS) {
    const xs = a as unknown[];
    const ys = b as unknown[];
    const length = xs.length;
    // A hole is written as nothing, so an array that is one hole is written as the empty array is. No other two lengths are written alike.
    if (length !== ys.length) return length + ys.length === 1 && !(0 in (length === 1 ? xs : ys));
    for (let i = 0; i < length; i += 1) {
      const x = xs[i];
      const y = ys[i];
      if (x === y && x !== undefined && sameWithoutReading(x)) continue;
      // A hole is written as nothing and an element that is undefined as null: a hole is alike only to a hole.
      if ((x === undefined && !(i in xs)) !== (y === undefined && !(i in ys))) return false;
      const inner = pairOf(x, y);
      if (inner === UNLIKE) return false;
      if (inner !== ALIKE && !alikeInside(x, y, inner)) return false;
    }
    return true;
  }
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
    if (x === y && sameWithoutReading(x)) continue;
    const inner = pairOf(x, y);
    if (inner === UNLIKE) return false;
    if (inner !== ALIKE && !alikeInside(x, y, inner)) return false;
  }
  // And the second names no key the first does not.
  if (byKey === undefined) {
    for (; place < ye.length; place += 1) if (ye[place][1] !== undefined) return false;
    return true;
  }
  return found === byKey.size;
}

/**
 * `want` is a subset of `have`: every key of an object present with a value
 * that is itself a subset; arrays and scalars must be equal, which is to say
 * written alike by stableStringify (writtenAlike).
 *
 * Nothing a request can carry is written out to be compared. Every string,
 * number and array used to be, on both sides, at every comparison, and that
 * was most of what a comparison cost.
 *
 * The answers are the ones comparing the writings gave, for every input a
 * request can carry. Of what none carries, where writing a value out threw,
 * this can answer, as the writings would have had they been made: two
 * values that differ before a BigInt in them is reached, or before one of
 * them comes back to itself; and two values nested deeper than the writing
 * could go (this goes deeper before the stack runs out).
 *
 * An object under an expected key is asked in its turn, key by key, and the
 * first key that fails ends the comparison, as it always did: a call that
 * differs from the expected one in its first key costs one key.
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
  return holdsEach(Object.entries(want as Record<string, unknown>), have as Record<string, unknown>);
}

/**
 * Whether the step's object holds what each entry of an expected object
 * asks: the key, with a value the expected one is a subset of. The entries
 * are the expected object's own keys and their values (a key it inherits is
 * not one it names), and an entry set to undefined asks for nothing. An
 * object under a key is asked by this function calling itself, as isSubset
 * always called itself for one.
 */
function holdsEach(entries: ReadonlyArray<[string, unknown]>, h: Record<string, unknown>): boolean {
  for (let n = 0; n < entries.length; n += 1) {
    const entry = entries[n];
    const v = entry[1];
    if (v === undefined) continue;
    const k = entry[0];
    if (!(k in h)) return false;
    const x = h[k];
    if (v === x && sameWithoutReading(v)) continue;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      // An expected object is a subset of nothing but an object.
      if (x === null || typeof x !== 'object' || Array.isArray(x)) return false;
      if (!holdsEach(Object.entries(v as Record<string, unknown>), x as Record<string, unknown>)) return false;
    } else if (!writtenAlike(v, x)) return false;
  }
  return true;
}

/** Does an actual step satisfy an expected call? The name must match; the input only when the expectation carries one. */
export function callMatches(step: Step, expected: ExpectedToolCall, args: ExpectedArgsMode): boolean {
  if (step.name !== expected.tool_name) return false;
  if (expected.input === undefined) return true;
  return args === 'exact' ? normaliseInput(step.input) === normaliseInput(expected.input) : isSubset(expected.input, step.input);
}

const describeExpected = (e: ExpectedToolCall): string => (e.input === undefined ? e.tool_name : `${e.tool_name}(${describeInput(e.input)})`);

/**
 * A one-to-one matching of expected calls onto actual steps. Expectations
 * that name arguments are placed first: an expectation without arguments
 * accepts any call of that name, so letting it go first could take the
 * one call a stricter expectation needed.
 */
function consume(expected: readonly ExpectedToolCall[], steps: readonly Step[], args: ExpectedArgsMode): { matchedExpected: Set<number>; matchedSteps: Set<number> } {
  const matchedExpected = new Set<number>();
  const matchedSteps = new Set<number>();
  const order = expected.map((_, i) => i).sort((a, b) => Number(expected[b].input !== undefined) - Number(expected[a].input !== undefined) || a - b);
  for (const i of order) {
    for (let j = 0; j < steps.length; j += 1) {
      if (matchedSteps.has(j)) continue;
      if (callMatches(steps[j], expected[i], args)) {
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
  if (mode === 'strict') {
    const misplaced = expected.findIndex((e, k) => k >= steps.length || !callMatches(steps[k], e, args));
    const extra = steps.length > expected.length ? steps.slice(expected.length).map((s) => s.index) : [];
    const matched = expected.filter((e, k) => k < steps.length && callMatches(steps[k], e, args)).length;
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
    for (let j = 0; j < steps.length && i < expected.length; j += 1) if (callMatches(steps[j], expected[i], args)) i += 1;
    if (i === expected.length) return { passed: true, matched: i, why: '', unexpected: [], missing: [] };
    const present = consume(expected, steps, args).matchedExpected.has(i);
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
  const { matchedExpected, matchedSteps } = consume(expected, steps, args);
  const missing = expected.filter((_, i) => !matchedExpected.has(i));
  const unexpectedSteps = steps.filter((_, j) => !matchedSteps.has(j));
  if (mode === 'subset') {
    // Set semantics: every expected call has SOME matching actual call.
    const absent = expected.filter((e) => !steps.some((s) => callMatches(s, e, args)));
    return absent.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length - absent.length, why: `${absent.length} of ${expected.length} expected calls never came (first: ${describeExpected(absent[0])})`, unexpected: [], missing: absent };
  }
  if (mode === 'superset') {
    // Set semantics: every actual call matches SOME expected call.
    const outside = steps.filter((s) => !expected.some((e) => callMatches(s, e, args)));
    return outside.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length, why: `${outside.length} call${outside.length === 1 ? '' : 's'} outside the expected set (first: #${outside[0].index} ${outside[0].name})`, unexpected: outside.map((s) => s.index), missing: [] };
  }
  // unordered: equal as multisets — every expected call consumed by a distinct actual, and no actual left over.
  if (missing.length === 0 && unexpectedSteps.length === 0) return { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] };
  const why =
    missing.length > 0
      ? `${missing.length} of ${expected.length} expected calls never came (first: ${describeExpected(missing[0])})`
      : `${unexpectedSteps.length} call${unexpectedSteps.length === 1 ? '' : 's'} beyond the expected set (first: #${unexpectedSteps[0].index} ${unexpectedSteps[0].name})`;
  return { passed: false, matched: expected.length - missing.length, why, unexpected: unexpectedSteps.map((s) => s.index), missing };
}

const modeOf = (raw: unknown): ExpectedTrajectoryMode => (typeof raw === 'string' && (SEQUENCE_MODES as readonly string[]).includes(raw) ? (raw as ExpectedTrajectoryMode) : DEFAULT_SEQUENCE_MODE);
const argsOf = (raw: unknown): ExpectedArgsMode => (raw === 'exact' ? 'exact' : DEFAULT_ARGS_MODE);

function skipWithoutExpectation(ruleName: string, what: string): RuleAnswer {
  return {
    ruleName,
    passed: false,
    score: 0,
    skipped: true,
    skipClass: 'not_applicable',
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
  evaluate(context: EvalContext): RuleAnswer {
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
  evaluate(context: EvalContext): RuleAnswer {
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
