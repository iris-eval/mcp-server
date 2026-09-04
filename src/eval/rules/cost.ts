import type { EvalRule, EvalContext, EvalRuleResult } from '../../types/eval.js';
import { callKey, describeInput, skipWithoutTrajectory } from './trajectory.js';

export const costUnderThreshold: EvalRule = {
  name: 'cost_under_threshold',
  description: 'Total cost must be under a configurable USD threshold',
  evalType: 'cost',
  weight: 1,
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
      message: passed
        ? `Cost ($${cost.toFixed(4)}) is under threshold ($${threshold.toFixed(4)})`
        : `Cost ($${cost.toFixed(4)}) exceeds threshold ($${threshold.toFixed(4)})`,
    };
  },
};

export const tokenEfficiency: EvalRule = {
  name: 'token_efficiency',
  description: 'Checks output-to-input token ratio for efficiency',
  evalType: 'cost',
  weight: 0.5,
  evaluate(context: EvalContext): EvalRuleResult {
    const prompt = context.tokenUsage?.prompt_tokens;
    const completion = context.tokenUsage?.completion_tokens;
    if (prompt === undefined || completion === undefined || prompt === 0) {
      return { ruleName: 'token_efficiency', passed: false, score: 0, message: 'Token usage not provided', skipped: true, skipReason: 'context.tokenUsage not provided' };
    }
    const ratio = completion / prompt;
    const maxRatio = (context.customConfig?.max_token_ratio as number) ?? 5;
    const passed = ratio <= maxRatio;
    return {
      ruleName: 'token_efficiency',
      passed,
      score: passed ? 1 : Math.max(0, 1 - (ratio - maxRatio) / maxRatio),
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

/** The longest run of alternating A,B calls, and how many complete cycles it holds. */
function longestTwoCallCycle(keys: string[]): { a: string; b: string; cycles: number } | null {
  let best: { a: string; b: string; cycles: number } | null = null;
  for (let start = 0; start + 3 < keys.length; start++) {
    const a = keys[start];
    const b = keys[start + 1];
    if (a === b) continue;
    let len = 2;
    while (start + len < keys.length && keys[start + len] === (len % 2 === 0 ? a : b)) len++;
    const cycles = Math.floor(len / 2);
    if (cycles >= 2 && (best === null || cycles > best.cycles)) best = { a, b, cycles };
  }
  return best;
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
    'The agent must not repeat itself. Fails when one tool is called with an identical input (object keys sorted, whitespace collapsed) more than max_tool_repeats times — default 3, config key `max_tool_repeats` — or when two calls alternate for more than two complete A,B,A,B cycles. Skips when no tool calls are provided, so an evaluation with no trajectory reports "not judged" rather than clean. Catches the wasted spend a cost threshold cannot see: five identical calls can still bill under a per-evaluation cost limit',
  evalType: 'cost',
  weight: 1,
  evaluate(context: EvalContext): EvalRuleResult {
    const skip = skipWithoutTrajectory('no_tool_loop', context);
    if (skip) return skip;

    const calls = context.toolCalls ?? [];
    const configured = context.customConfig?.max_tool_repeats;
    const maxRepeats =
      typeof configured === 'number' && Number.isFinite(configured) && configured >= 1
        ? Math.floor(configured)
        : DEFAULT_MAX_TOOL_REPEATS;

    const keys = calls.map(callKey);
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

    if (worstCount > maxRepeats) {
      const call = calls[keys.indexOf(worstKey)];
      return {
        ruleName: 'no_tool_loop',
        passed: false,
        score: Math.max(0, 1 - (worstCount - maxRepeats) * 0.25),
        message: `Tool loop: ${call.tool_name} called ${worstCount} times with the same input — ${describeInput(call.input)} — over ${calls.length} call${calls.length === 1 ? '' : 's'} (max ${maxRepeats})`,
      };
    }

    const cycle = longestTwoCallCycle(keys);
    if (cycle !== null && cycle.cycles > MAX_TWO_CALL_CYCLES) {
      const a = calls[keys.indexOf(cycle.a)];
      const b = calls[keys.indexOf(cycle.b)];
      return {
        ruleName: 'no_tool_loop',
        passed: false,
        score: Math.max(0, 1 - (cycle.cycles - MAX_TWO_CALL_CYCLES) * 0.25),
        message: `Tool loop: ${a.tool_name} (${describeInput(a.input)}) and ${b.tool_name} (${describeInput(b.input)}) alternate for ${cycle.cycles} cycles (max ${MAX_TWO_CALL_CYCLES})`,
      };
    }

    return {
      ruleName: 'no_tool_loop',
      passed: true,
      score: 1,
      message: `No repeated tool call (${calls.length} call${calls.length === 1 ? '' : 's'}; most repeated ran ${worstCount}×, max ${maxRepeats})`,
    };
  },
};

export const costRules: EvalRule[] = [costUnderThreshold, tokenEfficiency, noToolLoop];
