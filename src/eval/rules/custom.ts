import isSafeRegex from 'safe-regex2';
import type { EvalRule, EvalContext, EvalRuleResult, CustomRuleDefinition } from '../../types/eval.js';
import type { RuleSeverity } from '../../types/custom-rule.js';
import { readNumericConfig, describeKeys } from './config-keys.js';
import { sandboxedRegexTest, REGEX_MATCH_BUDGET_MS } from './regex-sandbox.js';

const MAX_PATTERN_LENGTH = 1000;

// A rule whose CONFIG is invalid has not evaluated the output — it could not
// run at all. Returning `passed:false, score:0` for that case conflates "your
// agent produced bad output" with "this rule is broken", and because the
// engine weights every non-skipped result, one misconfigured rule silently
// deflates every eval score for as long as it stays deployed (and gives no
// hint which of the two happened). Mark it skipped: the engine already
// excludes skipped rules from the weighted average and surfaces skipReason,
// the same contract `expected_coverage` uses when no expected output exists.
//
// Deploy-time validation in custom-rule-store.ts now rejects these configs
// outright; this path remains the safety net for rules already persisted in
// a user's ~/.iris/custom-rules.json from before that validation existed.
//
// configInvalid distinguishes this skip from a legitimate one: config
// errors depend only on the definition, never the input, so a caller that
// holds the whole definition (the rule-preview endpoint) can reject it
// as a 422 instead of reporting every trace as "would skip".
function configError(definition: CustomRuleDefinition, message: string): EvalRuleResult {
  return {
    ruleName: definition.name,
    passed: false,
    score: 0,
    message,
    skipped: true,
    skipReason: message,
    configInvalid: true,
  };
}

function safeRegexResult(definition: CustomRuleDefinition, message: string): EvalRuleResult {
  return configError(definition, message);
}

/*
 * Validates a user pattern and returns the normalized {pattern, flags} pair —
 * NOT a compiled RegExp, deliberately. The pattern is compiled here once for
 * syntax validation (compilation does not backtrack), but matching happens in
 * the sandbox worker (regex-sandbox.ts), which compiles its own copy. Nothing
 * on the main thread may ever call `.test()`/`.exec()` on a user pattern: the
 * static checks below are best-effort UX (fast rejection with a good message),
 * not the safety boundary. safe-regex2 is star-height-only — `(a|a)*$` passes
 * it and is exponential — and no static or probe-based check is sound in
 * general. The sandbox's hard deadline is the boundary.
 */
