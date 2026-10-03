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
import type { EvalContext, EvalRule, EvalRuleResult, Need, RuleState, SkipClass, Uncertainty } from '../types/eval.js';
import type { CaptureField } from '../types/trace.js';
import type { EffectiveCriticality } from './criticality.js';
import { everyCallRecorded, stepsOf } from './steps.js';
import { DEFAULT_PREVALENCE, missRateInterval, ppvInterval, publishedAccuracyFor, publishedProvenance } from './accuracy.js';
import type { LocalPrecision } from './labels.js';
import { thresholdSetBy } from './thresholds.js';

/** The prior in force and where it came from — the engine resolves it once per evaluation. */
export interface PriorInForce {
  pi: number;
  source: 'default' | 'config' | 'estimated';
}

export interface StampOptions {
  prior?: PriorInForce;
  /** This rule's local precision from the deployment's own labels, when any labels exist. */
  local?: LocalPrecision;
  /** The rule was deployed on this server (it has a rule id), as against built in or supplied inline by the call. */
  deployed?: boolean;
  /** The deployment installed a relevance judge, which answers answers_the_ask. */
  judgeInForce?: boolean;
}

const DEFAULT_PRIOR_IN_FORCE: PriorInForce = { pi: DEFAULT_PREVALENCE, source: 'default' };

/** The fields a context's capture source declared complete (src/eval/evidence.ts); none unless a capture source recorded it. */
export function declaredComplete(context: Pick<EvalContext, 'recordedBy' | 'capture'>): ReadonlySet<CaptureField> {
  if (context.recordedBy !== 'harness') return new Set();
  return new Set(context.capture?.complete ?? []);
}

/** Which needs the call actually carried. `tools_catalogue` and `citations` arrive with later releases. */
export function inputsPresent(context: EvalContext): Set<Need> {
  const present = new Set<Need>(['output']);
  const declared = declaredComplete(context);
  // A blank is not sent: one space satisfied "the call carried an input" until 0.20.0, and a blank expected answer met a requirement for one.
  if (typeof context.input === 'string' && context.input.trim().length > 0) present.add('input');
  if (typeof context.expected === 'string' && context.expected.trim().length > 0) present.add('expected');
  /*
   * The DERIVED trajectory, not the raw field: a trace captured as
   * OpenTelemetry TOOL spans supplied its trajectory just as surely as one
   * that sent tool_calls, and coverage that said otherwise would report a
   * question as unjudged when a rule had in fact judged it.
   */
  const steps = stepsOf(context);
  if (steps.length > 0) {
    present.add('tool_calls');
    // What a call returned: its output, or the error it failed with. An output that is absent, null or blank is not one: every output replaced by "" read as "outputs were sent".
    const returned = (s: (typeof steps)[number]): boolean =>
      (s.output !== undefined && s.output !== null && !(typeof s.output === 'string' && s.output.trim() === '')) || (typeof s.error === 'string' && s.error.trim() !== '');
    /*
     * A capture source that records every call's result promised one on each:
     * a blank one is what the tool returned, and a call with none at all is a
     * hole in the record. The promise is checked over every call the record
     * carries, not only the first MAX_STEPS_DERIVED the trajectory rules
     * read. Without that promise, one call that returned something is enough.
     */
    if (declared.has('tool_outputs') ? everyCallRecorded(context) : steps.some(returned)) present.add('tool_outputs');
  } else if (declared.has('tool_calls') && Array.isArray(context.toolCalls)) {
    /*
     * The source records every call and sent an empty list: none were made,
     * so no call's result is missing either. Only an explicit list says so.
     * Spans with no TOOL span among them do not: a tool span in a vocabulary
     * Iris does not read is not a TOOL span, and that miss must not become
     * an observation that no tool was called.
     */
    present.add('tool_calls');
    present.add('tool_outputs');
  }
  if (Array.isArray(context.tools) && context.tools.length > 0) present.add('tools_catalogue');
  // A negative cost is not a cost.
  if (typeof context.costUsd === 'number' && !(context.costUsd < 0)) present.add('cost');
  if (context.tokenUsage && (context.tokenUsage.prompt_tokens !== undefined || context.tokenUsage.completion_tokens !== undefined || context.tokenUsage.total_tokens !== undefined)) {
    present.add('tokens');
  }
  // An expectation a trajectory rule can use: a budget of at least one step, or at least one expected call. `{}` and `{ tool_calls: [] }` are not one.
  const et = context.expectedTrajectory;
  if ((typeof et?.step_budget === 'number' && Number.isFinite(et.step_budget) && et.step_budget >= 1) || (et?.tool_calls?.length ?? 0) > 0) present.add('expected_trajectory');
  return present;
}

