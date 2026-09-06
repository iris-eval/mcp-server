/*
 * ruleCategories — built-in rule names → category.
 *
 * The LIVE map comes from the server: GET /api/v1/rules/builtin is derived
 * from the engine's own rule registry (useRuleCategoryMap). The table
 * below is the FALLBACK used until that request resolves (and in tests),
 * and it is pinned to the engine by a root-level test
 * (tests/unit/dashboard/rule-categories-sync.test.ts) that fails the build
 * the moment a rule is added, removed, or moved between bundles without
 * updating this file. Two charts used to classify "safety" by name
 * substring and missed no_hallucination_markers for a whole release — the
 * sync test plus the server-derived map is what closes that class.
 */
import type { MomentSignificanceKind } from '../../api/types';

export type RuleCategory = 'safety' | 'relevance' | 'completeness' | 'cost' | 'custom';

/**
 * The significance kind a failed rule drills through to. Mirrors the
 * server's classifier (src/eval/decision-moment.ts): a failed rule from
 * the safety bundle is a safety-violation, the cost bundle maps to
 * cost-spike, everything else — including rules the map does not know —
 * lands on normal-fail.
 */
export function ruleToSignificanceKind(
  rule: string,
  categories: Record<string, RuleCategory>,
): MomentSignificanceKind {
  switch (categories[rule]) {
    case 'safety':
      return 'safety-violation';
    case 'cost':
      return 'cost-spike';
    default:
      return 'normal-fail';
  }
}

export interface CategoryMeta {
  id: RuleCategory;
  label: string;
  /** Hex color from the eval-semantic palette, used inline in dashboard. */
  color: string;
  /** One-line description shown in the rule list header. */
  description: string;
}

export const CATEGORY_META: Record<RuleCategory, CategoryMeta> = {
  safety: {
    id: 'safety',
    label: 'Safety',
    color: 'var(--eval-fail)',
    description: 'PII, prompt injection, hallucination, blocklist, stub-output and silent-tool-failure detection',
  },
  relevance: {
    id: 'relevance',
    label: 'Relevance',
    color: 'var(--eval-warn)',
    description: 'Keyword overlap and on-topic checks against the input',
  },
  completeness: {
    id: 'completeness',
    label: 'Completeness',
    color: 'var(--eval-tool)',
    description: 'Length, structure, expected-content coverage',
  },
  cost: {
    id: 'cost',
    label: 'Cost',
    color: 'var(--iris-400)',
    description: 'Per-trace USD threshold, token efficiency, repeated tool calls',
  },
  custom: {
    id: 'custom',
    label: 'Custom Rules',
    color: 'var(--iris-500)',
    description: 'User-deployed via Make-This-A-Rule',
  },
};

export const CATEGORY_ORDER: RuleCategory[] = [
  'safety',
  'relevance',
  'completeness',
  'cost',
  'custom',
];

/**
 * Built-in rule → category map.
 * Total: 15 rules (6 safety + 2 relevance + 4 completeness + 3 cost).
 */
export const BUILT_IN_RULE_CATEGORY: Record<string, RuleCategory> = {
  // safety (7)
  no_pii: 'safety',
  no_blocklist_words: 'safety',
  no_injection_patterns: 'safety',
  no_stub_output: 'safety',
  no_hallucination_markers: 'safety',
  no_silent_tool_failure: 'safety',
  grounded_in_reads: 'safety',
  // relevance (2)
  keyword_overlap: 'relevance',
  topic_consistency: 'relevance',
  // completeness (5)
  min_output_length: 'completeness',
  non_empty_output: 'completeness',
  sentence_count: 'completeness',
  expected_coverage: 'completeness',
  valid_tool_arguments: 'completeness',
  // cost (3)
  cost_under_threshold: 'cost',
  verbosity_ratio: 'cost',
  no_tool_loop: 'cost',
};

/** Authoritative roster of built-in rules in canonical display order. */
export const BUILT_IN_RULES: ReadonlyArray<{ name: string; category: RuleCategory }> = [
  { name: 'no_pii', category: 'safety' },
  { name: 'no_blocklist_words', category: 'safety' },
  { name: 'no_injection_patterns', category: 'safety' },
  { name: 'no_stub_output', category: 'safety' },
  { name: 'no_hallucination_markers', category: 'safety' },
  { name: 'no_silent_tool_failure', category: 'safety' },
  { name: 'grounded_in_reads', category: 'safety' },
  { name: 'keyword_overlap', category: 'relevance' },
  { name: 'topic_consistency', category: 'relevance' },
  { name: 'min_output_length', category: 'completeness' },
  { name: 'non_empty_output', category: 'completeness' },
  { name: 'sentence_count', category: 'completeness' },
  { name: 'expected_coverage', category: 'completeness' },
  { name: 'valid_tool_arguments', category: 'completeness' },
  { name: 'cost_under_threshold', category: 'cost' },
  { name: 'verbosity_ratio', category: 'cost' },
  { name: 'no_tool_loop', category: 'cost' },
];
