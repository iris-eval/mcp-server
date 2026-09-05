/*
 * Which built-in rules VETO — a deployment's decision, not ours.
 *
 * `critical` is a property of each rule's definition, and until now that was
 * the whole story: a failing critical rule forced `passed: false`, a failing
 * non-critical one only moved the score, and nobody running Iris could
 * change either. That default is a judgement about acceptable error, and it
 * is not ours to make for everyone. The trajectory release is the plain
 * case: `no_silent_tool_failure` catches an agent answering over a tool that
 * errored, which is exactly what a team gating deploys wants to block — but
 * its precision on a 30-case family carries a 95% lower bound of 77.2%, so
 * shipping it as a veto for everyone would force false failures on people
 * who never asked for that trade. A team that HAS looked at the number can
 * make the call for their own pipeline; the config keys below are how.
 *
 * Two lists, both optional, both naming BUILT-IN rules:
 *   eval.criticalRules     — promote: these rules veto `passed`.
 *   eval.nonCriticalRules  — demote: these rules stop vetoing.
 *
 * Every name is checked against the rule registry when the config loads and
 * again when an engine is constructed. An unknown name is a startup error
 * naming the valid list, never a silent no-op: a typo in `criticalRules`
 * that quietly did nothing would leave an operator believing a gate exists
 * when it does not, which is the same "detection that reports an all-clear"
 * failure the critical veto was built to stop.
 *
 * Overrides are matched by rule IDENTITY, not by name. Deployed custom rules
 * do not enforce unique names — one can legitimately be called `no_pii` —
 * and a name-keyed override would silently reach it. A custom rule's
 * severity stays its own definition's business.
 */

import type { EvalRule, EvalType, ClaimKind, Mechanism, Need, QuestionId, FailureClass } from '../types/eval.js';
import { rulesByType } from './rules/index.js';

/** Where a rule's EFFECTIVE criticality came from. */
export type CriticalitySource = 'default' | 'config';

export interface CriticalityOverrides {
  /** Built-in rule names promoted to critical. */
  criticalRules?: string[];
  /** Built-in rule names demoted from critical. */
  nonCriticalRules?: string[];
}

export interface EffectiveCriticality {
  critical: boolean;
  /** 'config' when one of the two lists decided this; 'default' otherwise. */
  source: CriticalitySource;
}

/** Every built-in rule, in bundle order. The registry the lists are checked against. */
export function builtInRules(): EvalRule[] {
  return (['completeness', 'relevance', 'safety', 'cost'] as const).flatMap((t) => rulesByType[t]);
}

/** Built-in rule names, sorted — the "valid list" an error message prints. */
export function builtInRuleNames(): string[] {
  return builtInRules()
    .map((r) => r.name)
    .sort();
}

/**
 * Every problem with a pair of override lists, as human sentences.
 * Empty means valid. Separate from the thrower so a caller that wants to
 * report several at once (a config linter, a test) can.
 */
export function criticalityIssues(overrides: CriticalityOverrides | undefined): string[] {
  if (!overrides) return [];
  const issues: string[] = [];
  const valid = new Set(builtInRuleNames());
  const seen: Record<'criticalRules' | 'nonCriticalRules', Set<string>> = {
    criticalRules: new Set(),
    nonCriticalRules: new Set(),
  };

  for (const key of ['criticalRules', 'nonCriticalRules'] as const) {
    const list = overrides[key];
    if (list === undefined) continue;
    if (!Array.isArray(list)) {
      issues.push(`eval.${key} must be an array of built-in rule names.`);
      continue;
    }
    for (const entry of list) {
      if (typeof entry !== 'string' || entry.trim().length === 0) {
        issues.push(`eval.${key} contains ${JSON.stringify(entry)}, which is not a rule name.`);
        continue;
      }
      if (!valid.has(entry)) {
        issues.push(
          `eval.${key} names "${entry}", which is not a built-in rule. ` +
            `Valid names: ${builtInRuleNames().join(', ')}. ` +
            'Deployed custom rules carry their own severity and are not set here.',
        );
        continue;
      }
      seen[key].add(entry);
    }
  }

  for (const name of seen.criticalRules) {
    if (seen.nonCriticalRules.has(name)) {
      issues.push(
        `"${name}" is in BOTH eval.criticalRules and eval.nonCriticalRules, so the config does not say whether it should veto. Remove it from one of them.`,
      );
    }
  }
  return issues;
}

