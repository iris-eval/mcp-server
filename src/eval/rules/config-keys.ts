/*
 * Canonical config keys for custom rule types — the SINGLE source of truth.
 *
 * This module exists because the keys drifted across three surfaces and
 * shipped broken: the evaluator read `config.min_length`, while the
 * `deploy_rule` tool description (the text an LLM agent reads to construct
 * its call) told agents to send `config.min`, and `docs/api-reference.md`
 * showed `{ "min": 40 }`. Deploy-time validation accepted any object, so a
 * rule built from our own documentation deployed cleanly and then failed on
 * every evaluation forever.
 *
 * The evaluator, the deploy-time validator, and the tool description now all
 * derive from this map, so a key cannot be correct in one place and wrong in
 * another. The first entry of each list is CANONICAL (what docs should
 * teach); the rest are accepted aliases kept for compatibility with configs
 * created from earlier, incorrect documentation.
 */

export const CUSTOM_RULE_CONFIG_KEYS = {
  min_length: ['min_length', 'length', 'min'],
  max_length: ['max_length', 'length', 'max'],
  cost_threshold: ['max_cost', 'max_usd'],
} as const;

/** First key is the canonical one to document and teach. */
export function canonicalKey(type: keyof typeof CUSTOM_RULE_CONFIG_KEYS): string {
  return CUSTOM_RULE_CONFIG_KEYS[type][0];
}

/**
 * Read the first defined numeric value among a rule type's accepted keys.
 * Returns undefined when none is present, so callers can raise a config error.
 */
export function readNumericConfig(
  config: Record<string, unknown>,
  type: keyof typeof CUSTOM_RULE_CONFIG_KEYS,
): number | undefined {
  for (const key of CUSTOM_RULE_CONFIG_KEYS[type]) {
    const value = config[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return undefined;
}

/** Human-readable "config.a (or config.b)" for error messages. */
export function describeKeys(type: keyof typeof CUSTOM_RULE_CONFIG_KEYS): string {
  const [first, ...rest] = CUSTOM_RULE_CONFIG_KEYS[type];
  return rest.length ? `config.${first} (aliases: ${rest.map((k) => `config.${k}`).join(', ')})` : `config.${first}`;
}
