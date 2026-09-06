import type {
  EvalRule,
  EvalContext,
  EvalRuleResult,
  EvalResult,
  EvalResultType,
  EvalType,
  EvalCategoryResult,
  CustomRuleDefinition,
} from '../types/eval.js';
import { getRulesForType, createCustomRule } from './rules/index.js';
import { criticalityResolver, type CriticalityOverrides, type EffectiveCriticality } from './criticality.js';
import { compose, interpretations, DEFAULT_COMPOSE, type ComposeConfig } from './compose.js';
import { inputsPresent, stampRuleResult } from './stamp.js';
import { toSteps } from './steps.js';
import { buildProvenance, configHash, deriveCoverage, deriveVerdict, rulesetHash } from './verdict.js';
import { PKG_VERSION } from '../config/defaults.js';
import { generateEvalId } from '../utils/ids.js';

/**
 * Every bundle eval_type="all" walks, in the order their categories are
 * reported. 'custom' is last: it holds only deployed rules registered under
 * evalType "custom" plus the call's inline custom_rules, so it is absent
 * from the breakdown when neither exists.
 */
export const ALL_EVAL_TYPES: readonly EvalType[] = ['completeness', 'relevance', 'safety', 'cost', 'custom'];

/**
 * What runs when a caller never chose a bundle. It used to be
 * 'completeness', so a CI gate keyed on `passed` skipped PII and injection
 * unless the caller knew to set eval_type — six of seven UAT personas read
 * passed:true on PII-laden text with nothing in the payload saying the
 * safety bundle had not run. Every bundle is the only default under which
 * an omitted argument cannot silently narrow the verdict. The MCP tool and
 * the HTTP ingest route both read this constant, so the two surfaces
 * cannot default differently.
 */
export const DEFAULT_EVAL_TYPE: EvalResultType = 'all';

/**
 * The one-line note both surfaces attach when the default ran, so a reader
 * of the response knows the bundle was chosen for them and how to narrow it.
 */
export const DEFAULT_EVAL_TYPE_NOTE =
  'eval_type was omitted, so the default ran every bundle — completeness, relevance, safety, cost and any custom rules — the same as eval_type="all"; pass a single bundle name to narrow the run.';

/**
 * The verdict arithmetic, shared by a single bundle, the overall
 * eval_type="all" result, and each per-category entry inside it. One
 * function so the three can never disagree about what `passed` means.
 */
interface Verdict {
  score: number;
  passed: boolean;
  rulesEvaluated: number;
  rulesSkipped: number;
  criticalFailures: string[];
  criticalSkipped: string[];
}

export class EvalEngine {
  private additionalRules: Map<EvalType, EvalRule[]> = new Map();
  /**
   * Registered-rule handles keyed by deployed rule id, so delete paths can
   * hot-remove exactly the instance they registered. Keyed by id (not name)
   * because deploy_rule doesn't enforce name uniqueness — two rules can
   * share a name with different definitions.
   */
  private rulesById: Map<string, { evalType: EvalType; rule: EvalRule }> = new Map();
  /**
   * Reverse index, so each rule's result can carry its deployed id
   * (EvalRuleResult.ruleId) without mutating the rule object itself.
   */
  private idByRule: Map<EvalRule, string> = new Map();
  private threshold: number;
  private ruleThresholds?: Record<string, unknown>;
  private criticalityOverrides?: CriticalityOverrides;
  /**
   * Effective criticality per rule, bound to this engine's config overrides.
   * Every veto decision reads THIS, never `rule.critical` directly, so a
   * promotion or demotion cannot apply on one code path and not another.
   */
  private criticality: (rule: EvalRule) => EffectiveCriticality;

  /** The verdict's six defaults, resolved once from the config this engine was built with. */
  private compose: ComposeConfig;

