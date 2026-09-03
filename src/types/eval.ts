export type EvalType = 'completeness' | 'relevance' | 'safety' | 'cost' | 'custom';

/**
 * What an EvalResult can be tagged as: a single bundle (EvalType), or
 * 'all' — evaluate_output's eval_type="all", which runs every bundle in one
 * pass and reports a per-category breakdown beside the overall verdict.
 * Kept apart from EvalType on purpose: rules are deployed and registered
 * under a real bundle, never under 'all'.
 */
export type EvalResultType = EvalType | 'all';

export interface EvalRule {
  name: string;
  description: string;
  evalType: EvalType;
  weight: number;
  /**
   * Hard-fail marker. When a critical rule FAILS (and was not skipped), the
   * overall eval reports passed=false regardless of the weighted score.
   *
   * Exists because the weighted average routinely outvotes a genuine
   * violation: an output leaking a real SSN failed no_pii while the other
   * safety rules passed, scoring ~0.765 — above the 0.7 threshold — so the
   * one field every CI gate reads said passed:true about the product's
   * flagship failure scenario. The score stays a quality gradient; `passed`
   * is the verdict, and a critical violation must never be averaged away.
   */
  critical?: boolean;
  evaluate(context: EvalContext): EvalRuleResult;
}

export interface EvalContext {
  output: string;
  expected?: string;
  input?: string;
  toolCalls?: Array<{ tool_name: string; input?: unknown; output?: unknown }>;
  tokenUsage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
  costUsd?: number;
  metadata?: Record<string, unknown>;
  customConfig?: Record<string, unknown>;
  /**
   * Per-evaluation regex circuit breaker, initialized by the engine (never
   * by callers). Each sandbox budget breach increments `breaches`; once it
   * reaches the cap, remaining regex rules in the SAME evaluation skip
   * without running. Bounds how long a single hostile output can stall a
   * request: without it, N regex rules × (budget + worker respawn) of
   * main-thread stall scale linearly with N.
   */
  regexBudget?: { breaches: number };
}

export interface EvalRuleResult {
  ruleName: string;
  /**
   * Deployed rule id (rule-<hex>) when the rule came from the custom-rule
   * store. Absent for built-in rules and for inline custom_rules. Names are
   * not unique — a same-name redeploy with replace:true mints a new id, and
   * stores written before the same-name guard may hold duplicates — so this
   * is the field that tells two same-named results apart (#373).
   */
  ruleId?: string;
  /**
   * The bundle this rule belongs to. Present only on eval_type="all"
   * results, where rule_results spans every bundle and a reader needs to
   * regroup them.
   */
  category?: EvalType;
  passed: boolean;
  score: number;
  message: string;
  skipped?: boolean;
  skipReason?: string;
  // Set when the rule skipped because its DEFINITION is broken (invalid
  // config / uncompilable regex), not because this input had nothing to
  // evaluate. Lets surfaces holding the whole definition — rule preview —
  // reject it outright instead of reporting every trace as "would skip".
  configInvalid?: boolean;
  // Set when the rule skipped because its regex exceeded the sandbox
  // matching budget ON THIS OUTPUT (or the per-evaluation circuit breaker
  // was already open). Distinct from configInvalid and from missing-context
  // skips on purpose: an output CRAFTED to stall a policy pattern lands
  // here, so a consumer that must fail closed can treat budgetExceeded
  // skips as failures on its own terms. Without this flag, "the pattern
  // was defeated" is indistinguishable from "nothing to evaluate".
  budgetExceeded?: boolean;
}

/**
 * Per-bundle verdict inside an eval_type="all" result. Same semantics as a
 * single-bundle EvalResult (threshold + critical veto), computed over that
 * bundle's rules only.
 */
export interface EvalCategoryResult {
  score: number;
  passed: boolean;
  rules_evaluated: number;
  rules_skipped: number;
  insufficient_data: boolean;
  critical_failures?: string[];
  critical_skipped?: string[];
}

export interface EvalResult {
  id: string;
  trace_id?: string;
  eval_type: EvalResultType;
  output_text: string;
  expected_text?: string;
  score: number;
  passed: boolean;
  rule_results: EvalRuleResult[];
  suggestions: string[];
  created_at?: string;
  rules_evaluated?: number;
  rules_skipped?: number;
  insufficient_data?: boolean;
  /**
   * Names of critical rules that failed (present only when non-empty).
   * Any entry here forces passed=false regardless of the weighted score —
   * this field is how a caller tells "failed the quality bar" apart from
   * "committed a hard violation".
   */
  critical_failures?: string[];
  /**
   * Names of critical rules that were SKIPPED and therefore did not judge
   * this output (present only when non-empty). Almost always a sandbox
   * budget breach — a regex killed mid-backtrack, which an adversary can
   * provoke deliberately by crafting output that stalls a known pattern.
   *
   * This is the fail-open seam between the release's two headline features:
   * a budget-killed critical rule does NOT veto, so the evaluation can
   * return passed=true with no `critical_failures` at all. That is
   * deliberate (failing closed would let the same adversary force false
   * violations on benign output), but a consumer that must fail closed
   * needs to see it WITHOUT walking rule_results[].budgetExceeded. Treat a
   * non-empty `critical_skipped` as "unknown", not as "clean".
   */
  critical_skipped?: string[];
  /**
   * Per-bundle breakdown, present only when eval_type is 'all'. Keyed by
   * bundle; a bundle with no rules at all (nothing deployed under "custom"
   * and no inline custom_rules) is absent rather than reported as
   * insufficient. Response-only — not persisted as a column; the stored
   * rule_results carry a `category` per rule so a reader can regroup.
   */
  categories?: Partial<Record<EvalType, EvalCategoryResult>>;
}

export type CustomRuleType =
  | 'regex_match'
  | 'regex_no_match'
  | 'min_length'
  | 'max_length'
  | 'contains_keywords'
  | 'excludes_keywords'
  | 'json_schema'
  | 'cost_threshold';

export interface CustomRuleDefinition {
  name: string;
  type: CustomRuleType;
  config: Record<string, unknown>;
  weight?: number;
}
