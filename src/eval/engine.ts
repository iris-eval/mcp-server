import type { EvalRule, EvalContext, EvalRuleResult, EvalResult, EvalType, CustomRuleDefinition } from '../types/eval.js';
import { getRulesForType, createCustomRule } from './rules/index.js';
import { generateEvalId } from '../utils/ids.js';

export class EvalEngine {
  private additionalRules: Map<EvalType, EvalRule[]> = new Map();
  /**
   * Registered-rule handles keyed by deployed rule id, so delete paths can
   * hot-remove exactly the instance they registered. Keyed by id (not name)
   * because deploy_rule doesn't enforce name uniqueness — two rules can
   * share a name with different definitions.
   */
  private rulesById: Map<string, { evalType: EvalType; rule: EvalRule }> = new Map();
  private threshold: number;
  private ruleThresholds?: Record<string, unknown>;

  constructor(threshold = 0.7, ruleThresholds?: Record<string, unknown>) {
    this.threshold = threshold;
    this.ruleThresholds = ruleThresholds;
  }

  registerRule(evalType: EvalType, rule: EvalRule, ruleId?: string): void {
    const existing = this.additionalRules.get(evalType) ?? [];
    existing.push(rule);
    this.additionalRules.set(evalType, existing);
    if (ruleId !== undefined) {
      this.rulesById.set(ruleId, { evalType, rule });
    }
  }

