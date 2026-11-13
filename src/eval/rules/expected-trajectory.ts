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
 * A value as stableStringify writes it, written once for each object or
 * array it is asked of. An expectation's arrays are compared with every
 * step's, and were written out again at each comparison: 500 expected calls
 * whose input is an array of 80 numbers took 3.2 to 6.5 s of CPU against a
 * run of 500 calls, and take 0.03 s.
 *
 * What it has written it holds for as long as the function is held: it is
 * made for one comparison and dropped with it.
 */
export function writtenOnce(): (value: unknown) => string {
  const memo = new WeakMap<object, string>();
  return (value) => {
    if (value === null || typeof value !== 'object') return stableStringify(value);
    let text = memo.get(value);
    if (text === undefined) {
      text = stableStringify(value);
      memo.set(value, text);
    }
    return text;
  };
}

/** Whether stableStringify writes a value as `null`: null itself, a value that is absent, a number that is not finite, and what JSON has no writing for. */
function writtenAsNull(value: unknown): boolean {
  return value === null || value === undefined || (typeof value === 'number' && !Number.isFinite(value)) || typeof value === 'symbol' || typeof value === 'function';
}

/**
 * `want` is a subset of `have`: every key of an object present with a value
 * that is itself a subset; arrays and scalars must be equal, which is to say
 * written alike by stableStringify. `written` is how an array is written out
 * to be compared (writtenOnce, for many comparisons of the same values).
 *
 * Nothing but an array is written out to be compared. Two values of
 * different kinds are never written alike (a string is written in quotation
 * marks, a finite number in digits, a boolean as a word, an array in square
 * brackets, an object in braces, and the rest as `null`), so they are
 * unequal by their kinds, and two of one kind are compared as they are.
 * Every string and number used to be written out on both sides at every
 * comparison, which was most of what a comparison cost: 500 expected calls
 * of 96 keys against 500 calls that agree with each in every key but the
 * last took 6 to 12 s of CPU, and take half a second.
 *
 * The answers are the ones writing every value out gave, for every value a
 * request can carry. A BigInt and an array with a hole in it are not among
 * those: JSON has no writing for either.
 */
export function isSubset(want: unknown, have: unknown, written: (value: unknown) => string = stableStringify): boolean {
  switch (typeof want) {
    case 'string':
    case 'boolean':
      // Written alike only by the same string, the same boolean.
      return want === have;
    case 'number':
      if (Number.isFinite(want)) return want === have;
      break;
    case 'bigint':
      // What cannot be written out is left to the writing, which says so.
      return written(want) === written(have);
    case 'object': {
      if (want === null) break;
      // An array is written as an array of its length: anything else is unequal before either is written out, and two empty arrays are equal without being.
      if (Array.isArray(want)) return Array.isArray(have) && have.length === want.length && (want.length === 0 || written(want) === written(have));
      if (have === null || typeof have !== 'object' || Array.isArray(have)) return false;
      const h = have as Record<string, unknown>;
      const w = want as Record<string, unknown>;
      // The object's own keys: a key it inherits is not one it names, and a key set to undefined asks for nothing.
      for (const k in w) {
        if (!Object.hasOwn(w, k)) continue;
        const v = w[k];
        if (v !== undefined && !(k in h && isSubset(v, h[k], written))) return false;
      }
      return true;
    }
    default:
      break;
  }
  // `want` is written `null`, and so must `have` be.
  return writtenAsNull(have);
}

