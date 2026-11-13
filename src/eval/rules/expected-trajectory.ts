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
import { notJudgedPastCeiling, stepScopeNote, stepStatsOf, stepsOf, trajectoryAbsence } from '../steps.js';
import { describeInput, normaliseInput, skipWithoutTrajectory, stableStringify } from './trajectory.js';

export const DEFAULT_SEQUENCE_MODE: ExpectedTrajectoryMode = 'ordered_subset';
export const DEFAULT_ARGS_MODE: ExpectedArgsMode = 'subset';
export const DEFAULT_STEP_TOLERANCE = 1.5;
export const SEQUENCE_MODES: readonly ExpectedTrajectoryMode[] = ['strict', 'unordered', 'subset', 'superset', 'ordered_subset'];

/**
 * A value as stableStringify writes it, written once for each object or
 * array it is asked of. An expectation's arrays are compared with every
 * step's: written out again at each comparison, 500 expected calls whose
 * input is an array of 130 numbers cost 47 s of CPU against 10,000 steps.
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
 * Values one comparison of an expectation with a run compares before it
 * stops, in the modes that ask an expected call of many steps.
 *
 * An expected object is a subset of a step's input or it is not, and
 * finding out reads the keys they agree in. So a request can be built whose
 * cost is the expected calls times the steps times the keys: 500 expected
 * objects of 40 keys against 1,800 steps that agree with each in every key
 * but the last, a request of 858,000 bytes, was 37 million comparisons and
 * 1.6 s of CPU. Nothing reads such a pair faster than key by key, so the work has a
 * limit instead, as the search for a recovery has (trajectory.ts,
 * RECOVERY_SEARCH_BUDGET), and a comparison that reaches it is not judged.
 * 500 expected calls against 10,000 steps that agree with none of them in
 * the first key they name is 10 million.
 */
export const SEQUENCE_COMPARISON_BUDGET = 20_000_000;

/** One comparison of an expectation with a run: how many more values it may compare (below zero, it has stopped), and what each expected object asks for, listed once. */
export interface ComparisonWork {
  left: number;
  asked?: WeakMap<object, { keys: string[]; values: unknown[] }>;
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
 * unequal by their kinds; two of one kind are compared as they are. An
 * expected string of 1,400 characters, written out at every comparison with
 * a step whose input was a number, cost 4.4 s of CPU against 10,000 steps.
 *
 * With `work`, each value compared is counted against it, and the answer is
 * false once it has run out: the caller reads `work.left < 0` and knows the
 * answer was not settled.
 */
export function isSubset(want: unknown, have: unknown, written: (value: unknown) => string = stableStringify, work?: ComparisonWork): boolean {
  if (work !== undefined && (work.left -= 1) < 0) return false;
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
      // An array is written as an array of its length: anything else is unequal before either is written out.
      if (Array.isArray(want)) return Array.isArray(have) && have.length === want.length && written(want) === written(have);
      if (have === null || typeof have !== 'object' || Array.isArray(have)) return false;
      const h = have as Record<string, unknown>;
      const w = want as Record<string, unknown>;
      const asked = work?.asked;
      if (asked === undefined) {
        // The object's own keys, read in place: listed into an array of pairs at every comparison, they were most of what a comparison of two small objects cost.
        for (const k in w) {
          if (!Object.hasOwn(w, k)) continue;
          const v = w[k];
          if (v !== undefined && !(k in h && isSubset(v, h[k], written, work))) return false;
        }
        return true;
      }
      // The same keys, listed once for the many steps an expected object is asked of: its own, and not one set to undefined.
      let own = asked.get(w);
      if (own === undefined) {
        const keys = Object.keys(w).filter((k) => w[k] !== undefined);
        own = { keys, values: keys.map((k) => w[k]) };
        asked.set(w, own);
      }
      const { keys, values } = own;
      for (let n = 0; n < keys.length; n += 1) {
        const k = keys[n];
        const held = h[k];
        if ((held === undefined && !(k in h)) || !isSubset(values[n], held, written, work)) return false;
      }
      return true;
    }
    default:
      break;
  }
  // `want` is written `null`, and so must `have` be.
  return writtenAsNull(have);
}