  /**
   * `criticalityOverrides` are `config.eval` — the criticalRules /
   * nonCriticalRules lists. Validated here as well as in loadConfig, so an
   * engine built directly (a test, an embedder) cannot silently ignore a
   * misspelled rule name.
   */
  constructor(
    threshold = 0.7,
    ruleThresholds?: Record<string, unknown>,
    criticalityOverrides?: CriticalityOverrides,
  ) {
    this.threshold = threshold;
    this.ruleThresholds = ruleThresholds;
    this.criticalityOverrides = criticalityOverrides;
    this.criticality = criticalityResolver(criticalityOverrides);
    this.compose = {
      composer: criticalityOverrides?.composer ?? DEFAULT_COMPOSE.composer,
      falsePassCost: criticalityOverrides?.falsePassCost ?? DEFAULT_COMPOSE.falsePassCost,
      onCriticalSkipped: criticalityOverrides?.onCriticalSkipped ?? DEFAULT_COMPOSE.onCriticalSkipped,
      requiredEvidence: (criticalityOverrides?.requiredEvidence as ComposeConfig['requiredEvidence']) ?? DEFAULT_COMPOSE.requiredEvidence,
      defaultsGate: criticalityOverrides?.defaultsGate ?? DEFAULT_COMPOSE.defaultsGate,
      prior: criticalityOverrides?.prior ?? DEFAULT_COMPOSE.prior,
      priorMode: criticalityOverrides?.priorMode ?? DEFAULT_COMPOSE.priorMode,
    };
  }

  /*
   * The verdict, and `passed` with it.
   *
   * From 0.10.0 `passed` IS `verdict.state === 'pass'` — one definition, on
   * every surface. The weighted `score` survives untouched as a quality
   * gradient over the rules that ran, and is never re-meant: a reader who
   * was using it as a gradient keeps it, and a reader who was using it as a
   * safety signal was reading a number that arc zero measured as inert.
   */
  private decide(result: EvalResult): EvalResult {
    const verdict = this.compose.composer === 'legacy' ? deriveVerdict(result, this.threshold) : compose(result, this.compose);
    result.verdict = verdict;
    result.passed = verdict.passed;
    const notes = interpretations(result, verdict, this.compose);
    if (notes.length > 0) result.interpretations = notes;
    return result;
  }

  /** The effective criticality of one rule under this engine's config. Read by the rule roster surfaces. */
  effectiveCriticality(rule: EvalRule): EffectiveCriticality {
    return this.criticality(rule);
  }

