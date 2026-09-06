import { MAX_EVIDENCE_ITEMS, type EvalRule, type EvalContext, type EvalRuleResult, type Evidence } from '../../types/eval.js';
import { describeInput, longestCycle, looksLikePolling, skipWithoutTrajectory, stepKey, targetKey } from './trajectory.js';
import { stepScopeNote, stepsOf } from '../steps.js';
import { READ_TOKENS, catalogueIndex } from '../catalogue.js';
import type { Step } from '../../types/trace.js';

export const costUnderThreshold: EvalRule = {
  name: 'cost_under_threshold',
  description: 'Total cost must be under a configurable USD threshold',
  evalType: 'cost',
  weight: 1,
  kind: 'policy',
  mechanism: 'formula',
  needs: ['cost'],
  question: 'within_budget',
  classes: ['over_budget'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    if (context.costUsd === undefined || context.costUsd === null) {
      return { ruleName: 'cost_under_threshold', passed: false, score: 0, message: 'Cost data not provided', skipped: true, skipReason: 'context.costUsd not provided' };
    }
    const threshold = (context.customConfig?.cost_threshold as number) ?? 0.10;
    const cost = context.costUsd;
    const passed = cost <= threshold;
    return {
      ruleName: 'cost_under_threshold',
      passed,
      score: passed ? 1 : Math.max(0, 1 - (cost - threshold) / threshold),
      value: { stat: 'cost', unit: 'usd', value: cost },
      evidence: [{ type: 'count', stat: 'cost', unit: 'usd', value: cost, threshold, thresholdSource: threshold === 0.10 ? 'default' : 'config' }],
      message: passed
        ? `Cost ($${cost.toFixed(4)}) is under threshold ($${threshold.toFixed(4)})`
        : `Cost ($${cost.toFixed(4)}) exceeds threshold ($${threshold.toFixed(4)})`,
    };
  },
};

export const verbosityRatio: EvalRule = {
  name: 'verbosity_ratio',
  description:
    'The completion-to-prompt token ratio against a ceiling: completion_tokens / prompt_tokens must not exceed max_token_ratio (default 5). This measures output VERBOSITY relative to prompt size, not efficiency — a long answer to a long prompt passes and a long answer to a short prompt fails, and neither says whether the tokens were well spent. Skipped when token usage is not supplied. Renamed from token_efficiency in 0.10.0, because the old name named something the rule does not measure',
  evalType: 'cost',
  weight: 0.5,
  kind: 'measurement',
  mechanism: 'formula',
  needs: ['tokens'],
  question: 'within_budget',
  classes: ['over_budget'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    const prompt = context.tokenUsage?.prompt_tokens;
    const completion = context.tokenUsage?.completion_tokens;
    if (prompt === undefined || completion === undefined || prompt === 0) {
      return { ruleName: 'verbosity_ratio', passed: false, score: 0, message: 'Token usage not provided', skipped: true, skipReason: 'context.tokenUsage not provided' };
    }
    const ratio = completion / prompt;
    const maxRatio = (context.customConfig?.max_token_ratio as number) ?? 5;
    const passed = ratio <= maxRatio;
    return {
      ruleName: 'verbosity_ratio',
      passed,
      score: passed ? 1 : Math.max(0, 1 - (ratio - maxRatio) / maxRatio),
      value: { stat: 'completion_to_prompt_ratio', unit: 'ratio', value: ratio },
      evidence: [{ type: 'count', stat: 'completion_to_prompt_ratio', unit: 'ratio', value: ratio, threshold: maxRatio, thresholdSource: maxRatio === 5 ? 'default' : 'config' }],
      message: passed
        ? `Token ratio (${ratio.toFixed(2)}) is within limits (max ${maxRatio})`
        : `Token ratio (${ratio.toFixed(2)}) exceeds max (${maxRatio})`,
    };
  },
};