/** Does an actual step satisfy an expected call? The name must match; the input only when the expectation carries one. */
export function callMatches(step: Step, expected: ExpectedToolCall, args: ExpectedArgsMode): boolean {
  if (step.name !== expected.tool_name) return false;
  if (expected.input === undefined) return true;
  return args === 'exact' ? normaliseInput(step.input) === normaliseInput(expected.input) : isSubset(expected.input, step.input);
}

const describeExpected = (e: ExpectedToolCall): string => (e.input === undefined ? e.tool_name : `${e.tool_name}(${describeInput(e.input)})`);

/**
 * callMatches for one comparison of an expectation with a run, asked by
 * position.
 *
 * The answers are callMatches'. What differs is the work: an expected call
 * is asked only of the steps of its tool. Under `exact` each input is
 * normalised once. Under `subset` nothing but an array is written out to be
 * compared, and an array once (writtenOnce); the keys an expected object
 * asks for are listed once. Asked of every step, with both inputs
 * normalised again at every question, 500 expected calls against a run of
 * 10,000 took 9 s of CPU and 68 s with inputs of a thousand characters;
 * under `subset`, 47 s with inputs that are arrays of 130 numbers, and 9 to
 * 17 s with an expected input that is a string against steps whose input
 * is anything else. The list the rules read was 500 calls long then, and
 * held it to a twentieth of that.
 *
 * What is left is what no reading makes cheaper: two objects are compared
 * key by key. So the values compared are counted against `budget`
 * (SEQUENCE_COMPARISON_BUDGET). Once it is spent every question is answered
 * no, and `stopped` says the answers since are not answers.
 */
interface Matching {
  /** Does step `j` satisfy expected call `i`? */
  matches(j: number, i: number): boolean;
  /** Where each tool's steps stand in the run, in order. */
  stepsOf(tool: string): readonly number[];
  /** The comparison reached its limit of work. */
  stopped(): boolean;
}
const NONE: readonly number[] = [];
function matchingOf(expected: readonly ExpectedToolCall[], steps: readonly Step[], args: ExpectedArgsMode, budget: number): Matching {
  const stepInput: Array<string | undefined> = new Array<string | undefined>(steps.length);
  const expectedInput: Array<string | undefined> = new Array<string | undefined>(expected.length);
  const stepsAt = new Map<string, number[]>();
  for (const [index, step] of steps.entries()) {
    const list = stepsAt.get(step.name);
    if (list === undefined) stepsAt.set(step.name, [index]);
    else list.push(index);
  }
  const written = writtenOnce();
  const work: ComparisonWork = { left: budget, asked: new WeakMap() };
  return {
    matches(j, i) {
      const e = expected[i];
      if (steps[j].name !== e.tool_name) return false;
      if (e.input === undefined) return true;
      if (work.left < 0) return false;
      if (args !== 'exact') return isSubset(e.input, steps[j].input, written, work);
      work.left -= 1;
      return (stepInput[j] ??= normaliseInput(steps[j].input)) === (expectedInput[i] ??= normaliseInput(e.input));
    },
    stepsOf: (tool) => stepsAt.get(tool) ?? NONE,
    stopped: () => work.left < 0,
  };
}

/**
 * A one-to-one matching of expected calls onto actual steps. Expectations
 * that name arguments are placed first: an expectation without arguments
 * accepts any call of that name, so letting it go first could take the
 * one call a stricter expectation needed.
 */
