/*
 * The verdict, composed by kind.
 *
 * Until 0.10.0 `passed` was a weighted mean of every rule's score against
 * one threshold, with a veto for the critical rules. The 2026-09-05 audit measured
 * what that cost: no single non-critical rule, and no pair of them, could move
 * the verdict at the shipped weights, so a trace that cost $1.33, a silent
 * tool failure and a stub answer all passed. The score term was inert and
 * the rules that were not vetoes did not decide anything.
 *
 * This composer reads the rules by what KIND of claim each one makes:
 *
 *   1. GATES     — a policy the deployment configured, or a judgment the
 *                  caller explicitly asked and paid for. Either way
 *                  somebody has already decided; the verdict does not
 *                  weigh it against anything.
 *   2. VETOES    — an effectively-critical detection or inference. High
 *                  precision on a must-not-ship condition, so one fire is
 *                  the answer.
 *   3. UNKNOWN   — a critical rule that was ASKED and could not answer:
 *                  defeated by the output, or configured invalidly. Not the
 *                  same as never asked, which is coverage. This is the
 *                  fail-open seam the audit found, and closing it is why the
 *                  verdict has three states.
 *   4. RISK      — everything else that carries a published error rate,
 *                  combined into one probability that the output is bad
 *                  (./risk.ts) and compared against the threshold the
 *                  deployment's own loss ratio implies.
 *
 * Measurements never enter the risk. Their proof families measure
 * conformance to a formula — all seven score a perfect 1.00 — so feeding
 * one into a badness probability would make "this answer is short"
 * indistinguishable from "this answer leaked a key", and would drown out
 * the detectors that find things.
 *
 * Every default here is a config key, and every one is a RECOMMENDATION
 * with its failure mode stated, not a settled answer. Each surface that
 * shows a default says it is a recommendation.
 */
import type { EvalResult, EvalRuleResult, Interpretation, Need, Role, Verdict, VerdictNode } from '../types/eval.js';
import { riskEstimate, detectorsOf, DEFAULT_PRIOR, DEFAULT_PRIOR_MODE, DEFAULT_FALSE_PASS_COST, type PriorMode } from './risk.js';
import { verdictConfidence, MIN_BIN_N, MIN_BIN_PATTERNS, type ConfidenceCall } from './confidence.js';
import { PUBLISHED_CALIBRATION } from './published-calibration.js';
import { decides, isCritical } from './gate.js';
import { RELEVANCE_JUDGE_MODEL_VAR } from './llm-judge/relevance-judge.js';
import { sameFamilyWarning } from './llm-judge/family.js';

// The gating predicate lives in gate.ts so the harness composer in risk.ts reads the same one; re-exported for the callers that import it from here.
export { decides };

export interface ComposeConfig {
  /**
   * How the verdict is composed. `risk` is the only value from 0.12.0.
   *
   * `legacy` ran the pre-0.10.0 arithmetic and was announced in 0.10.0 as
   * lasting two minors so an upgrade had somewhere to stand. Those two
   * minors were 0.11.0 and 0.12.0. The key stays rather than disappearing,
   * because a config that still names `legacy` must be REFUSED with a
   * sentence rather than silently switched: a deployment pinned to the old
   * arithmetic made a choice, and quietly re-meaning what passes on their
   * next upgrade is the exact confusion this product exists to prevent.
   */
  composer: 'risk';
  /** How many wrongly blocked builds one shipped failure is worth. τ = 1 / (1 + c). */
  falsePassCost: number;
  /** What a critical rule that could not answer does to the verdict. */
  onCriticalSkipped: 'unknown' | 'fail' | 'pass';
  /** Inputs the deployment insists every evaluation carries; absent ones make the verdict unknown. */
  requiredEvidence: readonly Need[];
  /** Whether a shipped default threshold decides the verdict, or only advises. */
  defaultsGate: boolean;
  /** The prior that an output is bad, before any rule speaks. */
  prior: number;
  /** How that prior is spread over the failure classes the detectors examine. */
  priorMode: PriorMode;
  /**
   * The calibration table the confidence label is read from, by composite
   * version. Absent when judging now: the table this build ships. A stored
   * row passes the version it was stamped with (null when it carries none),
   * and its label is re-derived only when that is the table this build
   * ships — a label read from a different table would be a different
   * statement than the one the caller was given.
   */
  calibration?: string | null;
}

