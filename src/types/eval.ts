export type EvalType = 'completeness' | 'relevance' | 'safety' | 'cost' | 'custom';

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
}

export interface EvalRuleResult {
  ruleName: string;
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
}

export interface EvalResult {
  id: string;
  trace_id?: string;
  eval_type: EvalType;
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