function consume(expected: readonly ExpectedToolCall[], matching: Matching): { matchedExpected: Set<number>; matchedSteps: Set<number> } {
  const matchedExpected = new Set<number>();
  const matchedSteps = new Set<number>();
  const order = expected.map((_, i) => i).sort((a, b) => Number(expected[b].input !== undefined) - Number(expected[a].input !== undefined) || a - b);
  for (const i of order) {
    for (const j of matching.stepsOf(expected[i].tool_name)) {
      if (matchedSteps.has(j)) continue;
      if (matching.matches(j, i)) {
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
  /** The comparison reached its limit of work (SEQUENCE_COMPARISON_BUDGET) before the answer was settled: nothing else here is one. */
  undecided?: true;
}

/**
 * The comparison, by mode. Pure, so the corpus and the unit tests can call it directly.
 *
 * `budget` is how many values it may compare. The two modes that walk the
 * run once (strict, ordered_subset) settle their answer in a number of
 * comparisons the size of the request bounds; the three that ask an expected
 * call of many steps can be built to need the product of the two, and past
 * the budget give `undecided`.
 */
export function compareSequence(expected: readonly ExpectedToolCall[], steps: readonly Step[], mode: ExpectedTrajectoryMode, args: ExpectedArgsMode, budget: number = SEQUENCE_COMPARISON_BUDGET): SequenceOutcome {
  const matching = matchingOf(expected, steps, args, budget);
  const outcome = comparedBy(expected, steps, mode, matching, () => matchingOf(expected, steps, args, budget));
  return matching.stopped() ? { passed: false, matched: 0, why: '', unexpected: [], missing: [], undecided: true } : outcome;
}

function comparedBy(expected: readonly ExpectedToolCall[], steps: readonly Step[], mode: ExpectedTrajectoryMode, matching: Matching, again: () => Matching): SequenceOutcome {
  if (mode === 'strict') {
    const misplaced = expected.findIndex((_, k) => k >= steps.length || !matching.matches(k, k));
    const extra = steps.length > expected.length ? steps.slice(expected.length).map((s) => s.index) : [];
    const matched = expected.filter((_, k) => k < steps.length && matching.matches(k, k)).length;
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
    for (let j = 0; j < steps.length && i < expected.length; j += 1) if (matching.matches(j, i)) i += 1;
    if (i === expected.length) return { passed: true, matched: i, why: '', unexpected: [], missing: [] };
    // The finding is settled. Whether the call came at all, somewhere out of order, only words it: that is asked with work of its own, and left unsaid when the work runs out.
    const elsewhere = again();
    const present = consume(expected, elsewhere).matchedExpected.has(i);
    const how = elsewhere.stopped() ? 'did not come in order' : present ? 'came out of order' : 'never came';
    return {
      passed: false,
      matched: i,
      why: `expected call ${i + 1} of ${expected.length}, ${describeExpected(expected[i])}, ${how} (${i} of ${expected.length} in order)`,
      unexpected: [],
      missing: expected.slice(i),
    };
  }
  if (mode === 'subset') {
    // Set semantics: every expected call has SOME matching actual call.
    const absent = expected.filter((e, i) => !matching.stepsOf(e.tool_name).some((j) => matching.matches(j, i)));
    return absent.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length - absent.length, why: `${absent.length} of ${expected.length} expected calls never came (first: ${describeExpected(absent[0])})`, unexpected: [], missing: absent };
  }
  if (mode === 'superset') {
    // Set semantics: every actual call matches SOME expected call. Asked one expected call at a time, of the steps of its tool that nothing has matched yet. Asked a step at a time, every comparison read a different expected object, and the same count of comparisons cost two to four times what `subset` pays for it: 1.3 to 2.9 s of CPU at the limit of work.
    const inside = new Uint8Array(steps.length);
    for (const [i, e] of expected.entries()) for (const j of matching.stepsOf(e.tool_name)) if (inside[j] === 0 && matching.matches(j, i)) inside[j] = 1;
    const outside = steps.filter((_, j) => inside[j] === 0);
    return outside.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length, why: `${outside.length} call${outside.length === 1 ? '' : 's'} outside the expected set (first: #${outside[0].index} ${outside[0].name})`, unexpected: outside.map((s) => s.index), missing: [] };
  }
  // unordered: equal as multisets — every expected call consumed by a distinct actual, and no actual left over.
  const { matchedExpected, matchedSteps } = consume(expected, matching);
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
    'The calls the caller expected against the calls the agent made, in a mode: strict (equal, in order), unordered (equal as multisets), subset (every expected call present), superset (no call outside the expected set) or ordered_subset (the expected calls appear in order among the actual ones — the default; two pointers, linear time). A call matches by tool name, and by arguments only when the expectation names an input: exact compares the normalised input, subset (the default) asks that every expected key be present with the same value. Fails naming the first missing, extra or misplaced call. An explicit empty list of tool calls is judged as no calls made, which fails an expectation of calls. Skips when no tool calls were sent at all, or without expected_trajectory.tool_calls. It reads a run of up to 10,000 tool calls whole. Of a longer run it reports what the calls read settle (more calls than a strict or unordered expectation holds, a call out of place or outside a superset, a subset or ordered subset already satisfied), and is otherwise not judged. The modes that ask an expected call of many steps (subset, superset, unordered) compare up to 20,000,000 values between the expectation and the run, and a comparison that needs more is not judged',
  evalType: 'completeness',
  weight: 1,
  kind: 'policy',
  mechanism: 'formula',
  needs: ['tool_calls', 'expected_trajectory'],
  expects: (context) => (context.expectedTrajectory?.tool_calls?.length ?? 0) > 0,
  question: 'complete',
  classes: ['wrong_trajectory'],
  // 2 (0.20.0): an explicit empty list of tool calls is judged against the expectation instead of skipped.
  // 3: compares the whole run where it compared the first 500 calls; of a run it read in part it reports what the calls read settle, and is otherwise not judged; a comparison in subset, superset or unordered mode stops at 20,000,000 values compared and is then not judged (#1013).
  version: 3,
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
    let outcome = compareSequence(expected, steps, mode, args);
    /*
     * A strict or an unordered expectation holds as many calls as the run
     * made, or the two differ: the count settles that with no comparison.
     * Asked only when the comparison stopped at its limit of work, so that a
     * finding the comparison did reach is worded as it always was.
     */
    const madeInAll = stepStatsOf(context).available;
    if (outcome.undecided === true && (mode === 'strict' || mode === 'unordered') && madeInAll !== expected.length) {
      outcome = {
        passed: false,
        matched: outcome.matched,
        unexpected: outcome.unexpected,
        missing: outcome.missing,
        why:
          madeInAll > expected.length
            ? `the run made ${madeInAll} calls and ${expected.length} ${expected.length === 1 ? 'was' : 'were'} expected, so ${madeInAll - expected.length} are beyond the expected ${mode === 'strict' ? 'sequence' : 'set'}`
            : `the run made ${madeInAll} call${madeInAll === 1 ? '' : 's'} and ${expected.length} were expected, so ${expected.length - madeInAll} expected call${expected.length - madeInAll === 1 ? '' : 's'} never came`,
      };
    }
    // A comparison built to cost the expected calls times the steps times the keys they agree in stops at its limit of work: neither a pass nor a finding.
    if (outcome.undecided === true) {
      const compared = `the ${expected.length} expected call${expected.length === 1 ? '' : 's'} with the ${steps.length} ${stepStatsOf(context).kept < stepStatsOf(context).available ? 'read' : 'made'}`;
      return {
        ruleName: 'tool_sequence',
        passed: false,
        score: 0,
        skipped: true,
        evidenceIncomplete: true,
        skipReason: `partial_search: comparing ${compared} was not settled`,
        message: `Not judged: comparing ${compared} (${mode}, args ${args}) was not settled inside the rule's limit of work, ${SEQUENCE_COMPARISON_BUDGET.toLocaleString('en-US')} values compared`,
      };
    }
    /*
     * A run longer than the list the rules read (steps.ts). What the calls
     * read settle stands, and the rest is not judged:
     *
     *   strict, unordered   a run with more calls than were expected differs
     *                       from the expectation whatever the rest are, and
     *                       so does a call out of place among those read;
     *   superset            a call outside the expected set, once read, is
     *                       outside it; none among those read says nothing
     *                       of the rest;
     *   subset, ordered_subset   satisfied among the calls read, no later
     *                       call can unsatisfy it; an expected call not yet
     *                       seen may be among the rest.
     */
    const stats = stepStatsOf(context);
    const scope = stepScopeNote(context);
    if (stats.kept < stats.available) {
      const made = stats.available;
      let settled: boolean;
      if (mode === 'strict' || mode === 'unordered') {
        // In strict mode the first call out of place, when it is among those read, is the finding compareSequence already names.
        const misplacedAmongRead = mode === 'strict' && expected.some((e, k) => k < steps.length && !callMatches(steps[k], e, args));
        settled = misplacedAmongRead || made > expected.length;
        if (settled && !misplacedAmongRead) {
          // The count alone decides, and it is the run's own: what the calls not read are does not matter.
          outcome = { ...outcome, passed: false, why: `the run made ${made} calls and ${expected.length} ${expected.length === 1 ? 'was' : 'were'} expected, so ${made - expected.length} are beyond the expected ${mode === 'strict' ? 'sequence' : 'set'}` };
        }
      } else if (mode === 'superset') {
        settled = !outcome.passed;
      } else {
        settled = outcome.passed;
      }
      if (!settled) {
        return notJudgedPastCeiling(
          'tool_sequence',
          context,
          mode === 'superset'
            ? 'No call outside the expected set was found among them, and the rest were not read'
            : mode === 'strict' || mode === 'unordered'
              ? 'The calls read fit the expectation so far, and it has more calls than were read'
              : `${outcome.missing.length} expected call${outcome.missing.length === 1 ? ' was' : 's were'} not found among them, and may be among the rest`,
        )!;
      }
    }
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
        ? `${expected.length} expected call${expected.length === 1 ? '' : 's'} satisfied by the ${steps.length} ${scope === '' ? 'made' : 'read'} (${mode}, args ${args})${scope}`
        : `Trajectory differs from the expected (${mode}, args ${args}): ${outcome.why}${scope}`,
    };
  },
};