export const DEFAULT_COMPOSE: ComposeConfig = {
  composer: 'risk',
  falsePassCost: DEFAULT_FALSE_PASS_COST,
  onCriticalSkipped: 'unknown',
  requiredEvidence: [],
  defaultsGate: false,
  prior: DEFAULT_PRIOR,
  priorMode: DEFAULT_PRIOR_MODE,
};

/** The risk threshold a loss ratio implies: block when the expected loss of passing exceeds that of blocking. */
export function tau(falsePassCost: number): number {
  return 1 / (1 + falsePassCost);
}

const fired = (r: EvalRuleResult): boolean => !r.skipped && r.passed === false;


/**
 * The role a result plays under this configuration — resolved from the SAME
 * predicates compose() decides with, so the stamp and the verdict cannot
 * disagree. A skipped rule played no role and keeps none.
 */
export function roleOf(r: EvalRuleResult, cfg: ComposeConfig): Role {
  if (r.kind === 'judgment') return 'gate';
  if (r.kind === 'policy') return decides(r, cfg.defaultsGate) ? 'gate' : 'advisory';
  if (isCritical(r)) return 'veto';
  if (r.kind === 'detection' || r.kind === 'inference') return 'risk';
  return 'advisory';
}

/** The inputs at least one evaluated rule actually read. */
function inputsSeen(rows: readonly EvalRuleResult[]): Set<Need> {
  const seen = new Set<Need>();
  for (const r of rows) if (!r.skipped) for (const n of r.saw ?? []) seen.add(n);
  return seen;
}

/**
 * The path the verdict took, node by node, in the order the composer asks.
 *
 * This is the single writer of the decision: compose() reads the node that
 * decided and stamps the verdict from it, so the verdict and the path can
 * never disagree. It exists because `basis` names only the WINNER — an
 * embedder that wants to show a reader why (or a dashboard that wants to
 * draw the chain) had to re-implement these five questions, and a second
 * implementation of a decision is a second decision.
 *
 * Nodes after the one that decided are not in the path: they were never
 * asked. A node that was asked and found nothing is in the path with an
 * empty `by` — "we looked, there was nothing" is different from "we never
 * looked", and the difference is the whole point of the unknown layer.
 */
