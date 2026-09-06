import isSafeRegex from 'safe-regex2';
import type { EvalRule, EvalContext, EvalRuleResult, CustomRuleDefinition, CustomRuleType, Mechanism, Need } from '../../types/eval.js';
import type { RuleSeverity } from '../../types/custom-rule.js';
import { readNumericConfig, describeKeys } from './config-keys.js';
import { sandboxedRegexTest, REGEX_MATCH_BUDGET_MS } from './regex-sandbox.js';
import { MAX_PATTERN_LENGTH, regexBacktrackingBudgetExceeded } from './regex-budget.js';
import { checkArguments, compileToolSchema } from '../schema-validator.js';


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

/**
 * `config.keywords` as a non-empty array of strings, or undefined when it
 * is anything else. Element types are checked at runtime because the
 * inline schema accepts any config value: `keywords: [1, 2]` passed the
 * old Array.isArray check and then threw from `.toLowerCase()` mid-eval.
 */
function readKeywordList(config: Record<string, unknown>): string[] | undefined {
  const value = config.keywords;
  if (!Array.isArray(value) || value.length === 0) return undefined;
  if (!value.every((k): k is string => typeof k === 'string')) return undefined;
  return value;
}

/**
 * Converts a leading inline flag group like `(?i)` or `(?im)` into a real
 * flags argument. Node's RegExp engine does not support inline flag groups,
 * and a user pasting `(?i)foo` from a regex tutorial would otherwise hit
 * "Invalid group" with no clear recovery.
 *
 * Exported so deploy-time validation (custom-rule-store) probes the SAME
 * pattern+flags pair the evaluator will actually run — the store used to
 * strip the inline group but not merge its flags, probing `(?i)…` under
 * different flags than evaluation used.
 */
export function normalizeRegexSource(
  patternStr: string,
  flags: string,
): { pattern: string; flags: string } {
  const inlineFlagMatch = patternStr.match(/^\(\?([imsugy]+)\)/);
  if (inlineFlagMatch) {
    const inlineFlags = inlineFlagMatch[1];
    flags = [...new Set((flags + inlineFlags).split(''))].join('');
    patternStr = patternStr.slice(inlineFlagMatch[0].length);
  }
  return { pattern: patternStr, flags };
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
  /*
   * Runtime shape check, not just a compile-time cast. evaluate_output's
   * inline custom_rules schema accepts any config record, so
   * `{type: "regex_match", config: {}}` (or a null / numeric pattern)
   * reaches this point; the old `as string` cast was a no-op at runtime
   * and normalizeRegexSource threw a TypeError out of the engine — the
   * whole evaluate_output call failed, contradicting its own description
   * ("the eval itself never throws"). Deploy-time validation already
   * rejects these; this is the same configError contract for the inline
   * path and for rules persisted before that validation existed.
   */
  const rawPattern = definition.config.pattern;
  if (typeof rawPattern !== 'string' || rawPattern.length === 0) {
    return safeRegexResult(definition, `${definition.type} rule requires config.pattern (non-empty string)`);
  }
  const rawFlags = definition.config.flags;
  if (rawFlags !== undefined && rawFlags !== null && typeof rawFlags !== 'string') {
    return safeRegexResult(definition, `${definition.type} rule config.flags must be a string when present`);
  }
  const { pattern: patternStr, flags } = normalizeRegexSource(rawPattern, rawFlags ?? '');

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
    `The rule did NOT judge this output — a gate that must fail closed should treat ` +
    `budgetExceeded skips as failures. Rewrite the pattern to avoid ambiguous repetition ` +
    `— e.g. bound quantifiers (\\s{0,8} not \\s*) and remove overlapping alternatives.`;
  return {
    ruleName: definition.name,
    passed: false,
    score: 0,
    message,
    skipped: true,
    skipReason: message,
    budgetExceeded: true,
  };
}

/**
 * Per-evaluation cap on sandbox budget breaches. Each breach costs the
 * request its budget PLUS a worker respawn (~190ms total measured), and the
 * engine runs rules synchronously — so without a breaker, one request
 * carrying N hostile regex rules stalls the server N × ~190ms (measured
 * 9.3s at N=50). After this many breaches, remaining regex rules in the
 * same evaluation skip WITHOUT running, bounding the whole request at
 * roughly cap × 190ms regardless of rule count.
 */
const MAX_REGEX_BREACHES_PER_EVAL = 3;

