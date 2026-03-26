import isSafeRegex from 'safe-regex2';
import type { EvalRule, EvalContext, EvalRuleResult, CustomRuleDefinition } from '../../types/eval.js';

const MAX_PATTERN_LENGTH = 1000;

function safeRegexResult(definition: CustomRuleDefinition, message: string): EvalRuleResult {
  return { ruleName: definition.name, passed: false, score: 0, message };
}

function compileRegex(definition: CustomRuleDefinition): RegExp | EvalRuleResult {
  const patternStr = definition.config.pattern as string;
  if (patternStr.length > MAX_PATTERN_LENGTH) {
    return safeRegexResult(definition, `Regex pattern too long (${patternStr.length} > ${MAX_PATTERN_LENGTH})`);
  }
  if (!isSafeRegex(patternStr)) {
    return safeRegexResult(definition, 'Regex pattern rejected: potentially unsafe (catastrophic backtracking)');
  }
  try {
    return new RegExp(patternStr, (definition.config.flags as string) ?? '');
  } catch (e) {
    return safeRegexResult(definition, `Invalid regex syntax: ${e instanceof Error ? e.message : 'unknown error'}`);
  }
}

export function createCustomRule(definition: CustomRuleDefinition): EvalRule {
  return {
    name: definition.name,
    description: `Custom rule: ${definition.name}`,
    evalType: 'custom',
    weight: definition.weight ?? 1,
    evaluate(context: EvalContext): EvalRuleResult {
      switch (definition.type) {
        case 'regex_match': {
          const result = compileRegex(definition);
          if (!(result instanceof RegExp)) return result;
          const passed = result.test(context.output);
          return { ruleName: definition.name, passed, score: passed ? 1 : 0, message: passed ? 'Regex pattern matched' : 'Regex pattern did not match' };
        }
        case 'regex_no_match': {
          const result = compileRegex(definition);
          if (!(result instanceof RegExp)) return result;
          const passed = !result.test(context.output);
          return { ruleName: definition.name, passed, score: passed ? 1 : 0, message: passed ? 'Forbidden pattern not found' : 'Forbidden pattern found in output' };
        }
        case 'min_length': {
          const min = (definition.config.min_length ?? definition.config.length) as number | undefined;
          if (min == null || min <= 0) {
            return { ruleName: definition.name, passed: false, score: 0, message: 'min_length rule requires config.min_length (positive number)' };
          }
          const passed = context.output.length >= min;
          return { ruleName: definition.name, passed, score: passed ? 1 : context.output.length / min, message: passed ? `Length (${context.output.length}) meets minimum (${min})` : `Length (${context.output.length}) below minimum (${min})` };
        }
        case 'max_length': {
          const max = (definition.config.max_length ?? definition.config.length) as number | undefined;
          if (max == null || max <= 0) {
            return { ruleName: definition.name, passed: false, score: 0, message: 'max_length rule requires config.max_length (positive number)' };
          }
          const passed = context.output.length <= max;
          return { ruleName: definition.name, passed, score: passed ? 1 : max / context.output.length, message: passed ? `Length (${context.output.length}) within maximum (${max})` : `Length (${context.output.length}) exceeds maximum (${max})` };
        }
        case 'contains_keywords': {
          const keywords = definition.config.keywords as string[];
          const lower = context.output.toLowerCase();
          const found = keywords.filter((k) => lower.includes(k.toLowerCase()));
          const ratio = found.length / keywords.length;
          const passed = ratio >= ((definition.config.threshold as number) ?? 1);
          return { ruleName: definition.name, passed, score: ratio, message: `Found ${found.length}/${keywords.length} required keywords` };
        }
        case 'excludes_keywords': {
          const keywords = definition.config.keywords as string[];
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
          const max = definition.config.max_cost as number;
          const cost = context.costUsd ?? 0;
          const passed = cost <= max;
          return { ruleName: definition.name, passed, score: passed ? 1 : 0, message: passed ? `Cost ($${cost}) within threshold ($${max})` : `Cost ($${cost}) exceeds threshold ($${max})` };
        }
        default:
          return { ruleName: definition.name, passed: false, score: 0, message: `Unknown rule type: ${definition.type}` };
      }
    },
  };
}