export function verdictPath(
  result: Pick<EvalResult, 'rule_results' | 'score' | 'insufficient_data' | 'rules_evaluated'>,
  cfg: ComposeConfig,
): VerdictNode[] {
  const rows = result.rule_results;
  const evaluated = result.rules_evaluated ?? rows.filter((r) => !r.skipped).length;
  if (result.insufficient_data || evaluated === 0) {
    return [{ node: 'nothing_judged', by: [], decided: true }];
  }
  const path: VerdictNode[] = [];

  /*
   * 1. Gates: a policy whose author has already decided — and a JUDGMENT,
   * for the same reason. Nobody runs a judge by accident: the caller chose
   * the template, supplied the key and paid for the answer, so a failing
   * judgment decides rather than being weighed against anything. It also
   * cannot be weighed: a judgment carries no published error rate until a
   * measured run exists for its template and model, so the risk layer would
   * drop it silently and a paid-for "fail" would read as clean.
   */
  const gates = rows.filter((r) => fired(r) && ((r.kind === 'policy' && decides(r, cfg.defaultsGate)) || r.kind === 'judgment'));
  path.push({ node: 'gate', by: gates.map((r) => r.ruleName), decided: gates.length > 0 });
  if (gates.length > 0) return path;

  /*
   * 2. Vetoes: an effectively-critical rule that is not a policy. Keyed on
   * "not a policy" rather than on the two detecting kinds, so a rule built
   * by hand without metadata — a test double, an embedder's own rule —
   * still vetoes when it is marked critical. Silently ignoring a critical
   * rule because it forgot to declare its kind is the failure mode this
   * composer exists to remove, not one to introduce.
   */
  const vetoes = rows.filter((r) => r.kind !== 'policy' && fired(r) && isCritical(r));
  path.push({ node: 'veto', by: vetoes.map((r) => r.ruleName), decided: vetoes.length > 0 });
  if (vetoes.length > 0) return path;

  /*
   * 3. Asked and could not answer. `not_applicable` is NEVER this: a
   * trajectory rule with no tool calls was not asked, and treating that as
   * unknown would make every text-only evaluation unknown, which is worse
   * than the fail-open it replaces. A deployment that set
   * `onCriticalSkipped: "pass"` still sees the node — it accepted this
   * risk, which is not the same as there being none.
   */
  const unknown = rows.filter((r) => isCritical(r) && r.skipped === true && r.skipClass !== undefined && r.skipClass !== 'not_applicable');
  path.push({ node: 'unknown', by: unknown.map((r) => r.ruleName), decided: unknown.length > 0 && cfg.onCriticalSkipped !== 'pass' });
  if (unknown.length > 0 && cfg.onCriticalSkipped !== 'pass') return path;

  // 4. Evidence the deployment insists on. `by` is the missing inputs, not rules.
  const seen = cfg.requiredEvidence.length > 0 ? inputsSeen(rows) : null;
  const missing = seen ? cfg.requiredEvidence.filter((n) => !seen.has(n)) : [];
  if (cfg.requiredEvidence.length > 0) {
    path.push({ node: 'evidence', by: [...missing], decided: missing.length > 0 });
    if (missing.length > 0) return path;
  }

  /*
   * 5. Everything that carries a published error rate, as one probability.
   * The node carries the estimate whether or not it decided: a clean
   * verdict that came through a measured risk is a different sentence from
   * one where nothing could be estimated, and both end here.
   */
  const risk = riskEstimate(result as EvalResult, cfg.prior, cfg.priorMode);
  const t = tau(cfg.falsePassCost);
  const by =
    risk === null
      ? []
      : Object.entries(risk.perClass)
          .filter(([, q]) => q !== null && q !== undefined && q > 0.5)
          .map(([cls]) => cls);
  path.push({ node: 'risk', by: risk !== null && risk.pBad > t ? by : [], decided: risk !== null && risk.pBad > t, risk });
  return path;
}

/**
 * Whether a verdict's confidence label can be derived under this
 * configuration: always when judging now, and on a stored row only when it
 * was stamped with the calibration table this build ships.
 */
export function calibrationAvailable(cfg: Pick<ComposeConfig, 'calibration'>): boolean {
  return cfg.calibration === undefined || cfg.calibration === PUBLISHED_CALIBRATION.compositeVersion;
}