function circuitOpenResult(definition: CustomRuleDefinition): EvalRuleResult {
  const message =
    `Regex evaluation skipped: ${MAX_REGEX_BREACHES_PER_EVAL} earlier pattern(s) in this ` +
    `evaluation already exhausted the ${REGEX_MATCH_BUDGET_MS}ms matching budget, so the ` +
    `regex circuit breaker is open for the rest of this evaluation. The rule did NOT judge ` +
    `this output — a gate that must fail closed should treat budgetExceeded skips as failures.`;
  return {
    ruleName: definition.name,
    passed: false,
    score: 0,
    message,
    skipped: true,
    skipReason: message,
    budgetExceeded: true,
  };
}

/*
 * A sandbox 'error' is NOT the author's fault and must not be reported as
 * backtracking: it means the worker could not run the (pre-validated)
 * pattern at all — in practice a worker that died between calls (postMessage
 * to a terminated worker is a silent no-op). Accusing the pattern sends the
 * author hunting a performance problem they do not have.
 */
function sandboxErrorResult(definition: CustomRuleDefinition): EvalRuleResult {
  const message =
    'Regex evaluation skipped: internal sandbox error (the matching worker restarted). ' +
    'The rule did not judge this output; the pattern itself is fine — retry the evaluation.';
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
 * Executes a validated user pattern through the sandbox with the
 * per-evaluation circuit breaker. Shared by regex_match and regex_no_match.
 */
function runSandboxed(
  definition: CustomRuleDefinition,
  pattern: string,
  flags: string,
  context: EvalContext,
): { matched: boolean } | EvalRuleResult {
  const budget = context.regexBudget;
  if (budget && budget.breaches >= MAX_REGEX_BREACHES_PER_EVAL) {
    return circuitOpenResult(definition);
  }
  const outcome = sandboxedRegexTest(pattern, flags, context.output);
  if (outcome.kind === 'timeout') {
    if (budget) budget.breaches += 1;
    return budgetExceededResult(definition);
  }
  if (outcome.kind === 'error') {
    return sandboxErrorResult(definition);
  }
  return { matched: outcome.matched };
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
/**
 * A custom rule is the author's own constraint, so its kind is `policy`
 * whatever its mechanism; the mechanism and the inputs it reads follow the
 * type. The question it answers is the author's and is not guessed here.
 */
const CUSTOM_TYPE_META: Record<CustomRuleType, { mechanism: Mechanism; needs: readonly Need[] }> = {
  regex_match: { mechanism: 'pattern', needs: ['output'] },
  regex_no_match: { mechanism: 'pattern', needs: ['output'] },
  min_length: { mechanism: 'formula', needs: ['output'] },
  max_length: { mechanism: 'formula', needs: ['output'] },
  contains_keywords: { mechanism: 'pattern', needs: ['output'] },
  excludes_keywords: { mechanism: 'pattern', needs: ['output'] },
  json_schema: { mechanism: 'formula', needs: ['output'] },
  cost_threshold: { mechanism: 'formula', needs: ['cost'] },
};

export function createCustomRule(definition: CustomRuleDefinition, severity?: RuleSeverity): EvalRule {
  const meta = CUSTOM_TYPE_META[definition.type];
  return {
    name: definition.name,
    description: `Custom rule: ${definition.name}`,
    evalType: 'custom',
    weight: definition.weight ?? 1,
    critical: severity === 'high' || severity === 'critical',
    kind: 'policy',
    origin: 'custom',
    mechanism: meta?.mechanism ?? 'formula',
    needs: meta?.needs ?? ['output'],
    classes: [],
    version: 1,
    evaluate(context: EvalContext): EvalRuleResult {
      switch (definition.type) {
        case 'regex_match': {
          const validated = validateRegex(definition);
          if ('ruleName' in validated) return validated;
          const run = runSandboxed(definition, validated.pattern, validated.flags, context);
          if ('ruleName' in run) return run;
          const passed = run.matched;
          return { ruleName: definition.name, passed, score: passed ? 1 : 0, message: passed ? 'Regex pattern matched' : 'Regex pattern did not match' };
        }
        case 'regex_no_match': {
          const validated = validateRegex(definition);
          if ('ruleName' in validated) return validated;
          const run = runSandboxed(definition, validated.pattern, validated.flags, context);
          if ('ruleName' in run) return run;
          const passed = !run.matched;
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
          const keywords = readKeywordList(definition.config);
          if (!keywords) {
            return configError(definition, 'contains_keywords rule requires config.keywords (non-empty string array)');
          }
          const lower = context.output.toLowerCase();
          const found = keywords.filter((k) => lower.includes(k.toLowerCase()));
          const ratio = found.length / keywords.length;
          const passed = ratio >= ((definition.config.threshold as number) ?? 1);
          return { ruleName: definition.name, passed, score: ratio, message: `Found ${found.length}/${keywords.length} required keywords` };
        }
        case 'excludes_keywords': {
          const keywords = readKeywordList(definition.config);
          if (!keywords) {
            return configError(definition, 'excludes_keywords rule requires config.keywords (non-empty string array)');
          }
          const lower = context.output.toLowerCase();
          const found = keywords.filter((k) => lower.includes(k.toLowerCase()));
          const passed = found.length === 0;
          return { ruleName: definition.name, passed, score: passed ? 1 : 0, message: passed ? 'No excluded keywords found' : `Found excluded keywords: ${found.join(', ')}` };
        }
        case 'json_schema': {
          /*
           * The name promised something the code did not do: until 0.11.0
           * this parsed the output and passed ANY valid JSON, so a
           * deployment relying on the rule to gate a structured output got
           * passed:true on a wrong shape. Arc zero ranked that tier A — the
           * name stated a capability the code did not have.
           *
           * `config.schema` ABSENT keeps exactly the old behaviour, so every
           * already-deployed rule goes on meaning what it meant. Only a
           * schema that is PRESENT is applied, through the same hardened
           * path a tools catalogue goes through.
           */
          let parsed: unknown;
          try {
            parsed = JSON.parse(context.output);
          } catch {
            return { ruleName: definition.name, passed: false, score: 0, message: 'Output is not valid JSON' };
          }
          const schema = definition.config.schema;
          if (schema === undefined || schema === null) {
            return { ruleName: definition.name, passed: true, score: 1, message: 'Output is valid JSON (no config.schema supplied, so its shape was not checked)' };
          }
          const compiled = compileToolSchema(schema);
          if (!compiled.ok) {
            return configError(definition, `json_schema rule config.schema was not compiled: ${compiled.reason}`);
          }
          const check = checkArguments(compiled, parsed);
          if (check.state === 'unchecked') {
            return { ruleName: definition.name, passed: false, score: 0, skipped: true, skipReason: `the output could not be checked: ${check.reason ?? 'unknown'}`, message: 'Output shape not judged' };
          }
          if (check.state === 'valid') {
            return { ruleName: definition.name, passed: true, score: 1, message: 'Output matches the configured JSON Schema' };
          }
          /*
           * The pointer and the keyword, never ajv's message: a message can
           * carry schema-supplied text, which is author-controlled and would
           * be echoed into a stored row and onto a dashboard.
           */
          return {
            ruleName: definition.name,
            passed: false,
            score: 0,
            evidence: [{ type: 'count', stat: 'schema_violations', unit: 'violations', value: 1, threshold: 0, thresholdSource: 'rule' }],
            message: `Output does not match the configured JSON Schema: ${check.instancePath ?? '(root)'} ${check.keyword ?? 'schema'}`,
          };
        }
        case 'cost_threshold': {
          const max = readNumericConfig(definition.config, 'cost_threshold');
          if (max == null || max < 0) {
            return configError(definition, `cost_threshold rule requires ${describeKeys('cost_threshold')} (non-negative number)`);
          }
          /*
           * No cost data → SKIP, exactly like the built-in
           * cost_under_threshold (cost.ts). The old `context.costUsd ?? 0`
           * read a missing cost as free, so a rule deployed at severity
           * critical to hard-fail evaluations over $0.50 reported
           * passed:true, score:1 on every evaluate_output call that simply
           * omitted cost_usd — the veto never fired on evidence it never
           * had. A skipped critical rule is reported in critical_skipped
           * instead, so a fail-closed gate can see the rule did not run.
           */
          if (context.costUsd === undefined || context.costUsd === null) {
            return {
              ruleName: definition.name,
              passed: false,
              score: 0,
              message: 'Cost data not provided',
              skipped: true,
              skipReason: 'context.costUsd not provided',
            };
          }
          const cost = context.costUsd;
          const passed = cost <= max;
          return { ruleName: definition.name, passed, score: passed ? 1 : 0, message: passed ? `Cost ($${cost}) within threshold ($${max})` : `Cost ($${cost}) exceeds threshold ($${max})` };
        }
        default:
          return configError(definition, `Unknown rule type: ${definition.type}`);
      }
    },
  };
}
