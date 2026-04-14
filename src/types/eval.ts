export type EvalType = 'completeness' | 'relevance' | 'safety' | 'cost' | 'custom';

export interface EvalRule {
  name: string;
  description: string;
  evalType: EvalType;
  weight: number;
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