/** Default for config key `max_tool_repeats`: how many identical calls are tolerated. */
export const DEFAULT_MAX_TOOL_REPEATS = 3;

/**
 * How many complete A,B,A,B cycles are tolerated before the alternation is
 * a loop. Three cycles is six consecutive calls that between them made two
 * distinct requests.
 */
export const MAX_TWO_CALL_CYCLES = 2;

/** Default for config key `max_target_rereads`: how many reads of one target are tolerated. */
export const DEFAULT_MAX_TARGET_REREADS = 3;

/** Longest cycle length considered. Beyond three the pattern is a plan, not a loop. */
export const MAX_CYCLE_LENGTH = 3;

/**
 * The longest repeated sequence worth reporting, at any period from 2 to 3 —
 * or null when the repetition was a POLL.
 *
 * Period 2 keeps exactly the threshold the alternating-pair detector used,
 * so no case that fired before stops firing and none starts. Period 3 is new
 * recall: A,B,C,A,B,C is a loop that the pair detector could not see.
 *
 * Period 1 is deliberately absent. The repeat COUNT above owns it and counts
 * non-consecutive repeats too, which is strictly more; a second detector of
 * the same failure class would hand the risk estimate two correlated
 * signals to multiply as though they were independent.
 */
function findCycle(keys: readonly string[], calls: readonly Step[]): { k: number; start: number; repetitions: number; gramIndices: number[] } | null {
  for (let k = 2; k <= MAX_CYCLE_LENGTH; k += 1) {
    const cycle = longestCycle(keys, k);
    if (cycle === null || cycle.repetitions <= MAX_TWO_CALL_CYCLES) continue;
    const occurrences: number[] = [];
    for (let r = 0; r < cycle.repetitions; r += 1) occurrences.push(cycle.start + r * k);
    // A regular cadence is a machine waiting, not a machine stuck. Today's
    // rule scores a wait as a loop, so this can only turn a false positive
    // into a true negative.
    if (looksLikePolling(occurrences.map((i) => calls[i]?.startedAt))) continue;
    return { k, start: cycle.start, repetitions: cycle.repetitions, gramIndices: occurrences.slice(0, 1).flatMap((s) => Array.from({ length: k }, (_, i) => s + i)) };
  }
  return null;
}

/** Reads of one target, counted across tools the catalogue calls read-only. */
function targetRereads(
  calls: readonly Step[],
  context: EvalContext,
): { worst: { key: string; count: number; indices: number[] } | null; unknownNote: string } {
  const index = catalogueIndex(context);
  if (index === null) return { worst: null, unknownNote: '' };
  const byTarget = new Map<string, number[]>();
  let readShapedByName = 0;
  for (const [at, step] of calls.entries()) {
    /*
     * The CATALOGUE must SAY read-only. `readFamilyOf` falls back to a name
     * list when it does not, which is right for describing a tool and wrong
     * for deciding one — a rule that guessed "fetch_page is a read" would
     * count a paid API call as a wasted reread on the strength of its name.
     * So this reads the annotation directly, and the name heuristic only
     * explains what was left out.
     */
    const declared = index.get(step.name)?.annotations?.readOnlyHint === true;
    if (!declared) {
      if (READ_TOKENS.some((t) => step.name.toLowerCase().includes(t))) readShapedByName += 1;
      continue;
    }
    const key = targetKey(step);
    if (key === null) continue;
    const seen = byTarget.get(key) ?? [];
    seen.push(at);
    byTarget.set(key, seen);
  }
  let worst: { key: string; count: number; indices: number[] } | null = null;
  for (const [key, indices] of byTarget) {
    if (worst === null || indices.length > worst.count) worst = { key, count: indices.length, indices };
  }
  if (worst !== null && looksLikePolling(worst.indices.map((i) => calls[i]?.startedAt))) worst = null;
  const unknownNote = readShapedByName > 0
    ? `; ${readShapedByName} more call${readShapedByName === 1 ? '' : 's'} looked read-shaped but the catalogue does not say so`
    : '';
  return { worst, unknownNote };
}

