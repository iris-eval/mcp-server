import type { EvalRule, EvalContext, EvalRuleResult } from '../../types/eval.js';

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

export const costRules: EvalRule[] = [costUnderThreshold, tokenEfficiency];
