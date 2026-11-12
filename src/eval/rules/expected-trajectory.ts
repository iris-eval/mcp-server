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

/** `want` is a subset of `have`: every key of an object present with a value that is itself a subset; arrays and scalars must be equal. */
export function isSubset(want: unknown, have: unknown): boolean {
  // Two strings, two finite numbers or two booleans are equal as written exactly when they are equal: no need to write either out, which for a long string cost its length at every comparison.
  if (typeof want === 'string' && typeof have === 'string') return want === have;
  if (typeof want === 'number' && typeof have === 'number' && Number.isFinite(want) && Number.isFinite(have)) return want === have;
  if (typeof want === 'boolean' && typeof have === 'boolean') return want === have;
  if (want === null || typeof want !== 'object' || Array.isArray(want)) return stableStringify(want) === stableStringify(have);
  if (have === null || typeof have !== 'object' || Array.isArray(have)) return false;
  const h = have as Record<string, unknown>;
  return Object.entries(want as Record<string, unknown>).every(([k, v]) => v === undefined || (k in h && isSubset(v, h[k])));
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
 * The answers are callMatches'. What differs is the work: each input is
 * normalised once, and an expected call is asked only of the steps of its
 * tool. Asked of every step, with both inputs normalised again at every
 * question, 500 expected calls against a run of 10,000 took 9 s of CPU, and
 * 68 s with inputs of a thousand characters; the list the rules read was
 * 500 calls long then, and held it to a twentieth of that.
 */
interface Matching {
  /** Does step `j` satisfy expected call `i`? */
  matches(j: number, i: number): boolean;
  /** Where each tool's steps stand in the run, in order. */
  stepsOf(tool: string): readonly number[];
  /** Which expected calls name each tool, in order. */
  expectedOf(tool: string): readonly number[];
}
const NONE: readonly number[] = [];
function matchingOf(expected: readonly ExpectedToolCall[], steps: readonly Step[], args: ExpectedArgsMode): Matching {
  const stepInput: Array<string | undefined> = new Array<string | undefined>(steps.length);
  const expectedInput: Array<string | undefined> = new Array<string | undefined>(expected.length);
  const byTool = (names: readonly string[]): Map<string, number[]> => {
    const at = new Map<string, number[]>();
    for (const [index, name] of names.entries()) {
      const list = at.get(name);
      if (list === undefined) at.set(name, [index]);
      else list.push(index);
    }
    return at;
  };
  const stepsAt = byTool(steps.map((s) => s.name));
  const expectedAt = byTool(expected.map((e) => e.tool_name));
  return {
    matches(j, i) {
      const e = expected[i];
      if (steps[j].name !== e.tool_name) return false;
      if (e.input === undefined) return true;
      if (args !== 'exact') return isSubset(e.input, steps[j].input);
      return (stepInput[j] ??= normaliseInput(steps[j].input)) === (expectedInput[i] ??= normaliseInput(e.input));
    },
    stepsOf: (tool) => stepsAt.get(tool) ?? NONE,
    expectedOf: (tool) => expectedAt.get(tool) ?? NONE,
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
}

/** The comparison, by mode. Pure, so the corpus and the unit tests can call it directly. */
export function compareSequence(expected: readonly ExpectedToolCall[], steps: readonly Step[], mode: ExpectedTrajectoryMode, args: ExpectedArgsMode): SequenceOutcome {
  const matching = matchingOf(expected, steps, args);
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
    const present = consume(expected, matching).matchedExpected.has(i);
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
    const absent = expected.filter((e, i) => !matching.stepsOf(e.tool_name).some((j) => matching.matches(j, i)));
    return absent.length === 0
      ? { passed: true, matched: expected.length, why: '', unexpected: [], missing: [] }
      : { passed: false, matched: expected.length - absent.length, why: `${absent.length} of ${expected.length} expected calls never came (first: ${describeExpected(absent[0])})`, unexpected: [], missing: absent };
  }
  if (mode === 'superset') {
    // Set semantics: every actual call matches SOME expected call.
    const outside = steps.filter((s, j) => !matching.expectedOf(s.name).some((i) => matching.matches(j, i)));
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
    'The calls the caller expected against the calls the agent made, in a mode: strict (equal, in order), unordered (equal as multisets), subset (every expected call present), superset (no call outside the expected set) or ordered_subset (the expected calls appear in order among the actual ones — the default; two pointers, linear time). A call matches by tool name, and by arguments only when the expectation names an input: exact compares the normalised input, subset (the default) asks that every expected key be present with the same value. Fails naming the first missing, extra or misplaced call. An explicit empty list of tool calls is judged as no calls made, which fails an expectation of calls. Skips when no tool calls were sent at all, or without expected_trajectory.tool_calls. It reads a run of up to 10,000 tool calls whole. Of a longer run it reports what the calls read settle (more calls than a strict or unordered expectation holds, a call out of place or outside a superset, a subset or ordered subset already satisfied), and is otherwise not judged',
  evalType: 'completeness',
  weight: 1,
  kind: 'policy',
  mechanism: 'formula',
  needs: ['tool_calls', 'expected_trajectory'],
  expects: (context) => (context.expectedTrajectory?.tool_calls?.length ?? 0) > 0,
  question: 'complete',
  classes: ['wrong_trajectory'],
  // 2 (0.20.0): an explicit empty list of tool calls is judged against the expectation instead of skipped.
  // 3: compares the whole run where it compared the first 500 calls; of a run it read in part it reports what the calls read settle, and is otherwise not judged (#1013).
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
