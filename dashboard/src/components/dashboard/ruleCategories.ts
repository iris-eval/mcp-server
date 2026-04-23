/*
 * ruleCategories — vendored mapping of built-in rule names → category.
 *
 * Mirrors iris/src/eval/rules/{safety,relevance,completeness,cost}.ts as
 * of v0.3.1. Keep in sync when the rule library expands. The mapping
 * lives client-side because the eval-stats endpoint returns rule names
 * but not categories.
 *
 * Synced: 2026-04-23 (v0.3.1 — 13 rules)
 */

export type RuleCategory = 'safety' | 'relevance' | 'completeness' | 'cost' | 'custom';

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
    description: 'PII, prompt injection, blocklist, stub-output detection',
  },
  relevance: {
    id: 'relevance',
    label: 'Relevance',
    color: 'var(--eval-warn)',
    description: 'Hallucination, fabricated citations, on-topic checks',
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
    description: 'Per-trace USD threshold + token efficiency',
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
 * v0.3.1 built-in rule → category map.
 * Total: 13 rules (4 safety + 3 relevance + 4 completeness + 2 cost).
 */
export const BUILT_IN_RULE_CATEGORY: Record<string, RuleCategory> = {
  // safety (4)
  no_pii: 'safety',
  no_blocklist_words: 'safety',
  no_injection_patterns: 'safety',
  no_stub_output: 'safety',
  // relevance (3)
  keyword_overlap: 'relevance',
  no_hallucination_markers: 'relevance',
  topic_consistency: 'relevance',
  // completeness (4)
  min_output_length: 'completeness',
  non_empty_output: 'completeness',
  sentence_count: 'completeness',
  expected_coverage: 'completeness',
  // cost (2)
  cost_under_threshold: 'cost',
  token_efficiency: 'cost',
};

/** Authoritative roster of built-in rules in canonical display order. */
export const BUILT_IN_RULES: ReadonlyArray<{ name: string; category: RuleCategory }> = [
  { name: 'no_pii', category: 'safety' },
  { name: 'no_blocklist_words', category: 'safety' },
  { name: 'no_injection_patterns', category: 'safety' },
  { name: 'no_stub_output', category: 'safety' },
  { name: 'no_hallucination_markers', category: 'relevance' },
  { name: 'keyword_overlap', category: 'relevance' },
  { name: 'topic_consistency', category: 'relevance' },
  { name: 'min_output_length', category: 'completeness' },
  { name: 'non_empty_output', category: 'completeness' },
  { name: 'sentence_count', category: 'completeness' },
  { name: 'expected_coverage', category: 'completeness' },
  { name: 'cost_under_threshold', category: 'cost' },
  { name: 'token_efficiency', category: 'cost' },
];