function validateRegex(
  definition: CustomRuleDefinition,
): { pattern: string; flags: string } | EvalRuleResult {
  let patternStr = definition.config.pattern as string;
  let flags = (definition.config.flags as string) ?? '';

  // Defensive UX: convert leading inline flag like `(?i)` or `(?im)` to a
  // real flags arg. Node's RegExp engine does not support inline flag
  // groups in older versions, and a user pasting `(?i)foo` from a regex
  // tutorial would otherwise hit "Invalid group" with no clear recovery.
  const inlineFlagMatch = patternStr.match(/^\(\?([imsugy]+)\)/);
  if (inlineFlagMatch) {
    const inlineFlags = inlineFlagMatch[1];
    flags = [...new Set((flags + inlineFlags).split(''))].join('');
    patternStr = patternStr.slice(inlineFlagMatch[0].length);
  }

  if (patternStr.length > MAX_PATTERN_LENGTH) {
    return safeRegexResult(definition, `Regex pattern too long (${patternStr.length} > ${MAX_PATTERN_LENGTH})`);
  }
  // Syntax BEFORE safety: safe-regex2 returns false for anything it cannot
  // parse, so checking it first reports a plainly broken pattern like `(` as
  // "catastrophic backtracking" — sending the author hunting a performance
  // problem they do not have instead of the typo they do.
  try {
    new RegExp(patternStr, flags);
  } catch (e) {
    return safeRegexResult(definition, `Invalid regex syntax: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
  if (!isSafeRegex(patternStr)) {
    return safeRegexResult(definition, 'Regex pattern rejected: potentially unsafe (catastrophic backtracking)');
  }
  return { pattern: patternStr, flags };
}

/*
 * Budget breach is a property of pattern×input, not of the definition alone —
 * the same pattern can be instant on one output and superlinear on the next
 * (often one CRAFTED to stall it). So this is not configInvalid: the preview
 * endpoint must not 422 a rule that merely met a hostile input. It follows the
 * configError precedent instead: SKIPPED, because a rule whose match was
 * killed mid-backtrack has not judged the output, and a skipped rule neither
 * deflates the weighted score nor (for high/critical deployed rules) vetoes
 * the eval on evidence it never gathered. The skipReason tells the author
 * exactly what to fix, and the engine already surfaces it in suggestions.
 */
function budgetExceededResult(definition: CustomRuleDefinition): EvalRuleResult {
  const message =
    `Regex evaluation terminated: pattern exceeded the ${REGEX_MATCH_BUDGET_MS}ms matching ` +
    `budget on this output (superlinear backtracking) and was killed in its sandbox worker. ` +
    `The rule did not judge this output. Rewrite the pattern to avoid ambiguous repetition ` +
    `— e.g. bound quantifiers (\\s{0,8} not \\s*) and remove overlapping alternatives.`;
  return {
    ruleName: definition.name,
    passed: false,
    score: 0,
    message,
    skipped: true,
    skipReason: message,
  };
}

/**
 * Builds a runnable EvalRule from a persisted/inline definition.
 *
 * `severity` comes from the DEPLOYED rule's metadata (deploy_rule / the
 * dashboard composer). high/critical severities make the rule CRITICAL:
 * a failing evaluation forces the overall eval to passed=false regardless
 * of the weighted score. Before this, a rule-author could deploy a
 * severity="critical" policy rule, watch it FAIL on a violating output,
 * and still get passed:true (score 0.895) — severity affected nothing but
 * dashboard sorting. Inline custom_rules (evaluate_output's per-call
 * definitions) carry no severity and stay weight-only.
 */
export function createCustomRule(definition: CustomRuleDefinition, severity?: RuleSeverity): EvalRule {
  return {
    name: definition.name,
    description: `Custom rule: ${definition.name}`,
    evalType: 'custom',
    weight: definition.weight ?? 1,
    critical: severity === 'high' || severity === 'critical',
    evaluate(context: EvalContext): EvalRuleResult {
      switch (definition.type) {
        case 'regex_match': {
          const validated = validateRegex(definition);
          if ('ruleName' in validated) return validated;
          const outcome = sandboxedRegexTest(validated.pattern, validated.flags, context.output);
          if (outcome.kind !== 'match') return budgetExceededResult(definition);
          const passed = outcome.matched;
          return { ruleName: definition.name, passed, score: passed ? 1 : 0, message: passed ? 'Regex pattern matched' : 'Regex pattern did not match' };
        }
        case 'regex_no_match': {
          const validated = validateRegex(definition);
          if ('ruleName' in validated) return validated;
          const outcome = sandboxedRegexTest(validated.pattern, validated.flags, context.output);
          if (outcome.kind !== 'match') return budgetExceededResult(definition);
          const passed = !outcome.matched;
          return { ruleName: definition.name, passed, score: passed ? 1 : 0, message: passed ? 'Forbidden pattern not found' : 'Forbidden pattern found in output' };
        }
        case 'min_length': {
          const min = readNumericConfig(definition.config, 'min_length');
          if (min == null || min <= 0) {
            return configError(definition, `min_length rule requires ${describeKeys('min_length')} (positive number)`);
          }
          const passed = context.output.length >= min;
          return { ruleName: definition.name, passed, score: passed ? 1 : context.output.length / min, message: passed ? `Length (${context.output.length}) meets minimum (${min})` : `Length (${context.output.length}) below minimum (${min})` };
        }
        case 'max_length': {
          const max = readNumericConfig(definition.config, 'max_length');
          if (max == null || max <= 0) {
            return configError(definition, `max_length rule requires ${describeKeys('max_length')} (positive number)`);
          }
          const passed = context.output.length <= max;
          return { ruleName: definition.name, passed, score: passed ? 1 : max / context.output.length, message: passed ? `Length (${context.output.length}) within maximum (${max})` : `Length (${context.output.length}) exceeds maximum (${max})` };
        }
        case 'contains_keywords': {
          const keywords = definition.config.keywords as string[] | undefined;
          if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
            return configError(definition, 'contains_keywords rule requires config.keywords (non-empty string array)');
          }
          const lower = context.output.toLowerCase();
          const found = keywords.filter((k) => lower.includes(k.toLowerCase()));
          const ratio = found.length / keywords.length;
          const passed = ratio >= ((definition.config.threshold as number) ?? 1);
          return { ruleName: definition.name, passed, score: ratio, message: `Found ${found.length}/${keywords.length} required keywords` };
        }
        case 'excludes_keywords': {
          const keywords = definition.config.keywords as string[] | undefined;
          if (!keywords || !Array.isArray(keywords) || keywords.length === 0) {
            return configError(definition, 'excludes_keywords rule requires config.keywords (non-empty string array)');
          }
          const lower = context.output.toLowerCase();
          const found = keywords.filter((k) => lower.includes(k.toLowerCase()));
          const passed = found.length === 0;
          return { ruleName: definition.name, passed, score: passed ? 1 : 0, message: passed ? 'No excluded keywords found' : `Found excluded keywords: ${found.join(', ')}` };
        }
        case 'json_schema': {
          try {
            JSON.parse(context.output);
            return { ruleName: definition.name, passed: true, score: 1, message: 'Output is valid JSON' };
          } catch {
            return { ruleName: definition.name, passed: false, score: 0, message: 'Output is not valid JSON' };
          }
        }
        case 'cost_threshold': {
          const max = readNumericConfig(definition.config, 'cost_threshold');
          if (max == null || max < 0) {
            return configError(definition, `cost_threshold rule requires ${describeKeys('cost_threshold')} (non-negative number)`);
          }
          const cost = context.costUsd ?? 0;
          const passed = cost <= max;
          return { ruleName: definition.name, passed, score: passed ? 1 : 0, message: passed ? `Cost ($${cost}) within threshold ($${max})` : `Cost ($${cost}) exceeds threshold ($${max})` };
        }
        default:
          return configError(definition, `Unknown rule type: ${definition.type}`);
      }
    },
  };
}
