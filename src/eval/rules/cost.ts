import { MAX_EVIDENCE_ITEMS, type EvalRule, type EvalContext, type EvalRuleResult, type Evidence } from '../../types/eval.js';
import { thresholdSourceOf } from '../thresholds.js';
import { describeInput, internKeys, longestCycleIn, looksLikePolling, skipWithoutTrajectory, stepKey, targetKey } from './trajectory.js';
import { notJudgedPastCeiling, stepScopeNote, stepStatsOf, stepsOf } from '../steps.js';
import { stepBudget } from './expected-trajectory.js';
import { READ_TOKENS, catalogueIndex, catalogueMatch, readOnlyWordNotTaken } from '../catalogue.js';
import { listNames, toolNameOf } from '../case-history.js';
import type { Step } from '../../types/trace.js';
import { costBasisNote, costSourceEvidence } from '../cost-basis.js';
import { COST_ANOMALY_FLAT_MARGIN, COST_ANOMALY_MIN_HISTORY, COST_ANOMALY_WINDOW, COST_ANOMALY_Z, costAnomaly as anomalyOf, describeCostAnomaly } from '../cost-anomaly.js';

export const costUnderThreshold: EvalRule = {
  name: 'cost_under_threshold',
  description: 'Total cost must be under a configurable USD threshold',
  evalType: 'cost',
  weight: 1,
  kind: 'policy',
  mechanism: 'formula',
  needs: ['cost'],
  thresholdKeys: ['cost_threshold'],
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
      evidence: [{ type: 'count', stat: 'cost', unit: 'usd', value: cost, threshold, thresholdSource: thresholdSourceOf(context, 'cost_threshold'), ...costSourceEvidence(context) }],
      message: (passed
        ? `Cost ($${cost.toFixed(4)}) is under threshold ($${threshold.toFixed(4)})`
        : `Cost ($${cost.toFixed(4)}) exceeds threshold ($${threshold.toFixed(4)})`) + costBasisNote(context),
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
  thresholdKeys: ['max_token_ratio'],
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
      evidence: [{ type: 'count', stat: 'completion_to_prompt_ratio', unit: 'ratio', value: ratio, threshold: maxRatio, thresholdSource: thresholdSourceOf(context, 'max_token_ratio') }],
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

/**
 * The longest period a cycle can have and still repeat more than the
 * allowance inside a trajectory of n calls. Until 0.16.0 the search stopped
 * at period 3 ("beyond three the pattern is a plan, not a loop"), which a
 * four-call block repeated three times over — twelve calls that between
 * them asked four questions three times — walked straight through (#427).
 * The allowance is what tells a plan from a loop, not the period: a plan
 * repeated twice is a retry and passes; the same plan a third time is the
 * machine stuck.
 */
export function maxCycleLength(callCount: number): number {
  return Math.floor(callCount / (MAX_TWO_CALL_CYCLES + 1));
}

/**
 * The longest repeated sequence worth reporting that was not a POLL, at
 * any period from 2 up to maxCycleLength(n), or null. Every period
 * is searched at every length of run: one pass over the calls for each
 * (trajectory.ts, longestCycleIn), n² / 3 comparisons in all.
 *
 * Period 2 keeps exactly the threshold the alternating-pair detector used,
 * so no case that fired before stops firing and none starts. Period 3 was
 * 0.11.0's recall (A,B,C,A,B,C); every longer period is 0.16.0's (#427).
 *
 * Period 1 is deliberately absent. The repeat COUNT above owns it and counts
 * non-consecutive repeats too, which is strictly more; a second detector of
 * the same failure class would hand the risk estimate two correlated
 * signals to multiply as though they were independent.
 */
function findCycle(keys: readonly string[], calls: readonly Step[]): { k: number; start: number; repetitions: number; gramIndices: number[] } | null {
  const ids = internKeys(keys);
  for (let k = 2; k <= maxCycleLength(keys.length); k += 1) {
    /*
     * A regular cadence is a machine waiting, not a machine stuck, so a
     * repeated sequence that was a poll is passed over. And only that one
     * is: the longest sequence of a period that is not a poll is the one
     * asked. Until 0.22.0 the longest of a period was asked alone, and when
     * it was a poll the search went on to the next period, past a loop of
     * the same length as the poll (two calls polled four times over, then
     * two other calls in turn three times with no cadence).
     */
    const cycle = longestCycleIn(ids, k, (start, repetitions) => {
      if (repetitions <= MAX_TWO_CALL_CYCLES) return false;
      const times: Array<string | undefined> = [];
      for (let r = 0; r < repetitions; r += 1) times.push(calls[start + r * k]?.startedAt);
      return !looksLikePolling(times);
    });
    if (cycle === null) continue;
    return { k, start: cycle.start, repetitions: cycle.repetitions, gramIndices: Array.from({ length: k }, (_, i) => cycle.start + i) };
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
  /** Calls through a tool the catalogue marks read-only in an entry reached by the tool's own name: the called name, and that entry's. */
  const ownNameOnly = new Map<string, string>();
  let callsOwnNameOnly = 0;
  for (const [at, step] of calls.entries()) {
    /*
     * The CATALOGUE must SAY read-only. `readFamilyOf` falls back to a name
     * list when it does not, which is right for describing a tool and wrong
     * for deciding one — a rule that guessed "fetch_page is a read" would
     * count a paid API call as a wasted reread on the strength of its name.
     * So this reads the annotation directly, and the name heuristic only
     * explains what was left out.
     *
     * And it reads it from the entry under the name the call was made by.
     * A call named mcp__<server>__<tool> can also be matched to an entry
     * under the tool's own name (catalogue.ts), which may be another
     * server's tool: a read-only word found that way is not taken, here or
     * anywhere, because a count of wasted reads would then rest on a hint
     * that was never this tool's. The result says when that left calls out,
     * and what to list to have them counted.
     */
    const declared = index.get(step.name)?.annotations?.readOnlyHint === true;
    if (!declared) {
      const entry = typeof step.name === 'string' ? readOnlyWordNotTaken(catalogueMatch(index, step.name)) : undefined;
      if (entry !== undefined) {
        callsOwnNameOnly += 1;
        ownNameOnly.set(toolNameOf(step.name), toolNameOf(entry.name));
      } else if (READ_TOKENS.some((t) => step.name.toLowerCase().includes(t))) readShapedByName += 1;
      continue;
    }
    const key = targetKey(step);
    if (key === null) continue;
    const seen = byTarget.get(key) ?? [];
    seen.push(at);
    byTarget.set(key, seen);
  }
  // The most-read target that was not polled. Until 0.22.0 the most-read target was asked alone: when that was a log read at a steady cadence, a file read five times behind it was never looked at.
  let worst: { key: string; count: number; indices: number[] } | null = null;
  for (const [key, indices] of byTarget) {
    if (worst !== null && indices.length <= worst.count) continue;
    if (looksLikePolling(indices.map((i) => calls[i]?.startedAt))) continue;
    worst = { key, count: indices.length, indices };
  }
  const shapedNote = readShapedByName > 0
    ? `; ${readShapedByName} more call${readShapedByName === 1 ? '' : 's'} looked read-shaped but the catalogue does not say so`
    : '';
  const oneTool = ownNameOnly.size === 1;
  const ownNameNote = callsOwnNameOnly > 0
    ? `; ${callsOwnNameOnly} call${callsOwnNameOnly === 1 ? '' : 's'} went through ${oneTool ? 'a tool' : 'tools'} the catalogue marks read-only under the tool's own name (${listNames([...new Set(ownNameOnly.values())])}), a word that is taken only under the name a tool is called by, since another server's tool can share the own name. If ${oneTool ? "that entry is this tool's, list it" : "those entries are these tools', list them"} as ${listNames([...ownNameOnly.keys()])} to have rereads through ${oneTool ? 'it' : 'them'} counted`
    : '';
  return { worst, unknownNote: `${shapedNote}${ownNameNote}` };
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
    'The agent must not repeat itself. Fails when one tool is called with an identical input (object keys sorted, whitespace collapsed) more than max_tool_repeats times — default 3, config key `max_tool_repeats` — or when a sequence of two or more distinct calls repeats consecutively more than twice (A,B,A,B,A,B; A,B,C,D,A,B,C,D,A,B,C,D). Reads the trajectory from tool_calls, or from OpenTelemetry TOOL spans when no tool_calls were sent; skips when neither is provided, so an evaluation with no trajectory reports "not judged" rather than clean. Catches the wasted spend a cost threshold cannot see: five identical calls can still bill under a per-evaluation cost limit. Each of its three readings (a call repeated past the allowance, a repeated sequence, a target read again) passes over a repetition that was a poll and asks the next, so a poll does not hide a loop behind it. It reads a run of up to 10,000 tool calls whole, and looks for a repeated sequence of every length such a run can hold. Of a longer run a loop found among the first 10,000 calls is reported, and otherwise the rule is not judged',
  evalType: 'cost',
  weight: 1,
  kind: 'detection',
  mechanism: 'formula',
  needs: ['tool_calls'],
  thresholdKeys: ['max_tool_repeats', 'max_target_rereads'],
  question: 'tool_use_correct',
  classes: ['tool_loop'],
  // 2: reads a run whole where it read the first 500 calls, and does not report a run it read in part as free of loops (#1013); and asks every call repeated past the allowance whether it was a poll, where it asked the most repeated one, and likewise the longest repeated sequence of each length and the most-read target that were not polls.
  version: 2,
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
    /** Where each distinct call stands in the run. */
    const placesOf = new Map<string, number[]>();
    for (const [index, key] of keys.entries()) {
      const places = placesOf.get(key);
      if (places === undefined) placesOf.set(key, [index]);
      else places.push(index);
    }
    let worstCount = 0;
    for (const places of placesOf.values()) worstCount = Math.max(worstCount, places.length);

    const repeatsEvidenceOf = (count: number): Evidence[] => [
      { type: 'count', stat: 'max_repeats_of_one_call', unit: 'calls', value: count, threshold: maxRepeats, thresholdSource: thresholdSourceOf(context, 'max_tool_repeats') },
    ];
    /*
     * A steady cadence is a machine WAITING, not a machine stuck, and this
     * is the clause a poll actually trips: an agent watching a build calls
     * the same endpoint with the same arguments until the answer changes.
     * The check belongs on every trigger, not only the cycle one, because
     * the repeat count is what sees an unchanging call.
     *
     * Every call repeated past the allowance is asked, the most repeated
     * first. Until 0.22.0 only the most repeated one was: when that was a
     * poll, a second call made five times with no cadence passed behind it.
     */
    const repeated = [...placesOf.values()].filter((places) => places.length > maxRepeats).sort((a, b) => b.length - a.length);
    let poll: number[] | null = null;
    let loop: number[] | null = null;
    for (const places of repeated) {
      if (looksLikePolling(places.map((i) => calls[i].startedAt))) {
        poll ??= places;
        continue;
      }
      loop = places;
      break;
    }

    if (loop !== null) {
      const call = calls[loop[0]];
      const evidence: Evidence[] = [...repeatsEvidenceOf(loop.length)];
      for (const index of loop) {
        if (evidence.length >= MAX_EVIDENCE_ITEMS) break;
        evidence.push({ type: 'toolCall', index, toolName: calls[index].name, label: 'repeated call' });
      }
      return {
        ruleName: 'no_tool_loop',
        passed: false,
        score: Math.max(0, 1 - (loop.length - maxRepeats) * 0.25),
        value: { stat: 'max_repeats_of_one_call', unit: 'calls', value: loop.length },
        evidence,
        message: `Tool loop: ${call.name} called ${loop.length} times with the same input — ${describeInput(call.input)} — over ${calls.length} call${calls.length === 1 ? '' : 's'} (max ${maxRepeats})${scope}`,
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
        { type: 'count', stat: 'reads_of_one_target', unit: 'reads', value: count, threshold: maxTargetRereads, thresholdSource: thresholdSourceOf(context, 'max_target_rereads') },
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

    /*
     * A loop found among the calls read is a loop, whatever follows. None
     * found says nothing of the calls that were not read, so for a run
     * longer than the list the rule is not judged (steps.ts).
     */
    const cut = notJudgedPastCeiling('no_tool_loop', context, 'No loop was found among them, and the rest were not read');
    if (cut !== null) return cut;
    return {
      ruleName: 'no_tool_loop',
      passed: true,
      score: 1,
      message: poll !== null
        ? `No tool loop: ${calls[poll[0]].name} ran ${poll.length}× at a regular cadence, which is polling rather than a loop — an agent waiting on something waits, and a stuck one retries as fast as it can emit (${calls.length} call${calls.length === 1 ? '' : 's'})`
        // The catalogue note belongs on a PASS as much as on a failure: a
        // clean verdict that could not see part of the trajectory has to
        // say so, which is the difference between clean and not-judged.
        : `No repeated tool call (${calls.length} call${calls.length === 1 ? '' : 's'}; most repeated ran ${worstCount}×, max ${maxRepeats})${rereads.unknownNote}`,
      value: { stat: 'max_repeats_of_one_call', unit: 'calls', value: worstCount },
      evidence: poll !== null ? [...repeatsEvidenceOf(worstCount), { type: 'count', stat: 'regularly_spaced_repetitions', unit: 'calls', value: poll.length }] : repeatsEvidenceOf(worstCount),
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
 * and GATES the moment the deployment sets `max_steps`, which is 0.10.0's
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
    'A task must finish within a step budget. Fails when the trajectory carries more tool calls than `max_steps` — default 50. Reads the trajectory from tool_calls, or from OpenTelemetry TOOL spans when no tool_calls were sent; skips when neither is provided, so an evaluation with no trajectory reports "not judged" rather than clean. At the shipped default it ADVISES; set `max_steps` for your own agents and it GATES, because a step budget is a number only the deployment knows. The count is of the calls the run made, whatever its length',
  evalType: 'cost',
  weight: 1,
  kind: 'policy',
  mechanism: 'formula',
  needs: ['tool_calls'],
  thresholdKeys: ['max_steps'],
  question: 'within_budget',
  classes: ['over_budget'],
  // 2: counts the calls the run made; counted from the list the rules read, no run was longer than 500 (#1013).
  version: 2,
  evaluate(context: EvalContext): EvalRuleResult {
    const skip = skipWithoutTrajectory('max_steps', context);
    if (skip) return skip;

    /*
     * The number of calls the run made, not the number the rules read: a
     * count needs no reading. Counted from the list, a run of any length
     * was never more than the list's length, so a budget above that could
     * not be exceeded (#1013).
     */
    const calls = Math.max(stepsOf(context).length, stepStatsOf(context).available);
    const configured = context.customConfig?.max_steps;
    const budget = typeof configured === 'number' && Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : DEFAULT_MAX_STEPS;
    // Presence in customConfig is NOT "the deployment set it": the engine
    // merges the shipped thresholds in on every call, so this rule gated at
    // the shipped default for as long as max_steps sat in defaults.ts while
    // its own message said it advised. The source comes from the engine.
    const source = thresholdSourceOf(context, 'max_steps');
    const isConfigured = source !== 'default';
    const evidence: Evidence[] = [
      { type: 'count', stat: 'tool_calls', unit: 'calls', value: calls, threshold: budget, thresholdSource: source },
    ];
    const passed = calls <= budget;
    return {
      ruleName: 'max_steps',
      passed,
      score: passed ? 1 : Math.max(0, budget / calls),
      value: { stat: 'tool_calls', unit: 'calls', value: calls },
      evidence,
      message: passed
        ? `${calls} tool call${calls === 1 ? '' : 's'}, within the budget of ${budget}${isConfigured ? '' : ' (the shipped default, so this rule advises rather than gates)'}`
        : `Step budget: ${calls} tool calls exceeds ${budget}${isConfigured ? '' : ' (the shipped default, so this rule advises rather than gates — set max_steps to make it your policy)'}`,
    };
  },
};

/*
 * Cost against the agent's OWN history (0.14.0).
 *
 * `cost_under_threshold` is a POLICY: a dollar line the deployment chose.
 * This is a MEASUREMENT: the trace's distance from what this agent usually
 * costs, in robust units, with the spike line derived from the statistic
 * rather than typed. A measurement reports and never decides — the
 * composer's own law since 0.10.0 — which is exactly the role the approved
 * section asked for ("reports and never feeds p_bad"); the shipped
 * vocabulary's word for that is `measurement`, and its family measures
 * conformance to the formula, as verbosity_ratio's does.
 *
 * The baseline arrives on the context (`costHistory`, newest first) from
 * the agent's own failure log — the same history the moment classifier
 * reads, one implementation (src/eval/cost-anomaly.ts). A bare
 * evaluate_output call with no linked trace has no history and the rule
 * says so; it never invents a baseline.
 *
 * When the trajectory carries per-call costs, the dearest call is named;
 * when it carries none, the trace cost is shared across the calls by their
 * output size and the share is labelled estimated.
 */
export const costAnomaly: EvalRule = {
  name: 'cost_anomaly',
  description:
    `The trace cost against this agent's own recent history, not a dollar figure: the Iglewicz–Hoaglin modified z-score, 0.6745 · (cost − median) / MAD, over the agent's last ${COST_ANOMALY_WINDOW} costed traces, a spike at z > ${COST_ANOMALY_Z}; when every recent trace cost the same, a spike is more than ${COST_ANOMALY_FLAT_MARGIN * 100}% over every prior value. A measurement — it reports and never decides the verdict — and it skips as insufficient_history below ${COST_ANOMALY_MIN_HISTORY} prior costed traces, so it says nothing rather than "fine" about an agent it has not seen. cost_under_threshold stays the explicit dollar policy. Names the dearest tool call when the trajectory prices its calls, or the largest estimated share when it does not`,
  evalType: 'cost',
  weight: 1,
  kind: 'measurement',
  mechanism: 'formula',
  needs: ['cost'],
  question: 'within_budget',
  classes: ['over_budget'],
  version: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    if (context.costUsd === undefined || context.costUsd === null) {
      return { ruleName: 'cost_anomaly', passed: false, score: 0, message: 'Cost data not provided', skipped: true, skipReason: 'context.costUsd not provided' };
    }
    const history = context.costHistory ?? [];
    const anomaly = anomalyOf(context.costUsd, history);
    if (anomaly === null) {
      const n = history.length;
      return {
        ruleName: 'cost_anomaly',
        passed: false,
        score: 0,
        message: `Not judged: ${n} prior costed trace${n === 1 ? '' : 's'} for this agent, ${COST_ANOMALY_MIN_HISTORY} needed before a cost can be read against its own history`,
        skipped: true,
        skipReason: `insufficient_history: ${n} prior costed traces, ${COST_ANOMALY_MIN_HISTORY} needed`,
      };
    }
    const evidence: Evidence[] = anomaly.fallback
      ? [{ type: 'count', stat: 'cost_over_prior_maximum', unit: 'ratio', value: anomaly.costUsd / anomaly.maxPrior, threshold: 1 + COST_ANOMALY_FLAT_MARGIN, thresholdSource: 'rule', ...costSourceEvidence(context) }]
      : [{ type: 'count', stat: 'modified_z', unit: 'z', value: anomaly.z!, threshold: COST_ANOMALY_Z, thresholdSource: 'rule', ...costSourceEvidence(context) }];
    const dearest = dearestCall(context, anomaly.costUsd);
    if (dearest !== null && evidence.length < MAX_EVIDENCE_ITEMS) evidence.push(dearest.evidence);
    const passed = !anomaly.anomalous;
    const usd = (v: number): string => `${v.toFixed(4)}`;
    const score = passed
      ? 1
      : anomaly.fallback
        ? Math.max(0, 1 - (anomaly.costUsd / anomaly.maxPrior - 1 - COST_ANOMALY_FLAT_MARGIN))
        : Math.max(0, 1 - (anomaly.z! - COST_ANOMALY_Z) / COST_ANOMALY_Z);
    return {
      ruleName: 'cost_anomaly',
      passed,
      score,
      value: { stat: 'cost', unit: 'usd', value: anomaly.costUsd },
      evidence,
      message:
        (passed
          ? anomaly.fallback
            ? `Cost (${usd(anomaly.costUsd)}) is within ${COST_ANOMALY_FLAT_MARGIN * 100}% of the most this agent has cost before (${usd(anomaly.maxPrior)}; its last ${anomaly.n} traces all cost about the same)`
            : `Cost (${usd(anomaly.costUsd)}) is usual for this agent: modified z = ${anomaly.z!.toFixed(1)} against a median of ${usd(anomaly.median)} (MAD ${usd(anomaly.mad)}) over its last ${anomaly.n} traces`
          : `${describeCostAnomaly(anomaly)}${dearest === null ? '' : ` ${dearest.sentence}`}`) + costBasisNote(context),
    };
  },
};

/**
 * Per-call attribution: the dearest call by its own `cost_usd` when
 * the trajectory prices its calls; otherwise the trace cost shared across
 * the calls in proportion to their output size, labelled estimated.
 */
function dearestCall(context: EvalContext, costUsd: number): { evidence: Evidence; sentence: string } | null {
  const calls = context.toolCalls ?? [];
  if (calls.length === 0) return null;
  const priced = calls.map((c, index) => ({ index, name: c.tool_name, cost: typeof c.cost_usd === 'number' && Number.isFinite(c.cost_usd) ? c.cost_usd : null }));
  if (priced.some((p) => p.cost !== null)) {
    const top = priced.filter((p) => p.cost !== null).sort((a, b) => b.cost! - a.cost!)[0];
    return {
      evidence: { type: 'toolCall', index: top.index, toolName: top.name, label: `dearest call, $${top.cost!.toFixed(4)} as recorded` },
      sentence: `The dearest call was ${top.name} at $${top.cost!.toFixed(4)}, as the trajectory recorded it.`,
    };
  }
  const sizes = calls.map((c) => (c.output === undefined ? 0 : String(typeof c.output === 'string' ? c.output : JSON.stringify(c.output)).length));
  const total = sizes.reduce((a, b) => a + b, 0);
  if (total === 0) return null;
  let top = 0;
  for (let i = 1; i < sizes.length; i += 1) if (sizes[i] > sizes[top]) top = i;
  const share = (costUsd * sizes[top]) / total;
  return {
    evidence: { type: 'toolCall', index: top, toolName: calls[top].tool_name, label: `largest estimated share, $${share.toFixed(4)} by output size` },
    sentence: `No call carries its own cost; shared by output size, the largest estimated share is ${calls[top].tool_name} at about $${share.toFixed(4)} (estimated).`,
  };
}

export const costRules: EvalRule[] = [costUnderThreshold, verbosityRatio, noToolLoop, maxSteps, costAnomaly, stepBudget];