/*
 * The other half of what the trajectory shows: not a wrong answer, a wasted
 * one.
 *
 * Transcript t-16 answers the question correctly, and gets there by running
 * the identical `ls src/tools` five times with five identical results. Four
 * of those turns bought nothing, and each one resent the whole context —
 * 18,918 prompt tokens for a directory listing. cost_under_threshold cannot
 * see it: the bill still comes to $0.0621, well under the $0.10 default. The
 * loop is only visible in the sequence of calls.
 *
 * Cost, not completeness or safety, because that is where the harm lands —
 * spend and latency, on an answer that was already available. Non-critical
 * for the same reason: a repetitive agent is wasteful, not unsafe, and
 * `passed` should not be vetoed by a behavioural signal.
 */
export const noToolLoop: EvalRule = {
  name: 'no_tool_loop',
  description:
    'The agent must not repeat itself. Fails when one tool is called with an identical input (object keys sorted, whitespace collapsed) more than max_tool_repeats times — default 3, config key `max_tool_repeats` — or when two calls alternate for more than two complete A,B,A,B cycles. Reads the trajectory from tool_calls, or from OpenTelemetry TOOL spans when no tool_calls were sent; skips when neither is provided, so an evaluation with no trajectory reports "not judged" rather than clean. Catches the wasted spend a cost threshold cannot see: five identical calls can still bill under a per-evaluation cost limit',
  evalType: 'cost',
  weight: 1,
  kind: 'detection',
  mechanism: 'formula',
  needs: ['tool_calls'],
  question: 'tool_use_correct',
  classes: ['tool_loop'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    const skip = skipWithoutTrajectory('no_tool_loop', context);
    if (skip) return skip;

    const calls = stepsOf(context);
    const scope = stepScopeNote(context);
    const configured = context.customConfig?.max_tool_repeats;
    const maxRepeats =
      typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
        ? Math.floor(configured)
        : DEFAULT_MAX_TOOL_REPEATS;
    const configuredRereads = context.customConfig?.max_target_rereads;
    const maxTargetRereads =
      typeof configuredRereads === 'number' && Number.isFinite(configuredRereads) && configuredRereads >= 1
        ? Math.floor(configuredRereads)
        : DEFAULT_MAX_TARGET_REREADS;

    const keys = calls.map(stepKey);
    const counts = new Map<string, number>();
    for (const key of keys) counts.set(key, (counts.get(key) ?? 0) + 1);

    let worstKey = '';
    let worstCount = 0;
    for (const [key, count] of counts) {
      if (count > worstCount) {
        worstKey = key;
        worstCount = count;
      }
    }

    const repeatsEvidence: Evidence[] = [
      { type: 'count', stat: 'max_repeats_of_one_call', unit: 'calls', value: worstCount, threshold: maxRepeats, thresholdSource: maxRepeats === DEFAULT_MAX_TOOL_REPEATS ? 'default' : 'config' },
    ];
    /*
     * A steady cadence is a machine WAITING, not a machine stuck, and this
     * is the clause a poll actually trips: an agent watching a build calls
     * the same endpoint with the same arguments until the answer changes.
     * The check belongs on every trigger, not only the cycle one, because
     * the repeat count is what sees an unchanging call.
     */
    const worstIndices = keys.flatMap((key, index) => (key === worstKey ? [index] : []));
    const polling = worstCount > maxRepeats && looksLikePolling(worstIndices.map((i) => calls[i].startedAt));

    if (worstCount > maxRepeats && !polling) {
      const call = calls[keys.indexOf(worstKey)];
      const evidence: Evidence[] = [...repeatsEvidence];
      keys.forEach((key, index) => {
        if (key === worstKey && evidence.length < MAX_EVIDENCE_ITEMS) evidence.push({ type: 'toolCall', index, toolName: calls[index].name, label: 'repeated call' });
      });
      return {
        ruleName: 'no_tool_loop',
        passed: false,
        score: Math.max(0, 1 - (worstCount - maxRepeats) * 0.25),
        value: { stat: 'max_repeats_of_one_call', unit: 'calls', value: worstCount },
        evidence,
        message: `Tool loop: ${call.name} called ${worstCount} times with the same input — ${describeInput(call.input)} — over ${calls.length} call${calls.length === 1 ? '' : 's'} (max ${maxRepeats})${scope}`,
      };
    }

    const cycle = findCycle(keys, calls);
    if (cycle !== null) {
      const evidence: Evidence[] = [
        { type: 'count', stat: `repeats_of_a_${cycle.k}_call_sequence`, unit: 'repetitions', value: cycle.repetitions, threshold: MAX_TWO_CALL_CYCLES, thresholdSource: 'rule' },
      ];
      for (let i = cycle.start; i < keys.length && evidence.length < MAX_EVIDENCE_ITEMS; i += 1) {
        if (keys[i] === keys[cycle.start + ((i - cycle.start) % cycle.k)]) {
          evidence.push({ type: 'toolCall', index: i, toolName: calls[i].name, label: cycle.k === 2 ? 'alternating call' : 'repeated sequence' });
        }
      }
      const names = cycle.gramIndices.map((i) => `${calls[i].name} (${describeInput(calls[i].input)})`).join(', ');
      const shape = cycle.k === 2 ? `${names} alternate` : `a ${cycle.k}-call sequence — ${names} — repeats`;
      return {
        ruleName: 'no_tool_loop',
        passed: false,
        score: Math.max(0, 1 - (cycle.repetitions - MAX_TWO_CALL_CYCLES) * 0.25),
        value: { stat: 'repeated_sequences', unit: 'repetitions', value: cycle.repetitions },
        evidence,
        message: `Tool loop: ${shape} for ${cycle.repetitions} repetitions (max ${MAX_TWO_CALL_CYCLES})${scope}`,
      };
    }

    /*
     * The same TARGET read again, whatever tool did it.
     *
     * A file read through `read_file`, then `cat`, then `bash` is three
     * distinct call keys and one wasted read, so the count above cannot see
     * it. Gated on the CATALOGUE saying the tool is read-only — never on the
     * name heuristic, which appears only in the message — so this can never
     * turn a legitimate sequence of writes into a finding, and it stays
     * dormant for a caller who sends no catalogue. That is a reason to send
     * one, and `needs` is unchanged because the rule still judges without it.
     */
    const rereads = targetRereads(calls, context);
    if (rereads.worst !== null && rereads.worst.count > maxTargetRereads) {
      const { count, indices } = rereads.worst;
      const evidence: Evidence[] = [
        { type: 'count', stat: 'reads_of_one_target', unit: 'reads', value: count, threshold: maxTargetRereads, thresholdSource: maxTargetRereads === DEFAULT_MAX_TARGET_REREADS ? 'default' : 'config' },
      ];
      for (const index of indices.slice(0, MAX_EVIDENCE_ITEMS - 1)) {
        evidence.push({ type: 'toolCall', index, toolName: calls[index].name, label: 'read of the same target' });
      }
      const tools = [...new Set(indices.map((i) => calls[i].name))];
      return {
        ruleName: 'no_tool_loop',
        passed: false,
        score: Math.max(0, 1 - (count - maxTargetRereads) * 0.25),
        value: { stat: 'reads_of_one_target', unit: 'reads', value: count },
        evidence,
        message: `Tool loop: the same target was read ${count} times through ${tools.length === 1 ? tools[0] : `${tools.length} tools (${tools.join(', ')})`} (max ${maxTargetRereads})${rereads.unknownNote}${scope}`,
      };
    }

    return {
      ruleName: 'no_tool_loop',
      passed: true,
      score: 1,
      message: polling
        ? `No tool loop: ${calls[worstIndices[0]].name} ran ${worstCount}× at a regular cadence, which is polling rather than a loop — an agent waiting on something waits, and a stuck one retries as fast as it can emit (${calls.length} call${calls.length === 1 ? '' : 's'})${scope}`
        // The catalogue note belongs on a PASS as much as on a failure: a
        // clean verdict that could not see part of the trajectory has to
        // say so, which is the difference between clean and not-judged.
        : `No repeated tool call (${calls.length} call${calls.length === 1 ? '' : 's'}; most repeated ran ${worstCount}×, max ${maxRepeats})${rereads.unknownNote}${scope}`,
      value: { stat: 'max_repeats_of_one_call', unit: 'calls', value: worstCount },
      evidence: polling ? [...repeatsEvidence, { type: 'count', stat: 'regularly_spaced_repetitions', unit: 'calls', value: worstCount }] : repeatsEvidence,
    };
  },
};


