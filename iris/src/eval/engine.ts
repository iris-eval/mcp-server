import type { EvalRule, EvalContext, EvalRuleResult, EvalResult, EvalType, CustomRuleDefinition } from '../types/eval.js';
import { getRulesForType, createCustomRule } from './rules/index.js';
import { generateEvalId } from '../utils/ids.js';

export class EvalEngine {
  private additionalRules: Map<EvalType, EvalRule[]> = new Map();
  private threshold: number;

  constructor(threshold = 0.7) {
    this.threshold = threshold;
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
        score: 1,
        passed: true,
        rule_results: [],
        suggestions: ['No rules configured for this eval type'],
      };
    }

    const ruleResults: EvalRuleResult[] = rules.map((rule) => rule.evaluate(context));

    const totalWeight = rules.reduce((sum, r) => sum + r.weight, 0);
    const weightedScore = rules.reduce((sum, rule, i) => {
      return sum + ruleResults[i].score * rule.weight;
    }, 0);
    const score = totalWeight > 0 ? weightedScore / totalWeight : 0;

    const passed = score >= this.threshold;

    const suggestions: string[] = [];
    for (const result of ruleResults) {
      if (!result.passed) {
        suggestions.push(`[${result.ruleName}] ${result.message}`);
      }
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
    };
  }
}