/** What an expected input that is an object asks for, listed once for the many steps it is asked of: its own keys that are not set to undefined, and their values, each read once. */
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
function listedIsSubset(own: Listed, have: unknown, written: (value: unknown) => string): boolean {
  if (have === null || typeof have !== 'object' || Array.isArray(have)) return false;
  const h = have as Record<string, unknown>;
  const { keys, values } = own;
  for (let n = 0; n < keys.length; n += 1) {
    const k = keys[n];
    const held = h[k];
    // A key the step holds with no value is a key it holds.
    if ((held === undefined && !(k in h)) || !isSubset(values[n], held, written)) return false;
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

/** Does step `j` satisfy expected call `i`? callMatches for one comparison of an expectation with a run, asked by position. */
type Matches = (j: number, i: number) => boolean;

/** An expected call that has put one question about its input, and for which nothing has been listed yet. */
const ASKED_ONCE: Listed = { keys: [], values: [] };

/**
 * callMatches for one comparison of an expectation with a run.
 *
 * The answers are callMatches'. What differs is the work, done once where it
 * was done again at every question. Under `exact` each input is normalised
 * once: 500 expected calls against 500 calls with inputs of a thousand
 * characters took 4.2 to 8.7 s of CPU, and take 0.03 s. Under `subset`
 * nothing but an array is written out to be compared (isSubset), an array
 * is written out once (writtenOnce), and the keys an expected input asks
 * for are listed once (Listed).
 *
 * What is kept between questions costs something to keep, so nothing is
 * kept for the first question an expected call puts under `subset`: its
 * keys are read in place and an array is written out as it stands. A run
 * that made the expected calls in order asks each of them once, and for
 * that run the keeping is all cost and no saving: with everything kept from
 * the first question, 500 expected calls whose 95 keys each hold an object,
 * made in order, took 12 to 65 ms where they take 3 to 4. For the same
 * reason nothing is made until a question needs it: an expectation of tool
 * names alone asks about no input.
 */
function matchesOf(expected: readonly ExpectedToolCall[], steps: readonly Step[], args: ExpectedArgsMode): Matches {
  if (args === 'exact') {
    let stepInput: Array<string | undefined> | undefined;
    let expectedInput: Array<string | undefined> | undefined;
    return (j, i) => {
      const e = expected[i];
      const step = steps[j];
      if (step.name !== e.tool_name) return false;
      if (e.input === undefined) return true;
      stepInput ??= new Array<string | undefined>(steps.length);
      expectedInput ??= new Array<string | undefined>(expected.length);
      return (stepInput[j] ??= normaliseInput(step.input)) === (expectedInput[i] ??= normaliseInput(e.input));
    };
  }
  /** For each expected call: nothing until it has put a question about its input, then ASKED_ONCE, and from its second question what its input asks for, listed, or null when its input is not an object. */
  let listed: Array<Listed | null | undefined> | undefined;
  /** How an array is written out from an expected call's second question on: once. */
  let written: ((value: unknown) => string) | undefined;
  return (j, i) => {
    const e = expected[i];
    const step = steps[j];
    if (step.name !== e.tool_name) return false;
    const want = e.input;
    if (want === undefined) return true;
    listed ??= new Array<Listed | null | undefined>(expected.length);
    let own = listed[i];
    if (own === undefined) {
      listed[i] = ASKED_ONCE;
      return isSubset(want, step.input);
    }
    if (own === ASKED_ONCE) own = listed[i] = want !== null && typeof want === 'object' && !Array.isArray(want) ? listedOf(want) : null;
    written ??= writtenOnce();
    return own === null ? isSubset(want, step.input, written) : listedIsSubset(own, step.input, written);
  };
}

/**
 * A one-to-one matching of expected calls onto actual steps. Expectations
 * that name arguments are placed first: an expectation without arguments
 * accepts any call of that name, so letting it go first could take the
 * one call a stricter expectation needed.
 */
function consume(expected: readonly ExpectedToolCall[], steps: readonly Step[], matches: Matches): { matchedExpected: Set<number>; matchedSteps: Set<number> } {
  const matchedExpected = new Set<number>();
  const matchedSteps = new Set<number>();
  const order = expected.map((_, i) => i).sort((a, b) => Number(expected[b].input !== undefined) - Number(expected[a].input !== undefined) || a - b);
  for (const i of order) {
    for (let j = 0; j < steps.length; j += 1) {
      if (matchedSteps.has(j)) continue;
      if (matches(j, i)) {
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
  const matches = matchesOf(expected, steps, args);
  if (mode === 'strict') {
    // Each expected call is asked of the step in its place, once: the first out of place, and how many are in theirs.
    let misplaced = -1;
    let matched = 0;
    for (let k = 0; k < expected.length; k += 1) {
      if (k < steps.length && matches(k, k)) matched += 1;
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
    for (let j = 0; j < steps.length && i < expected.length; j += 1) if (matches(j, i)) i += 1;
    if (i === expected.length) return { passed: true, matched: i, why: '', unexpected: [], missing: [] };
    const present = consume(expected, steps, matches).matchedExpected.has(i);
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
    const absent = expected.filter((_, i) => !steps.some((_step, j) => matches(j, i)));
    return absent.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length - absent.length, why: `${absent.length} of ${expected.length} expected calls never came (first: ${describeExpected(absent[0])})`, unexpected: [], missing: absent };
  }
  if (mode === 'superset') {
    // Set semantics: every actual call matches SOME expected call. Asked one expected call at a time, of the steps no expected call has matched yet.
    const inside: boolean[] = new Array<boolean>(steps.length).fill(false);
    for (let i = 0; i < expected.length; i += 1) for (let j = 0; j < steps.length; j += 1) if (!inside[j] && matches(j, i)) inside[j] = true;
    const outside = steps.filter((_, j) => !inside[j]);
    return outside.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length, why: `${outside.length} call${outside.length === 1 ? '' : 's'} outside the expected set (first: #${outside[0].index} ${outside[0].name})`, unexpected: outside.map((s) => s.index), missing: [] };
  }
  // unordered: equal as multisets — every expected call consumed by a distinct actual, and no actual left over.
  const { matchedExpected, matchedSteps } = consume(expected, steps, matches);
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