/** Default for config key `max_steps`: how many tool calls a task may take. */
export const DEFAULT_MAX_STEPS = 50;

/*
 * A step budget, and the reason it is a POLICY rather than a detection.
 *
 * Fifty calls is not evidence of anything. It is a number a deployment
 * chooses because it knows what its own agents do — a research agent that
 * reads forty pages is working, and a support agent that makes forty calls
 * to answer one question is not. So the rule ADVISES at the shipped default
 * and GATES the moment the deployment sets `max_steps`, which is arc 3's
 * "a default is not your policy" costing nothing and landing exactly right:
 * `thresholdSource` on the count evidence is what compose.decides() reads.
 *
 * It still needs a family. The proof runner requires one for every rule in
 * the registry, policies included, and a policy's family measures
 * conformance to its own definition rather than the badness of an output.
 */
export const maxSteps: EvalRule = {
  name: 'max_steps',
  description:
    'A task must finish within a step budget. Fails when the trajectory carries more tool calls than `max_steps` — default 50. Reads the trajectory from tool_calls, or from OpenTelemetry TOOL spans when no tool_calls were sent; skips when neither is provided, so an evaluation with no trajectory reports "not judged" rather than clean. At the shipped default it ADVISES; set `max_steps` for your own agents and it GATES, because a step budget is a number only the deployment knows',
  evalType: 'cost',
  weight: 1,
  kind: 'policy',
  mechanism: 'formula',
  needs: ['tool_calls'],
  question: 'within_budget',
  classes: ['over_budget'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    const skip = skipWithoutTrajectory('max_steps', context);
    if (skip) return skip;

    const calls = stepsOf(context);
    const scope = stepScopeNote(context);
    const configured = context.customConfig?.max_steps;
    const isConfigured = typeof configured === 'number' && Number.isFinite(configured) && configured >= 1;
    const budget = isConfigured ? Math.floor(configured as number) : DEFAULT_MAX_STEPS;
    const evidence: Evidence[] = [
      { type: 'count', stat: 'tool_calls', unit: 'calls', value: calls.length, threshold: budget, thresholdSource: isConfigured ? 'config' : 'default' },
    ];
    const passed = calls.length <= budget;
    return {
      ruleName: 'max_steps',
      passed,
      score: passed ? 1 : Math.max(0, budget / calls.length),
      value: { stat: 'tool_calls', unit: 'calls', value: calls.length },
      evidence,
      message: passed
        ? `${calls.length} tool call${calls.length === 1 ? '' : 's'}, within the budget of ${budget}${isConfigured ? '' : ' (the shipped default, so this rule advises rather than gates)'}${scope}`
        : `Step budget: ${calls.length} tool calls exceeds ${budget}${isConfigured ? '' : ' (the shipped default, so this rule advises rather than gates — set max_steps to make it your policy)'}${scope}`,
    };
  },
};

export const costRules: EvalRule[] = [costUnderThreshold, verbosityRatio, noToolLoop, maxSteps];