/**
 * Throw on any problem, with every problem named at once.
 *
 * Called from loadConfig (so a bad config.json fails at startup, before a
 * single evaluation runs) and from the EvalEngine constructor (so no code
 * path can build an engine that silently ignores an override).
 */
export function assertValidCriticality(overrides: CriticalityOverrides | undefined): void {
  const issues = criticalityIssues(overrides);
  if (issues.length === 0) return;
  throw new Error(
    `Invalid eval criticality configuration:\n  - ${issues.join('\n  - ')}\n` +
      'Set eval.criticalRules / eval.nonCriticalRules in your Iris config.json (see docs/api-reference.md § Rule criticality).',
  );
}

/**
 * The effective criticality of one rule.
 *
 * A rule the overrides do not name keeps its definition's `critical` and
 * reports source 'default' — which for a deployed custom rule means the
 * severity it was deployed with.
 */
export function resolveCriticality(
  rule: EvalRule,
  overrides: CriticalityOverrides | undefined,
  builtIns: ReadonlySet<EvalRule>,
): EffectiveCriticality {
  const declared = rule.critical === true;
  if (!overrides || !builtIns.has(rule)) return { critical: declared, source: 'default' };
  if (overrides.criticalRules?.includes(rule.name)) return { critical: true, source: 'config' };
  if (overrides.nonCriticalRules?.includes(rule.name)) return { critical: false, source: 'config' };
  return { critical: declared, source: 'default' };
}

/** A resolver bound to one set of overrides, so callers don't rebuild the identity set per rule. */
export function criticalityResolver(
  overrides: CriticalityOverrides | undefined,
): (rule: EvalRule) => EffectiveCriticality {
  assertValidCriticality(overrides);
  const builtIns = new Set(builtInRules());
  return (rule) => resolveCriticality(rule, overrides, builtIns);
}

/** Built-in rule metadata as every roster surface reports it — derived from the registry, never restated. */
export interface BuiltInRuleMeta {
  name: string;
  category: EvalType;
  description: string;
  weight: number;
  /** EFFECTIVE criticality, after eval.criticalRules / eval.nonCriticalRules. */
  critical: boolean;
  /** Who decided it: the rule's own declaration, or one of the config lists. */
  criticalSource: CriticalitySource;
  /** The rule's declared metadata (see EvalRule): the kind of claim, its mechanism, what it reads, the question it answers, the failure classes, the definition version. */
  kind?: ClaimKind;
  mechanism?: Mechanism;
  needs?: readonly Need[];
  question?: QuestionId;
  classes?: readonly FailureClass[];
  version?: number;
}

/**
 * The whole built-in roster, one entry per rule.
 *
 * `resolve` is what makes `critical` EFFECTIVE rather than declared. Reading
 * `rule.critical` on a roster while the engine applies an override would
 * show an operator a list that disagrees with the verdicts the same process
 * is producing — they would see `no_silent_tool_failure` reported
 * non-critical while it vetoed their pipeline. Callers that only want names
 * and weights may omit it and get the declarations, reported as 'default'.
 *
 * Typed on a function, not on EvalEngine, so this module stays free of the
 * engine it is imported by.
 */
export function builtInRuleRoster(
  resolve?: (rule: EvalRule) => EffectiveCriticality,
): BuiltInRuleMeta[] {
  const out: BuiltInRuleMeta[] = [];
  for (const [category, rules] of Object.entries(rulesByType) as Array<[EvalType, EvalRule[]]>) {
    for (const rule of rules) {
      const effective = resolve
        ? resolve(rule)
        : { critical: rule.critical === true, source: 'default' as CriticalitySource };
      out.push({
        name: rule.name,
        category,
        description: rule.description,
        weight: rule.weight,
        critical: effective.critical,
        criticalSource: effective.source,
        kind: rule.kind,
        mechanism: rule.mechanism,
        needs: rule.needs,
        question: rule.question,
        classes: rule.classes,
        version: rule.version,
      });
    }
  }
  return out;
}
