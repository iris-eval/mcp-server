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
 *
 * A THIRD LIST, FOR THE RULES THAT ARE WEIGHED. A detection or an inference
 * that is not critical does not veto: its fire enters the risk estimate,
 * and at the shipped loss ratio one fire of most of them fails the verdict.
 * The two lists above say nothing to that. `no_silent_tool_failure` is not
 * critical, so `nonCriticalRules` cannot stop it failing a verdict, and a
 * deployment whose agent retries through tool errors had no setting to
 * reach for.
 *   eval.advisoryRules     — these rules report and take no part in the
 *                            verdict: no veto, and not in the risk estimate.
 * It names built-in detections and inferences only. A measurement already
 * only reports, and a policy advises until the deployment sets its
 * threshold, so naming either would say nothing or contradict itself.
 */

import type { EvalRule, EvalType, ClaimKind, Mechanism, Need, QuestionId, FailureClass } from '../types/eval.js';
import { rulesByType } from './rules/index.js';

/** Where a rule's EFFECTIVE criticality came from. */
export type CriticalitySource = 'default' | 'config';

export interface CriticalityOverrides {
  /** The threshold keys the deployment's config file set (loadConfig records them); the engine installs them on every context. */
  configuredThresholdKeys?: readonly string[];
  /** Built-in rule names promoted to critical. */
  criticalRules?: string[];
  /** Built-in rule names demoted from critical. */
  nonCriticalRules?: string[];
  /** Built-in detections and inferences that report and take no part in the verdict. */
  advisoryRules?: string[];
  /*
   * The engine is handed `config.eval` whole, so the verdict's six defaults
   * (0.10.0) arrive on the same object. They are read by the composer, not
   * by the criticality resolver; declared here so a caller that builds an
   * engine directly passes one object and not two.
   */
  composer?: 'risk';
  falsePassCost?: number;
  onCriticalSkipped?: 'unknown' | 'fail' | 'pass';
  requiredEvidence?: string[];
  defaultsGate?: boolean;
  prior?: number;
  priorMode?: 'per-output' | 'per-class';
  /** Recorded by loadConfig: the deployment set eval.prior. The shipped number and a deployment's own are different facts. */
  priorConfigured?: boolean;
}

export interface EffectiveCriticality {
  critical: boolean;
  /** 'config' when one of the lists decided this; 'default' otherwise. */
  source: CriticalitySource;
  /** The deployment named this rule in eval.advisoryRules: it reports and takes no part in the verdict. Absent otherwise. */
  advisory?: true;
}

/** The kinds a rule must be to be named in eval.advisoryRules: the two the risk estimate weighs. */
const WEIGHED_KINDS: ReadonlySet<string> = new Set(['detection', 'inference']);

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
  const kindOf = new Map(builtInRules().map((r) => [r.name, r.kind]));
  const seen: Record<'criticalRules' | 'nonCriticalRules' | 'advisoryRules', Set<string>> = {
    criticalRules: new Set(),
    nonCriticalRules: new Set(),
    advisoryRules: new Set(),
  };

  for (const key of ['criticalRules', 'nonCriticalRules', 'advisoryRules'] as const) {
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
      if (key === 'advisoryRules' && !WEIGHED_KINDS.has(kindOf.get(entry) ?? '')) {
        const kind = kindOf.get(entry);
        issues.push(
          `eval.advisoryRules names "${entry}", which is a ${kind ?? 'rule with no declared kind'}. The list is for detections and inferences, the rules a verdict weighs. ` +
            (kind === 'measurement'
              ? 'A measurement already only reports.'
              : kind === 'policy'
                ? 'A policy advises until you set its threshold, and gates once you do; to stop a policy that ships critical from vetoing, name it in eval.nonCriticalRules.'
                : 'Leave it out.'),
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
    if (seen.advisoryRules.has(name)) {
      issues.push(
        `"${name}" is in BOTH eval.criticalRules and eval.advisoryRules, so the config says it should veto and should take no part in the verdict. Remove it from one of them.`,
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
  /*
   * `eval.composer: "legacy"` was removed in 0.12.0, two minors after
   * 0.10.0 announced it would be. Refused loudly rather than ignored: a
   * deployment that pinned the old arithmetic chose which outputs ship, and
   * defaulting them into the risk composer without a word would change that
   * silently on an upgrade. The message says what changed and where the
   * numbers are, so the choice is made again rather than made for them.
   */
  if ((overrides as { composer?: string } | undefined)?.composer === 'legacy') {
    throw new Error(
      'eval.composer: "legacy" was removed in 0.12.0. It ran the pre-0.10.0 arithmetic and 0.10.0 announced it would last two minors.\n' +
        '  Remove the key (or set it to "risk") to use the composer that has shipped as the default since 0.10.0.\n' +
        '  What changes: on the held-out split of the composite corpus the risk composer is right about shipping 57.7% of the time against legacy\'s 38.5%, at an identical false-block rate, missing 55.6% of bad outputs against 83.3%. The numbers regenerate every release in proof/COMPOSITE.md.\n' +
        '  Tune it with eval.falsePassCost rather than by reverting: what a false pass costs you relative to a false block is the knob the threshold is derived from.',
    );
  }

  const issues = criticalityIssues(overrides);
  if (issues.length === 0) return;
  throw new Error(
    `Invalid eval criticality configuration:\n  - ${issues.join('\n  - ')}\n` +
      'Set eval.criticalRules / eval.nonCriticalRules / eval.advisoryRules in your Iris config.json (see docs/api-reference.md § Rule criticality).',
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
  // A rule that takes no part in the verdict does not veto either, whatever its definition declares.
  if (overrides.advisoryRules?.includes(rule.name)) return { critical: false, source: declared ? 'config' : 'default', advisory: true };
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
  /** Present when eval.advisoryRules names the rule: it reports and takes no part in the verdict. */
  advisory?: true;
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
        ...(effective.advisory ? { advisory: true as const } : {}),
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
