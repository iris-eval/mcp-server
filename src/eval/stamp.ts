/*
 * The stamp — what a rule result says about itself beyond pass, score and
 * message.
 *
 * Arc zero (2026-09-05) found four lenses independently reporting the same
 * absence: a result carried no field for what kind of claim it made, what
 * it had looked at, or how wrong it tends to be, while the per-rule
 * intervals sat in proof/results.json and never reached a reader. This
 * module computes those fields at the one point every evaluation passes
 * through (EvalEngine.run) from the rule's declared metadata, the inputs the
 * call carried, and the published accuracy that ships in the package.
 *
 * Nothing here changes a verdict. `role` describes what today's composer
 * does with the result (veto, or a term of the weighted score); the
 * compose-by-kind release adds the other roles and starts deciding by them.
 */
import type { EvalContext, EvalRule, EvalRuleResult, Need, Role, SkipClass, Uncertainty } from '../types/eval.js';
import type { EffectiveCriticality } from './criticality.js';
import { stepsOf } from './steps.js';
import { DEFAULT_PREVALENCE, missRateInterval, ppvInterval, publishedAccuracyFor, publishedProvenance } from './accuracy.js';

/** Which needs the call actually carried. `tools_catalogue` and `citations` arrive with later releases. */
export function inputsPresent(context: EvalContext): Set<Need> {
  const present = new Set<Need>(['output']);
  if (typeof context.input === 'string' && context.input.length > 0) present.add('input');
  if (typeof context.expected === 'string' && context.expected.length > 0) present.add('expected');
  /*
   * The DERIVED trajectory, not the raw field: a trace captured as
   * OpenTelemetry TOOL spans supplied its trajectory just as surely as one
   * that sent tool_calls, and coverage that said otherwise would report a
   * question as unjudged when a rule had in fact judged it.
   */
  const steps = stepsOf(context);
  if (steps.length > 0) {
    present.add('tool_calls');
    if (steps.some((s) => s.output !== undefined)) present.add('tool_outputs');
  }
  if (Array.isArray(context.tools) && context.tools.length > 0) present.add('tools_catalogue');
  if (typeof context.costUsd === 'number') present.add('cost');
  if (context.tokenUsage && (context.tokenUsage.prompt_tokens !== undefined || context.tokenUsage.completion_tokens !== undefined || context.tokenUsage.total_tokens !== undefined)) {
    present.add('tokens');
  }
  return present;
}

export function skipClassOf(raw: EvalRuleResult): SkipClass | undefined {
  if (!raw.skipped) return undefined;
  if (raw.budgetExceeded || raw.evidenceIncomplete) return 'defeated';
  if (raw.configInvalid) return 'config_invalid';
  return 'not_applicable';
}

/**
 * The uncertainty a result carries, by the kind of claim it makes. A skipped
 * rule made no claim and gets none. The prior is the corpus default until a
 * deployment states its own prevalence (the compose-by-kind release) or the
 * own-traffic labels estimate one.
 */
export function uncertaintyOf(rule: EvalRule, raw: EvalRuleResult): Uncertainty | undefined {
  if (raw.skipped || rule.kind === undefined) return undefined;
  switch (rule.kind) {
    case 'policy':
      return { basis: 'policy' };
    case 'measurement': {
      const published = publishedAccuracyFor(rule.name);
      if (!published) return { basis: 'unmeasured', why: 'no proof family for this rule' };
      // A measurement's family checks that the formula is implemented right:
      // its "accuracy" is conformance, not the badness of an output.
      return { basis: 'definition', conformance: { n: published.n, matched: published.tp + published.tn } };
    }
    case 'detection':
    case 'inference': {
      const published = publishedAccuracyFor(rule.name);
      if (!published) return { basis: 'unmeasured', why: 'no proof family for this rule' };
      const prov = publishedProvenance();
      const corpus = { n: published.n, tp: published.tp, fp: published.fp, fn: published.fn, tn: published.tn, version: prov.corpusVersion, release: prov.release, labelling: prov.labelling };
      const prior = { pi: DEFAULT_PREVALENCE, source: 'default' as const };
      const fired = raw.passed === false;
      const interval = fired ? ppvInterval(rule.name, DEFAULT_PREVALENCE) : missRateInterval(rule.name, DEFAULT_PREVALENCE);
      if (!interval) return { basis: 'unmeasured', why: 'the proof family has no positives or no negatives' };
      return fired ? { basis: 'published_accuracy', fired: true, ppv: interval, prior, corpus } : { basis: 'published_accuracy', fired: false, missRate: interval, prior, corpus };
    }
    case 'judgment':
      return { basis: 'unmeasured', why: 'judge accuracy is measurable on a key you supply (npm run proof:judge) and not yet published' };
    case 'verification':
      return { basis: 'unmeasured', why: 'verification accuracy is measurable on a key you supply and not yet published' };
    default:
      return undefined;
  }
}

/** Everything the engine adds to a raw rule result besides ruleId, category and criticality. */
export function stampRuleResult(
  rule: EvalRule,
  raw: EvalRuleResult,
  context: EvalContext,
  effective: EffectiveCriticality,
): Pick<EvalRuleResult, 'kind' | 'role' | 'question' | 'classes' | 'ruleVersion' | 'saw' | 'skipClass' | 'uncertainty' | 'origin'> {
  const present = inputsPresent(context);
  const role: Role = effective.critical ? 'veto' : 'term';
  const skipClass = skipClassOf(raw);
  const uncertainty = uncertaintyOf(rule, raw);
  return {
    ...(rule.kind !== undefined ? { kind: rule.kind } : {}),
    role,
    ...(rule.question !== undefined ? { question: rule.question } : {}),
    ...(rule.classes !== undefined ? { classes: [...rule.classes] } : {}),
    ...(rule.version !== undefined ? { ruleVersion: rule.version } : {}),
    ...(rule.origin !== undefined ? { origin: rule.origin } : {}),
    ...(rule.needs !== undefined ? { saw: rule.needs.filter((n) => present.has(n)) } : {}),
    ...(skipClass !== undefined ? { skipClass } : {}),
    ...(uncertainty !== undefined ? { uncertainty } : {}),
  };
}