  /**
   * Hot-remove a rule registered under `ruleId` so it stops firing on the
   * live process — what delete_rule's description promises (#332). Returns
   * false when the id was never registered (already removed, or registered
   * without an id); callers treat that as a no-op, not an error.
   */
  unregisterRule(ruleId: string): boolean {
    const entry = this.rulesById.get(ruleId);
    if (!entry) return false;
    this.rulesById.delete(ruleId);
    const rules = this.additionalRules.get(entry.evalType);
    if (rules) {
      const idx = rules.indexOf(entry.rule);
      if (idx !== -1) rules.splice(idx, 1);
    }
    return true;
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

    /*
     * Inline custom_rules are ADDITIVE, which is what evaluate_output's
     * description promises in two places: "fires REGARDLESS of eval_type"
     * and "otherwise both your rules AND the eval_type bundle run together".
     *
     * The old branch did neither. `evalType === 'custom' && customRules`
     * meant:
     *   - evaluate('safety', ctx, [myRule]) silently DISCARDED myRule and
     *     returned a plausible score that never applied it. An agent
     *     following the tool description got a wrong answer with no warning.
     *   - evaluate('custom', ctx, [myRule]) replaced the rule list entirely,
     *     EVICTING every rule the user had deployed and which the server
     *     registers at boot. Passing one ad-hoc rule disabled their whole
     *     library for that call.
     *
     * getRulesForType('custom') is [] (rules/index.ts), so eval_type="custom"
     * still runs no built-in bundle — the documented "ONLY these" behaviour
     * holds. What it now also includes is the caller's own deployed rules,
     * which is the least surprising reading of having deployed them.
     */
    const rules: EvalRule[] = [
      ...getRulesForType(evalType),
      ...(this.additionalRules.get(evalType) ?? []),
      ...(customRules ?? []).map((def) => createCustomRule(def)),
    ];

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

    /*
     * Shallow copy so the regex circuit breaker is scoped to THIS evaluation
     * and never leaks into a caller-held context object. All rules in one
     * evaluation share the breaker: after MAX_REGEX_BREACHES_PER_EVAL sandbox
     * budget breaches (see rules/custom.ts), remaining regex rules skip
     * without running — one hostile output cannot stall the request once per
     * rule it carries.
     */
    const evalContext: EvalContext = { ...context, regexBudget: { breaches: 0 } };
    const ruleResults: EvalRuleResult[] = rules.map((rule) => rule.evaluate(evalContext));

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
      // Same field as the main path below: the tool description promises
      // that EVERY critical rule that skipped is named here, and a caller
      // whose only rules were critical ones should not have to infer that
      // from insufficient_data alone.
      const criticalSkippedAll = skippedIndices
        .filter((i) => rules[i].critical === true)
        .map((i) => ruleResults[i].ruleName);

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
        ...(criticalSkippedAll.length > 0 ? { critical_skipped: criticalSkippedAll } : {}),
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

    /*
     * Critical rules hard-fail. Before this existed, the weighted average
     * routinely outvoted a genuine violation: an output containing a real
     * SSN failed no_pii while the other safety rules passed, landing at
     * ~0.765 — over the 0.7 threshold — so `passed`, the one field every
     * automated gate keys on, said true about the product's flagship
     * failure scenario. A detection that reports an all-clear is worse
     * than no detection.
     *
     * Only EVALUATED failures count: a critical rule that skipped (missing
     * context, broken config) has not judged the output and must not veto
     * it. The score is left as-is — it stays a quality gradient; `passed`
     * is the verdict, and the two answer different questions.
     */
    const criticalFailures = evaluatedIndices
      .filter((i) => rules[i].critical === true && !ruleResults[i].passed)
      .map((i) => ruleResults[i].ruleName);

    /*
     * The other half of that sentence, surfaced as a field.
     *
     * A critical rule that SKIPPED is the fail-open seam between this
     * release's two headline features: an adversary who knows a deployed
     * critical regex can craft output that stalls it past the sandbox
     * budget, and the rule then neither judges nor vetoes — so the eval
     * returns passed=true with an EMPTY critical_failures on output that
     * nobody actually cleared. The trade-off is deliberate (failing closed
     * would let the same adversary force false violations on benign
     * output), but before this field the only trace of it was a suggestions
     * line — prose. A gate that must fail closed should not have to walk
     * rule_results[].budgetExceeded to discover it was defeated.
     */
    const criticalSkipped = skippedIndices
      .filter((i) => rules[i].critical === true)
      .map((i) => ruleResults[i].ruleName);

    const passed = score >= this.threshold && criticalFailures.length === 0;

    const suggestions: string[] = [];
    for (const result of ruleResults) {
      if (!result.passed && !result.skipped) {
        suggestions.push(`[${result.ruleName}] ${result.message}`);
      }
    }
    if (criticalFailures.length > 0 && score >= this.threshold) {
      suggestions.push(
        `Critical rule(s) failed (${criticalFailures.join(', ')}) — passed=false regardless of the weighted score`,
      );
    }
    if (rulesSkipped > 0) {
      /*
       * Say WHY each rule skipped. The old line hardcoded "(missing
       * context)" — but a rule whose regex was killed at the sandbox budget
       * did not lack context, it was DEFEATED by this output, and labeling
       * that "missing context" hid the one signal a fail-closed consumer
       * needs. Each rule's own skipReason is the truth; missing context is
       * only the default for rules that skip without stating a reason.
       */
      const skippedParts = ruleResults
        .filter((r) => r.skipped)
        .map((r) => `${r.ruleName} (${r.skipReason ?? 'missing context'})`);
      suggestions.push(
        `${rulesSkipped} rule(s) skipped — excluded from the weighted score: ${skippedParts.join('; ')}`,
      );
    }
    if (criticalSkipped.length > 0) {
      suggestions.push(
        `Critical rule(s) did NOT judge this output (${criticalSkipped.join(', ')}) — ` +
          'they skipped, so they could not veto. This evaluation is "unknown" on those ' +
          'checks, not "clean"; a gate that must fail closed should treat critical_skipped ' +
          'as a failure.',
      );
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
      ...(criticalFailures.length > 0 ? { critical_failures: criticalFailures } : {}),
      ...(criticalSkipped.length > 0 ? { critical_skipped: criticalSkipped } : {}),
    };
  }
}
