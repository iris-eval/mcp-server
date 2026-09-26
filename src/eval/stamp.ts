/*
 * The stamp — what a rule result says about itself beyond pass, score and
 * message.
 *
 * An audit on 2026-09-05 found four lenses independently reporting the same
 * absence: a result carried no field for what kind of claim it made, what
 * it had looked at, or how wrong it tends to be, while the per-rule
 * intervals sat in proof/results.json and never reached a reader. This
 * module computes those fields at the one point every evaluation passes
 * through (EvalEngine.run) from the rule's declared metadata, the inputs the
 * call carried, and the published accuracy that ships in the package.
 *
 * Nothing here changes a verdict. `role` is NOT stamped here: it is what the
 * composer did with the result, so the engine sets it from compose.roleOf()
 * once the composer's configuration is in hand (0.13.0 — until then the
 * stamp could only say veto or "term", and the schema advertised four
 * values nothing produced).
 */
import type { EvalContext, EvalRule, EvalRuleResult, Need, SkipClass, Uncertainty } from '../types/eval.js';
import type { EffectiveCriticality } from './criticality.js';
import { stepsOf } from './steps.js';
import { DEFAULT_PREVALENCE, missRateInterval, ppvInterval, publishedAccuracyFor, publishedProvenance } from './accuracy.js';
import type { LocalPrecision } from './labels.js';

/** The prior in force and where it came from — the engine resolves it once per evaluation. */
export interface PriorInForce {
  pi: number;
  source: 'default' | 'config' | 'estimated';
}

export interface StampOptions {
  prior?: PriorInForce;
  /** This rule's local precision from the deployment's own labels, when any labels exist. */
  local?: LocalPrecision;
}

const DEFAULT_PRIOR_IN_FORCE: PriorInForce = { pi: DEFAULT_PREVALENCE, source: 'default' };

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
export function uncertaintyOf(rule: EvalRule, raw: EvalRuleResult, options: StampOptions = {}): Uncertainty | undefined {
  if (raw.skipped || rule.kind === undefined) return undefined;
  const prior = options.prior ?? DEFAULT_PRIOR_IN_FORCE;
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
      const fired = raw.passed === false;
      /*
       * The deployment's own number: at LOCAL_LABEL_MIN labels
       * on this rule's fires, a FIRE carries the local precision instead of
       * the published positive predictive value. A quiet rule keeps the
       * published miss rate — labels on fires say nothing about what a
       * quiet rule missed, and a number that pretended otherwise would be
       * the "local accuracy" the surface refuses to say.
       */
      const local = options.local;
      if (fired && local !== undefined && local.local && local.precision !== null) {
        return { basis: 'local_labels', precision: { point: local.precision.point, lo: local.precision.lo, hi: local.precision.hi }, n: local.n };
      }
      const published = publishedAccuracyFor(rule.name);
      if (!published) return { basis: 'unmeasured', why: 'no proof family for this rule' };
      const prov = publishedProvenance();
      const corpus = { n: published.n, tp: published.tp, fp: published.fp, fn: published.fn, tn: published.tn, version: prov.corpusVersion, release: prov.release, labelling: prov.labelling };
      const interval = fired ? ppvInterval(rule.name, prior.pi) : missRateInterval(rule.name, prior.pi);
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
  _effective: EffectiveCriticality,
  options: StampOptions = {},
): Pick<EvalRuleResult, 'kind' | 'question' | 'classes' | 'ruleVersion' | 'saw' | 'skipClass' | 'uncertainty' | 'origin'> {
  const present = inputsPresent(context);
  const skipClass = skipClassOf(raw);
  /*
   * A result an LLM judge decided (answers_the_ask with a relevance judge,
   * #649) is a judgment, whatever the rule declares for its lexical
   * reading: the claim is the model's, so the kind and the uncertainty say
   * so. A judge that did not answer leaves the rule's own kind in place —
   * the lexical reading is what spoke.
   */
  const judged = raw.judge !== undefined && raw.judge.error === undefined && !raw.skipped;
  const kind = judged ? 'judgment' : rule.kind;
  const uncertainty = uncertaintyOf(judged ? { ...rule, kind: 'judgment' } : rule, raw, options);
  return {
    ...(kind !== undefined ? { kind } : {}),
    ...(rule.question !== undefined ? { question: rule.question } : {}),
    ...(rule.classes !== undefined ? { classes: [...rule.classes] } : {}),
    ...(rule.version !== undefined ? { ruleVersion: rule.version } : {}),
    ...(rule.origin !== undefined ? { origin: rule.origin } : {}),
    ...(rule.needs !== undefined ? { saw: rule.needs.filter((n) => present.has(n)) } : {}),
    ...(skipClass !== undefined ? { skipClass } : {}),
    ...(uncertainty !== undefined ? { uncertainty } : {}),
  };
}
