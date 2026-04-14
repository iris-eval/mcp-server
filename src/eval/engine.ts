import type { EvalRule, EvalContext, EvalRuleResult, EvalResult, EvalType, CustomRuleDefinition } from '../types/eval.js';
import { getRulesForType, createCustomRule } from './rules/index.js';
import { generateEvalId } from '../utils/ids.js';

export class EvalEngine {
  private additionalRules: Map<EvalType, EvalRule[]> = new Map();
  private threshold: number;
  private ruleThresholds?: Record<string, unknown>;

  constructor(threshold = 0.7, ruleThresholds?: Record<string, unknown>) {
    this.threshold = threshold;
    this.ruleThresholds = ruleThresholds;
  }

  registerRule(evalType: EvalType, rule: EvalRule): void {
    const existing = this.additionalRules.get(evalType) ?? [];
    existing.push(rule);
    this.additionalRules.set(evalType, existing);
  }

  evaluate(
    evalType: EvalType,
    context: EvalContext,
    customRules?: CustomRuleDefinition[],
  ): EvalResult {
    // Merge system-level thresholds into customConfig (user-provided values take precedence)
    if (this.ruleThresholds) {
      context = {
        ...context,
        customConfig: { ...this.ruleThresholds, ...context.customConfig },
      };
    }

    let rules: EvalRule[];

    if (evalType === 'custom' && customRules) {
      rules = customRules.map((def) => createCustomRule(def));
    } else {
      rules = [
        ...getRulesForType(evalType),
        ...(this.additionalRules.get(evalType) ?? []),
      ];
    }

    if (rules.length === 0) {
      return {
        id: generateEvalId(),
        eval_type: evalType,
        output_text: context.output,
        expected_text: context.expected,
        score: 0,
        passed: false,
        rule_results: [],
        suggestions: ['No rules configured for this eval type'],
        rules_evaluated: 0,
        rules_skipped: 0,
        insufficient_data: true,
      };
    }

    const ruleResults: EvalRuleResult[] = rules.map((rule) => rule.evaluate(context));

    // Partition into evaluated vs skipped
    const evaluatedIndices: number[] = [];
    const skippedIndices: number[] = [];
    for (let i = 0; i < ruleResults.length; i++) {
      if (ruleResults[i].skipped) {
        skippedIndices.push(i);
      } else {
        evaluatedIndices.push(i);
      }
    }

    const rulesEvaluated = evaluatedIndices.length;
    const rulesSkipped = skippedIndices.length;

    // Handle "all rules skipped" — insufficient data
    if (rulesEvaluated === 0) {
      const skipMessages = ruleResults
        .filter((r) => r.skipped)
        .map((r) => `[${r.ruleName}] ${r.skipReason ?? r.message}`);

      return {
        id: generateEvalId(),
        eval_type: evalType,
        output_text: context.output,
        expected_text: context.expected,
        score: 0,
        passed: false,
        rule_results: ruleResults,
        suggestions: [
          'Insufficient context to evaluate. Provide: expected, input, costUsd, or tokenUsage.',
          ...skipMessages,
        ],
        rules_evaluated: 0,
        rules_skipped: rulesSkipped,
        insufficient_data: true,
      };
    }

    // Weighted average across evaluated rules only (exclude skipped)
    const totalWeight = evaluatedIndices.reduce((sum, i) => sum + rules[i].weight, 0);
    const weightedScore = evaluatedIndices.reduce((sum, i) => {
      const ruleScore = Number.isFinite(ruleResults[i].score) ? ruleResults[i].score : 0;
      return sum + ruleScore * rules[i].weight;
    }, 0);
    const rawScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
    const score = Number.isFinite(rawScore) ? rawScore : 0;

    const passed = score >= this.threshold;

    const suggestions: string[] = [];
    for (const result of ruleResults) {
      if (!result.passed && !result.skipped) {
        suggestions.push(`[${result.ruleName}] ${result.message}`);
      }
    }
    if (rulesSkipped > 0) {
      const skippedNames = ruleResults.filter((r) => r.skipped).map((r) => r.ruleName);
      suggestions.push(`${rulesSkipped} rule(s) skipped (missing context): ${skippedNames.join(', ')}`);
    }

    return {
      id: generateEvalId(),
      eval_type: evalType,
      output_text: context.output,
      expected_text: context.expected,
      score: Math.round(score * 1000) / 1000,
      passed,
      rule_results: ruleResults,
      suggestions,
      rules_evaluated: rulesEvaluated,
      rules_skipped: rulesSkipped,
      insufficient_data: false,
    };
  }
}