/** The confidence label and why, for a verdict that came through the risk node. */
export function confidenceCall(
  result: Pick<EvalResult, 'rule_results'>,
  risk: { pBad: number; lo: number; hi: number },
  cfg: Pick<ComposeConfig, 'prior' | 'priorMode' | 'falsePassCost'>,
): ConfidenceCall {
  const localLabels = detectorsOf(result as EvalResult).some((d) => d.local !== undefined);
  return verdictConfidence(risk, tau(cfg.falsePassCost), { prior: cfg.prior, priorMode: cfg.priorMode, localLabels });
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** What the labelled corpus measured in the region a verdict's risk estimate fell in, as a clause. */
function measured(r: NonNullable<ConfidenceCall['region']>): string {
  return `outputs with a risk estimate of ${r.from.toFixed(1)}–${r.to.toFixed(1)} were bad ${pct(r.bad / r.n)} of the time (${r.bad} of ${r.n}; 95% interval ${pct(r.observed[0])}–${pct(r.observed[1])})`;
}

/**
 * The sentence a marginal verdict carries, naming which test it did not
 * pass, with the measured numbers behind it.
 *
 * A pass that is marginal only because the corpus has not confirmed the
 * estimate at its risk level is the ordinary case at the defaults, and it is
 * said plainly rather than as a warning, with the numbers. Where the corpus
 * measured more bad outputs than the estimate states, the note says the
 * estimate understated risk there: a calm note must not read as more
 * reassurance than the data gives. A fail, and any verdict whose interval
 * straddles the threshold, is a close call and says so.
 */
function marginalText(call: ConfidenceCall, state: Verdict['state']): string {
  const close = 'Treat it as a close call rather than a clear one.';
  const leadAt = (where: string): string =>
    state === 'pass'
      ? `Risk estimate not yet confirmed by labelled data ${where}; see iris-eval.com/proof.`
      : `This block is not yet confirmed by labelled data ${where}; see iris-eval.com/proof.`;
  const lead = leadAt(state === 'pass' ? 'at this level' : 'at this risk level');
  const tail = state === 'pass' ? '' : ` ${close}`;
  const r = call.region;
  switch (call.reason) {
    case 'interval_straddles':
      return `The credible interval on this risk estimate straddles your threshold, so this verdict could go either way on the evidence available. ${close}`;
    case 'setting_unmeasured':
      return `${leadAt('at this setting')} The labelled corpus measured the estimate at the shipped prior and prior reading with published error rates; this one was computed at another prior or reading, or with your own labels.${tail}`;
    case 'region_unmeasured':
      return `${lead} No labelled verdict had a risk estimate at this level.${tail}`;
    case 'region_too_few':
      return `${lead} Only ${r!.n} labelled verdict${r!.n === 1 ? '' : 's'}, from ${r!.patterns} distinct detector pattern${r!.patterns === 1 ? '' : 's'}, had a risk estimate of ${r!.from.toFixed(1)}–${r!.to.toFixed(1)}: too few to test the estimate there (at least ${MIN_BIN_N} verdicts from ${MIN_BIN_PATTERNS} patterns).${tail}`;
    case 'region_miscalibrated':
      if (state === 'pass' && r!.bad / r!.n > r!.meanPredicted!) {
        return `Risk estimate measured as too low at this level on labelled data; see iris-eval.com/proof. On the labelled corpus, ${measured(r!)}, against the ${pct(r!.meanPredicted!)} the estimate states.`;
      }
      return `${lead} On the labelled corpus, ${measured(r!)}, against the ${pct(r!.meanPredicted!)} the estimate states.${tail}`;
    case 'region_not_backed':
      return `${lead} On the labelled corpus, ${measured(r!)}, an interval that reaches your threshold.${tail}`;
    default:
      return close;
  }
}

/** The sentence a stored verdict carries when its label cannot be re-derived under the table it was given with. */
function unlabelledText(cfg: Pick<ComposeConfig, 'calibration'>): string {
  const was =
    typeof cfg.calibration === 'string'
      ? 'It was labelled under an earlier calibration of the risk estimate than this release uses'
      : 'It was stored before verdicts recorded which calibration labelled them';
  return `This stored verdict carries no confidence label. ${was}; labelling it again under the current calibration would state something other than what the caller was told. Its result and risk are as stored. Re-evaluate the output to label it under the current calibration.`;
}

/**
 * The verdict for one evaluation. The weighted mean is never consulted: it
 * survives as a quality gradient on the score field and is never re-meant.
 *
 * Every question this asks is asked by verdictPath() above; this reads the
 * node that decided and stamps it. Adding a layer means adding a node.
 */
export function compose(
  result: Pick<EvalResult, 'rule_results' | 'score' | 'insufficient_data' | 'rules_evaluated'>,
  cfg: ComposeConfig,
): Verdict {
  const path = verdictPath(result, cfg);
  const decided = path.find((n) => n.decided);
  const riskNode = path.find((n) => n.node === 'risk');
  const risk = riskNode?.risk ?? null;
  /*
   * Decisive only where the composite corpus measured the estimate to hold
   * (./confidence.ts), and only under the table the verdict was given with:
   * a stored row labelled under another table carries no label on read.
   */
  const confidence: Verdict['confidence'] = risk === null || !calibrationAvailable(cfg) ? undefined : confidenceCall(result, risk, cfg).confidence;

  switch (decided?.node) {
    case 'nothing_judged':
      return { state: 'unknown', passed: false, basis: 'no_rules', by: [], risk: null };
    case 'gate':
      return { state: 'fail', passed: false, basis: 'policy_gate', by: decided.by, risk: null };
    case 'veto':
      return { state: 'fail', passed: false, basis: 'detector_veto', by: decided.by, risk: null };
    case 'unknown':
      return cfg.onCriticalSkipped === 'fail'
        ? { state: 'fail', passed: false, basis: 'critical_unknown', by: decided.by, risk: null }
        : { state: 'unknown', passed: false, basis: 'critical_unknown', by: decided.by, risk: null };
    case 'evidence':
      return { state: 'unknown', passed: false, basis: 'required_evidence_missing', by: decided.by, risk: null };
    case 'risk':
      return { state: 'fail', passed: false, basis: 'risk_over_loss', by: decided.by, risk, confidence };
    default:
      return risk === null
        ? { state: 'pass', passed: true, basis: 'clean', by: [], risk: null }
        : { state: 'pass', passed: true, basis: 'clean', by: [], risk, confidence };
  }
}

/**
 * The sentences a reader needs that the verdict alone does not carry.
 *
 * The one that must exist: when a rule visibly FIRED and the verdict still
 * passed, say why and name the one setting that would change it. Without
 * it, "cost_under_threshold failed" beside "passed: true" reads as a bug,
 * and that is the first thing a builder who never opens a config file will
 * meet.
 */
export function interpretations(result: Pick<EvalResult, 'rule_results' | 'coverage'>, verdict: Verdict, cfg: ComposeConfig): Interpretation[] {
  const out: Interpretation[] = [];
  /*
   * To the agent, first: a question that was not judged because the call
   * did not carry what it needs. An agent that reads this passes the input
   * next time; one that does not read it reports "clean" about a question
   * nobody asked. One sentence per question, naming the input.
   */
  for (const q of result.coverage?.questions ?? []) {
    if (q.status !== 'unjudged' || !q.why?.startsWith('not supplied')) continue;
    out.push({
      severity: 'note',
      addressee: 'agent',
      text: `${q.id} was not judged — ${q.why}. Supply it to have this question judged.`,
    });
  }
  /*
   * Nothing was judged — the line `suggestions` used to carry as
   * "Insufficient context to evaluate. Provide: ..." or "No rules
   * configured for this eval type". It is the agent's to act on: it names
   * what to supply, or says the deployment configured no rule for this
   * bundle, and it is the difference between a clean answer and no answer
   * at all.
   */
  if (verdict.basis === 'no_rules') {
    const skipped = result.rule_results.filter((r) => r.skipped);
    out.push({
      severity: 'block',
      addressee: 'agent',
      text:
        skipped.length > 0
          ? `Nothing was judged: every rule skipped (${skipped.map((r) => `${r.ruleName} — ${r.skipReason ?? 'missing context'}`).join('; ')}). Supply what each one needs and ask again.`
          : 'Nothing was judged: no rule is configured for this eval type. Deploy a rule for it, or ask for an eval type that has one.',
    });
  }
  /*
   * The relevance judge (#649), in the two cases a reader must be told about
   * whether or not the rule fired: it did not answer, so the verdict rests on
   * the lexical reading a deployment that installed a judge did not expect;
   * or it shares a model family with the agent, so its verdict is a
   * same-family opinion. Both are read off the stored rule result, so a row
   * read back says what the caller was told.
   */
  for (const r of result.rule_results) {
    const j = r.judge;
    if (!j) continue;
    if (j.error !== undefined) {
      const outcome = r.skipped ? 'which could not judge this output either' : fired(r) ? 'which failed it but only advises at the shipped thresholds' : 'which passed it';
      out.push({
        severity: 'warn',
        addressee: 'operator',
        rule: r.ruleName,
        text: `The relevance judge (${j.provider ?? 'unknown provider'}/${j.model}) did not answer, so ${r.ruleName} fell back to its lexical reading, ${outcome}: ${j.error}.`,
        configKey: RELEVANCE_JUDGE_MODEL_VAR,
      });
    } else if (j.sameFamily && j.agentModel) {
      out.push({ severity: 'warn', addressee: 'operator', rule: r.ruleName, text: sameFamilyWarning(j.model, j.agentModel).message, configKey: RELEVANCE_JUDGE_MODEL_VAR });
    }
  }
  for (const r of result.rule_results) {
    if (!fired(r)) continue;
    if (verdict.by.includes(r.ruleName)) continue;
    if (r.ruleName === 'answers_the_ask' && r.kind === 'policy' && r.judge === undefined && !decides(r, cfg.defaultsGate)) {
      /*
       * Without a judge the rule advises, and says why (#649): the generic
       * sentence below names only the thresholds, and the setting that turns
       * this rule into a gate a reader can trust is the judge.
       */
      out.push({
        severity: 'warn',
        addressee: 'operator',
        rule: r.ruleName,
        text: `${r.ruleName} failed on its lexical reading, against thresholds Iris ships rather than ones you set, so it did not decide this verdict: comparing words fails some correct paraphrases, so without a judge the rule only advises. Set ${RELEVANCE_JUDGE_MODEL_VAR} to a priced model (with its provider's key) to have an LLM judge decide off-topic answers, or set a keyword_overlap or topic_consistency threshold to gate on the lexical reading.`,
        configKey: RELEVANCE_JUDGE_MODEL_VAR,
      });
      continue;
    }
    if (r.kind === 'policy' && r.origin === 'custom' && !decides(r, cfg.defaultsGate)) {
      // The deployment's own rule: nothing Iris ships was involved, so the
      // threshold note below would blame the wrong party (2026-09-23 review).
      out.push({
        severity: 'warn',
        addressee: 'operator',
        rule: r.ruleName,
        text: `${r.ruleName} is your custom rule and it advises: it carries severity low, medium or none. Give it severity high or critical (inline or in deploy_rule) to make a failure fail the verdict.`,
        configKey: 'severity',
      });
      continue;
    }
    if (r.kind === 'policy' && !decides(r, cfg.defaultsGate)) {
      out.push({
        severity: 'warn',
        addressee: 'operator',
        rule: r.ruleName,
        text: `${r.ruleName} failed against a threshold Iris ships, not one you set, so it did not decide this verdict. Set it in your configuration to make it a gate, or set eval.defaultsGate to true to make every shipped default gate.`,
        configKey: 'eval.defaultsGate',
      });
      continue;
    }
    if (verdict.state === 'pass') {
      out.push({
        severity: 'note',
        addressee: 'operator',
        rule: r.ruleName,
        text: `${r.ruleName} failed but the verdict passed: on its published accuracy this rule alone does not carry the risk past your loss threshold. Raise eval.falsePassCost to block on weaker evidence (the loss threshold is 1 / (1 + falsePassCost)).`,
        configKey: 'eval.falsePassCost',
      });
    }
  }
  if (verdict.basis === 'critical_unknown') {
    out.push({
      severity: 'block',
      addressee: 'operator',
      text: `A critical check was asked and could not answer (${verdict.by.join(', ')}), so this verdict is unknown rather than clean. Set eval.onCriticalSkipped to "pass" to accept that risk, or to "fail" to treat it as a failure.`,
      configKey: 'eval.onCriticalSkipped',
    });
  }
  /*
   * A critical rule that skipped but did NOT make the verdict unknown —
   * because what it needed was never applicable, or because the deployment
   * set `onCriticalSkipped: "pass"`. `critical_skipped` names it in the
   * fields; this is the sentence that used to ride in `suggestions`, and
   * without it a reader sees a clean verdict with no hint that a
   * must-not-ship check never ran.
   */
  const skippedCritical = result.rule_results.filter((r) => isCritical(r) && r.skipped === true).map((r) => r.ruleName);
  if (skippedCritical.length > 0 && verdict.basis !== 'critical_unknown') {
    out.push({
      severity: 'warn',
      addressee: 'operator',
      text: `Critical check(s) did not judge this output (${skippedCritical.join(', ')}), so they could not veto it. This verdict is clean on everything else, not on those; a gate that must fail closed should treat a skipped critical check as a failure.`,
      configKey: 'eval.onCriticalSkipped',
    });
  }
  if (verdict.confidence === 'marginal' && verdict.risk !== null) {
    out.push({
      severity: 'note',
      addressee: 'operator',
      text: marginalText(confidenceCall(result, verdict.risk, cfg), verdict.state),
    });
  }
  if (verdict.risk !== null && !calibrationAvailable(cfg)) {
    out.push({ severity: 'note', addressee: 'operator', text: unlabelledText(cfg) });
  }
  return out;
}