  /**
   * Register a rule under a bundle. When `ruleId` is given the registration
   * is IDEMPOTENT by id: registering an id that is already live replaces the
   * earlier instance instead of adding a second one. That is what re-enable
   * (delete_rule enabled:true) and a reload after edit need — without it,
   * every toggle stacked another copy that fired alongside the first.
   */
  registerRule(evalType: EvalType, rule: EvalRule, ruleId?: string): void {
    if (ruleId !== undefined && this.rulesById.has(ruleId)) {
      this.unregisterRule(ruleId);
    }
    const existing = this.additionalRules.get(evalType) ?? [];
    existing.push(rule);
    this.additionalRules.set(evalType, existing);
    if (ruleId !== undefined) {
      this.rulesById.set(ruleId, { evalType, rule });
      this.idByRule.set(rule, ruleId);
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
    this.idByRule.delete(entry.rule);
    const rules = this.additionalRules.get(entry.evalType);
    if (rules) {
      const idx = rules.indexOf(entry.rule);
      if (idx !== -1) rules.splice(idx, 1);
    }
    return true;
  }

  /** Whether a deployed rule id is currently registered (and therefore firing). */
  hasRule(ruleId: string): boolean {
    return this.rulesById.has(ruleId);
  }

  async evaluate(
    evalType: EvalType,
    context: EvalContext,
    customRules?: CustomRuleDefinition[],
  ): Promise<EvalResult> {
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
    return this.run(evalType, rules, undefined, context);
  }

  /**
   * eval_type="all" (#370): every built-in bundle, each with the deployed
   * rules registered under it, plus the rules deployed under "custom" and
   * the call's inline custom_rules — in ONE pass, sharing one regex budget,
   * so the whole call is bounded exactly like a single bundle. The overall
   * verdict is the same arithmetic as a single bundle applied to every rule
   * that ran (weighted score against the threshold, critical veto across
   * all bundles); `categories` carries the same arithmetic per bundle.
   */
  async evaluateAll(context: EvalContext, customRules?: CustomRuleDefinition[]): Promise<EvalResult> {
    const rules: EvalRule[] = [];
    const categories: EvalType[] = [];
    for (const type of ALL_EVAL_TYPES) {
      for (const rule of [...getRulesForType(type), ...(this.additionalRules.get(type) ?? [])]) {
        rules.push(rule);
        categories.push(type);
      }
    }
    for (const def of customRules ?? []) {
      rules.push(createCustomRule(def));
      categories.push('custom');
    }
    return this.run('all', rules, categories, context);
  }

  /*
   * Async from 0.10.0. Nothing it awaits yet: every rule the package ships
   * is synchronous, and `EvalRule.evaluate` stays synchronous so the type
   * system keeps proving that a deterministic rule cannot reach the network
   * — which is what makes "evaluate_output never spends" a compile-time
   * fact rather than a test. The signature moves first, in one mechanical
   * change, so the judgment rule that DOES call a provider can be added
   * without re-touching every caller a second time.
   */
  private async run(
    evalType: EvalResultType,
    rules: EvalRule[],
    categories: EvalType[] | undefined,
    context: EvalContext,
  ): Promise<EvalResult> {
    // Merge system-level thresholds into customConfig (user-provided values take precedence)
    if (this.ruleThresholds) {
      context = {
        ...context,
        customConfig: { ...this.ruleThresholds, ...context.customConfig },
      };
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
        verdict: { state: 'unknown', passed: false, basis: 'no_rules', by: [], risk: null },
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
    const evalContext: EvalContext = { ...context, regexBudget: { breaches: 0 }, steps: toSteps(context) };
    /*
     * Sequential, and it must stay sequential when a rule becomes awaitable:
     * every rule in one evaluation shares the regex circuit breaker above,
     * and running them concurrently would race the breach count that bounds
     * a hostile output.
     */
    const ruleResults: EvalRuleResult[] = [];
    for (const [i, rule] of rules.entries()) {
      /*
       * A judgment rule calls a provider and costs money. It runs only when
       * the caller has said this evaluation may spend — which the free
       * evaluation path never does. Enforced here, on the one path every
       * evaluation takes, so no tool can forget it and no future rule can
       * quietly opt itself in.
       */
      const raw =
        rule.kind === 'judgment' && evalContext.allowPaid !== true
          ? {
              ruleName: rule.name,
              passed: false,
              score: 0,
              message: 'Judgment rules are not run on this path: it may not call a paid provider.',
              skipped: true,
              skipReason: 'this evaluation may not spend (context.allowPaid is not set)',
            }
          : rule.evaluate(evalContext);
      const ruleId = this.idByRule.get(rule);
      /*
       * The bundle this rule ran under. `categories` is only supplied for
       * eval_type="all"; for a single bundle the rule's own evalType is the
       * answer and is just as true. It used to be left off, which meant a
       * single-bundle call could not tell a custom rule from a built-in one
       * — and the composer needs that, because a custom rule's severity is
       * the deployment's own statement of how much it matters.
       */
      const category = categories?.[i] ?? (evalType === 'all' ? rule.evalType : evalType);
      /*
       * Every result says whether THIS rule vetoes and who decided that.
       * Without it, a reader holding a failed evaluation cannot tell a
       * hard violation from a merely low score without knowing the rule
       * library by heart — and once eval.criticalRules exists, cannot tell
       * a shipped default from their own promotion at all. Stamped here, on
       * the one path every evaluation takes, so a surface cannot render the
       * declared criticality where the engine applied a configured one.
       */
      const effective = this.criticality(rule);
      const { critical, source } = effective;
      // ruleId / category sit right after the name so a reader scanning
      // rule_results sees WHICH deployed rule (and which bundle) spoke.
      const { ruleName, ...rest } = raw;
      /*
       * The stamp (0.9.0): what kind of claim this is, what the composer
       * did with it, which question it answers, what it saw, why it skipped,
       * and how wrong it tends to be — from the rule's declaration, the
       * inputs this call carried, and the published accuracy that ships in
       * the package. Computed here, on the one path every evaluation takes,
       * so no surface can show a result without its receipt. It changes no
       * verdict: summarize() below still decides passed exactly as before.
       */
      ruleResults.push({
        ruleName,
        ...(ruleId !== undefined ? { ruleId } : {}),
        ...(category !== undefined ? { category } : {}),
        critical,
        criticalSource: source,
        ...rest,
        ...stampRuleResult(rule, raw, context, effective),
      });
    }

    const overall = this.summarize(rules, ruleResults);
    const perCategory = categories ? this.categorize(rules, ruleResults, categories) : undefined;

    /*
     * The receipt for the whole evaluation (0.9.0): what produced it, which
     * questions it judged, and the basis of its verdict. Computed here from
     * what the engine already holds; persisted as provenance and derived
     * again on every read, so a stored row answers "why did this pass on
     * that day" without a backfill. Changes no verdict.
     */
    const provenance = buildProvenance({
      irisVersion: PKG_VERSION,
      rulesetHash: rulesetHash(rules, (r) => this.criticality(r)),
      configHash: configHash({
        threshold: this.threshold,
        ruleThresholds: this.ruleThresholds,
        criticalRules: this.criticalityOverrides?.criticalRules,
        nonCriticalRules: this.criticalityOverrides?.nonCriticalRules,
      }),
      threshold: this.threshold,
      ruleThresholds: this.ruleThresholds,
      judgedAt: new Date().toISOString(),
    });
    const coverage = deriveCoverage(ruleResults, inputsPresent(context));

    // Handle "all rules skipped" — insufficient data
    if (overall.rulesEvaluated === 0) {
      const skipMessages = ruleResults
        .filter((r) => r.skipped)
        .map((r) => `[${r.ruleName}] ${r.skipReason ?? r.message}`);
      // Same field as the main path below: the tool description promises
      // that EVERY critical rule that skipped is named here, and a caller
      // whose only rules were critical ones should not have to infer that
      // from insufficient_data alone.
      const unknown: EvalResult = {
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
        rules_skipped: overall.rulesSkipped,
        insufficient_data: true,
        ...(overall.criticalSkipped.length > 0 ? { critical_skipped: overall.criticalSkipped } : {}),
        ...(perCategory ? { categories: perCategory } : {}),
        coverage,
        provenance,
      };
      return this.decide(unknown);
    }

    const suggestions: string[] = [];
    for (const result of ruleResults) {
      if (!result.passed && !result.skipped) {
        suggestions.push(`[${result.ruleName}] ${result.message}`);
      }
    }
    if (overall.criticalFailures.length > 0 && overall.score >= this.threshold) {
      suggestions.push(
        `Critical rule(s) failed (${overall.criticalFailures.join(', ')}) — passed=false regardless of the weighted score`,
      );
    }
    if (overall.rulesSkipped > 0) {
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
        `${overall.rulesSkipped} rule(s) skipped — excluded from the weighted score: ${skippedParts.join('; ')}`,
      );
    }
    if (overall.criticalSkipped.length > 0) {
      suggestions.push(
        `Critical rule(s) did NOT judge this output (${overall.criticalSkipped.join(', ')}) — ` +
          'they skipped, so they could not veto. This evaluation is "unknown" on those ' +
          'checks, not "clean"; a gate that must fail closed should treat critical_skipped ' +
          'as a failure.',
      );
    }

    const result: EvalResult = {
      id: generateEvalId(),
      eval_type: evalType,
      output_text: context.output,
      expected_text: context.expected,
      score: Math.round(overall.score * 1000) / 1000,
      passed: overall.passed,
      rule_results: ruleResults,
      suggestions,
      rules_evaluated: overall.rulesEvaluated,
      rules_skipped: overall.rulesSkipped,
      insufficient_data: false,
      ...(overall.criticalFailures.length > 0 ? { critical_failures: overall.criticalFailures } : {}),
      ...(overall.criticalSkipped.length > 0 ? { critical_skipped: overall.criticalSkipped } : {}),
      ...(perCategory ? { categories: perCategory } : {}),
      coverage,
      provenance,
    };
    return this.decide(result);
  }

  /**
   * Weighted average over the rules that ran, plus the critical veto.
   *
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
   *
   * A critical rule that SKIPPED is the fail-open seam between the
   * release's two headline features: an adversary who knows a deployed
   * critical regex can craft output that stalls it past the sandbox
   * budget, and the rule then neither judges nor vetoes — so the eval
   * returns passed=true with an EMPTY critical_failures on output that
   * nobody actually cleared. The trade-off is deliberate (failing closed
   * would let the same adversary force false violations on benign
   * output), but before `criticalSkipped` the only trace of it was a
   * suggestions line — prose. A gate that must fail closed should not
   * have to walk rule_results[].budgetExceeded to discover it was defeated.
   */
  private summarize(rules: EvalRule[], ruleResults: EvalRuleResult[]): Verdict {
    const evaluatedIndices: number[] = [];
    const skippedIndices: number[] = [];
    for (let i = 0; i < ruleResults.length; i++) {
      if (ruleResults[i].skipped) {
        skippedIndices.push(i);
      } else {
        evaluatedIndices.push(i);
      }
    }

    const criticalSkipped = skippedIndices
      .filter((i) => this.criticality(rules[i]).critical)
      .map((i) => ruleResults[i].ruleName);

    if (evaluatedIndices.length === 0) {
      return {
        score: 0,
        passed: false,
        rulesEvaluated: 0,
        rulesSkipped: skippedIndices.length,
        criticalFailures: [],
        criticalSkipped,
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

    const criticalFailures = evaluatedIndices
      .filter((i) => this.criticality(rules[i]).critical && !ruleResults[i].passed)
      .map((i) => ruleResults[i].ruleName);

    return {
      score,
      passed: score >= this.threshold && criticalFailures.length === 0,
      rulesEvaluated: evaluatedIndices.length,
      rulesSkipped: skippedIndices.length,
      criticalFailures,
      criticalSkipped,
    };
  }

  /** The per-bundle breakdown for eval_type="all": summarize() over each bundle's slice. */
  private categorize(
    rules: EvalRule[],
    ruleResults: EvalRuleResult[],
    categories: EvalType[],
  ): Partial<Record<EvalType, EvalCategoryResult>> {
    const breakdown: Partial<Record<EvalType, EvalCategoryResult>> = {};
    for (const type of ALL_EVAL_TYPES) {
      const indices = categories.flatMap((c, i) => (c === type ? [i] : []));
      if (indices.length === 0) continue;
      const verdict = this.summarize(
        indices.map((i) => rules[i]),
        indices.map((i) => ruleResults[i]),
      );
      /*
       * A bundle whose every rule skipped was not judged (#406). Reporting
       * it as passed:false / score:0 read as "failing" to anyone regrouping
       * by category — cost "failed" on a call that carried no cost data.
       * Inside the breakdown, null is the honest value: neither passing
       * nor failing, and it never counted toward the overall verdict
       * (summarize() already excludes skipped rules). The TOP-LEVEL
       * `passed` is deliberately not made nullable — it is the verdict a
       * gate keys on, and a gate must fail closed when nothing was judged;
       * `insufficient_data: true` is the "unknown" marker at that level.
       */
      const judged = verdict.rulesEvaluated > 0;
      breakdown[type] = {
        score: judged ? Math.round(verdict.score * 1000) / 1000 : null,
        passed: judged ? verdict.passed : null,
        rules_evaluated: verdict.rulesEvaluated,
        rules_skipped: verdict.rulesSkipped,
        insufficient_data: !judged,
        ...(verdict.criticalFailures.length > 0 ? { critical_failures: verdict.criticalFailures } : {}),
        ...(verdict.criticalSkipped.length > 0 ? { critical_skipped: verdict.criticalSkipped } : {}),
      };
    }
    return breakdown;
  }
}