/**
 * Whether somebody asked for a rule that then skipped for missing
 * evidence, and who.
 *
 * A trajectory rule on a call with no tool calls is not applicable, and
 * that is not a finding: treating it as one would make every text-only
 * evaluation unknown. But a deployment that set a cost ceiling has said the
 * cost matters, and a call that leaves the cost out is then not "nothing to
 * check". Until 0.20.0 it read as a pass: leaving out the one field a
 * configured policy reads was the cheapest way through it.
 */
export function askedOf(rule: EvalRule, context: EvalContext, effective: EffectiveCriticality, options: Pick<StampOptions, 'deployed' | 'judgeInForce'> = {}): 'config' | 'call' | undefined {
  // Promoted to critical by the deployment (eval.criticalRules).
  if (effective.critical && effective.source === 'config') return 'config';
  // A rule somebody wrote and gave a gating severity: the deployment's when it was deployed, the call's when it came inline.
  if (effective.critical && rule.origin === 'custom') return options.deployed === true ? 'config' : 'call';
  // A threshold somebody set. Any kind of rule: a deployment that set max_tool_repeats asked for the loop check as surely as one that set a cost ceiling.
  const setBy = (rule.thresholdKeys ?? []).map((key) => thresholdSetBy(context, key));
  if (setBy.includes('config')) return 'config';
  if (setBy.includes('call')) return 'call';
  // The deployment installed a judge for this question.
  if (rule.name === 'answers_the_ask' && options.judgeInForce === true) return 'config';
  // The call said what it expected and did not send what to compare it with.
  if (rule.expects?.(context) === true) return 'call';
  return undefined;
}

/**
 * The inputs a rule reads that the call did not carry.
 *
 * An explicit empty list of tool calls is carried: it is the caller saying
 * none were made, and a rule that then has nothing to judge lacks nothing.
 * (Whether to believe it is another question: a self-reported trace can
 * say "none" falsely, and `eval.requiredEvidence` is how a deployment says
 * it wants calls it can look at.) Left out altogether, they are lacking.
 */
function lackedBy(rule: EvalRule, context: EvalContext, present: ReadonlySet<Need>): Need[] {
  const saidNone = Array.isArray(context.toolCalls) && context.toolCalls.length === 0;
  return (rule.needs ?? []).filter((n) => !present.has(n) && !(saidNone && (n === 'tool_calls' || n === 'tool_outputs')));
}

/** The state of a rule result, from the two flags every result carries: not checked when it skipped, else pass or fail. */
export function ruleStateOf(r: { passed: boolean; skipped?: boolean }): RuleState {
  return r.skipped === true ? 'not_checked' : r.passed ? 'pass' : 'fail';
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
  effective: EffectiveCriticality,
  options: StampOptions = {},
): Pick<EvalRuleResult, 'kind' | 'question' | 'classes' | 'ruleVersion' | 'saw' | 'skipClass' | 'lacked' | 'asked' | 'uncertainty' | 'origin'> {
  const present = inputsPresent(context);
  const skipClass = skipClassOf(raw);
  // What a rule that had nothing to judge was missing, and whether anyone had asked for it.
  const lacked = skipClass === 'not_applicable' ? lackedBy(rule, context, present) : [];
  const asked = lacked.length > 0 ? askedOf(rule, context, effective, options) : undefined;
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
    ...(lacked.length > 0 ? { lacked } : {}),
    ...(asked !== undefined ? { asked } : {}),
    ...(uncertainty !== undefined ? { uncertainty } : {}),
  };
}