export const stepBudget: EvalRule = {
  name: 'step_budget',
  description:
    'A task must finish within ITS budget: the number of tool calls made against expected_trajectory.step_budget (or the number of expected calls when only tool_calls was given) times a tolerance (expected_trajectory.tolerance, default 1.5) — fails when calls exceed budget × tolerance, naming the overrun. Where max_steps is one deployment-wide ceiling, this is the budget the caller states for one task. An explicit empty list of tool calls is judged as zero calls. Skips when no tool calls were sent at all, or without an expectation. The count is of the calls the run made, whatever its length',
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
  // 3: counts the calls the run made; counted from the list the rules read, no run was longer than 500 (#1013).
  version: 3,
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
    // The number of calls the run made, not the number the rules read: a count needs no reading (cost.ts, max_steps).
    const calls = Math.max(stepsOf(context).length, stepStatsOf(context).available);
    const passed = calls <= ceiling;
    return {
      ruleName: 'step_budget',
      passed,
      score: passed ? 1 : Math.max(0, ceiling / calls),
      value: { stat: 'tool_calls', unit: 'calls', value: calls },
      evidence: [{ type: 'count', stat: 'tool_calls', unit: 'calls', value: calls, threshold: ceiling, thresholdSource: 'call' }],
      message: passed
        ? `${calls} tool call${calls === 1 ? '' : 's'} against a budget of ${budget} × ${tolerance} = ${ceiling}`
        : `Step budget: ${calls} tool calls exceeds ${budget} × ${tolerance} = ${ceiling} (${calls - Math.floor(ceiling)} over)`,
    };
  },
};
