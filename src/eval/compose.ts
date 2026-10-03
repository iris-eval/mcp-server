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
import type { EvalResult, EvalRuleResult, EvidenceRecord, Interpretation, Need, Role, Verdict, VerdictLayer, VerdictNode } from '../types/eval.js';
import { riskEstimate, detectorsOf, DEFAULT_PRIOR, DEFAULT_PRIOR_MODE, DEFAULT_FALSE_PASS_COST, type PriorMode } from './risk.js';
import { verdictConfidence, MIN_BIN_N, MIN_BIN_PATTERNS, type ConfidenceCall } from './confidence.js';
import { PUBLISHED_CALIBRATION } from './published-calibration.js';
import { decides, isCritical } from './gate.js';
import { RELEVANCE_JUDGE_MODEL_VAR } from './llm-judge/relevance-judge.js';
import { sameFamilyWarning } from './llm-judge/family.js';
import { brokenOf, captureLabel } from './evidence.js';

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
  /**
   * Which rules the layers are read under (COMPOSER_RULES). Absent when
   * judging now: this build's. A stored row passes the number it was
   * stamped with, and 1 when it carries none, so it reads back as the
   * verdict its caller was given and not as the one this build would give.
   */
  rules?: number;
}

/**
 * The composer's rules, as a number a stored row is stamped with
 * (Provenance.composer.rules).
 *
 *   1  through 0.19.x: the verdict is the first layer with something to
 *      say, in the order the layers are asked.
 *   2  from 0.20.0: a layer that fails outranks one that could not check
 *      (primaryOf).
 *
 * Moved only when the same stored rule results would compose to a different
 * verdict. A new rule, a new stamp or a new layer input does not move it:
 * an old row does not carry them and reads as it did.
 */
export const COMPOSER_RULES = 2;

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

/**
 * The rules somebody asked for that skipped because the call did not carry
 * what they read (stamp.ts, askedOf).
 *
 * A deployment that set `eval.onCriticalSkipped: "pass"` has said a
 * critical check that could not run is acceptable, and that covers a
 * critical rule that could not run for missing evidence as much as one the
 * output defeated: such a rule is left out here.
 */
function askedAndNotSent(rows: readonly EvalRuleResult[], cfg: Pick<ComposeConfig, 'onCriticalSkipped'>): EvalRuleResult[] {
  return rows.filter((r) => r.skipped === true && r.asked !== undefined && (r.lacked?.length ?? 0) > 0 && !(cfg.onCriticalSkipped === 'pass' && isCritical(r)));
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
 * Nodes after the one the verdict is stamped from are not in the path. A
 * node that was asked and found nothing is in the path with an empty `by` —
 * "we looked, there was nothing" is different from "we never looked", and
 * the difference is the whole point of the unknown layer.
 *
 * The verdict is stamped from the first layer that FAILS, when one does,
 * and otherwise from the first that could not check (compose() says why).
 * So the path can pass through a layer that could not check on its way to
 * the failure: that node is `decided` too, and the last node is the
 * verdict's.
 *
 * The layers do not exclude each other, and compose() asks every one of
 * them: what the later layers would have decided is on the verdict as
 * `also`, so a reader acting on one basis is never told a credential leak
 * did not happen because a cost ceiling was broken first.
 */
export function verdictPath(
  result: Pick<EvalResult, 'rule_results' | 'score' | 'insufficient_data' | 'rules_evaluated' | 'provenance'>,
  cfg: ComposeConfig,
): VerdictNode[] {
  const nodes = walk(result, cfg, false);
  const primary = primaryOf(nodes, cfg);
  return primary === undefined ? nodes : nodes.slice(0, nodes.indexOf(primary) + 1);
}

/**
 * The layer the verdict is stamped from: the first that fails, else the
 * first that could not check, else none.
 *
 * A failure outranks "could not check". The layers are asked in a fixed
 * order and the two that answer `unknown` (a critical check that could not
 * run, evidence that was asked for and not sent) come before the risk
 * layer, so an output the risk layer fails used to read `unknown` whenever
 * one of them had something to say: an invented figure read fail, and the
 * same output on a deployment that requires a cost and got none read
 * unknown. Adding a second problem softened the first. It now reads fail,
 * with the layer that could not check listed beside it.
 */
function primaryOf(nodes: VerdictNode[], cfg: ComposeConfig): VerdictNode | undefined {
  const deciding = nodes.filter((n) => n.decided);
  if (deciding[0]?.node === 'nothing_judged') return deciding[0];
  // A row stored under the earlier rules reads back as it was given.
  if ((cfg.rules ?? COMPOSER_RULES) < 2) return deciding[0];
  return deciding.find((n) => layerOf(n, cfg).state === 'fail') ?? deciding[0];
}

/**
 * The layers in the order they are asked. With `stopAtDecision` the walk
 * ends at the first layer that decides, which is the path; without it every
 * layer is asked, and `decided` on a later node means it would have decided
 * on its own. One function for both, so the path and `Verdict.also` cannot
 * disagree about what a layer is.
 */
function walk(
  result: Pick<EvalResult, 'rule_results' | 'score' | 'insufficient_data' | 'rules_evaluated' | 'provenance'>,
  cfg: ComposeConfig,
  stopAtDecision: boolean,
): VerdictNode[] {
  const rows = result.rule_results;
  const evaluated = result.rules_evaluated ?? rows.filter((r) => !r.skipped).length;
  if (result.insufficient_data || evaluated === 0) {
    /*
     * Nothing judged decides the verdict, and evidence that was asked for or
     * promised and is not in the record is still said beside it: a capture
     * source's hole, on a call whose bundle ran nothing, read `no_rules` with
     * no word about the hole, and a gate on required_evidence_missing passed
     * it. A row judged under the earlier rules reads back as it was given.
     */
    const nothing: VerdictNode = { node: 'nothing_judged', by: [], decided: true };
    const ev = (cfg.rules ?? COMPOSER_RULES) >= 2 ? evidenceNode(result, cfg) : null;
    return ev?.decided ? [nothing, ev] : [nothing];
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
  if (stopAtDecision && gates.length > 0) return path;

  /*
   * 2. Vetoes: an effectively-critical rule that is not a policy. Keyed on
   * "not a policy" rather than on the two detecting kinds, so a rule built
   * by hand without metadata — a test double, an embedder's own rule —
   * still vetoes when it is marked critical. Silently ignoring a critical
   * rule because it forgot to declare its kind is the failure mode this
   * composer exists to remove, not one to introduce. A judgment is a gate
   * above, critical or not, and is not counted a second time here.
   */
  const vetoes = rows.filter((r) => r.kind !== 'policy' && r.kind !== 'judgment' && fired(r) && isCritical(r));
  path.push({ node: 'veto', by: vetoes.map((r) => r.ruleName), decided: vetoes.length > 0 });
  if (stopAtDecision && path.some((n) => n.decided)) return path;

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
  if (stopAtDecision && path.some((n) => n.decided)) return path;

  /*
   * 4. Evidence somebody asked for and the call did not carry. `by` is the
   * missing inputs, not rules. Three sources: the inputs the deployment
   * insists every evaluation carries (eval.requiredEvidence); the inputs of
   * any rule that was asked for and skipped without them — a policy whose
   * threshold the deployment set, a rule it promoted to critical or
   * deployed as a gate, an expectation the call itself supplied (stamp.ts,
   * askedOf); and the fields the trace's capture source declared it records
   * in full and the trace left out (evidence.ts). A rule nobody asked for
   * that had nothing to judge stays out of this: a text-only evaluation is
   * not unknown.
   *
   * Required evidence is met by what the call CARRIED, from the evidence
   * record the engine stamps. A row stored before that record existed is
   * read as it always was, by what an evaluated rule read: so a cost sent
   * to a call that ran only the safety bundle read as missing.
   */
  const ev = evidenceNode(result, cfg);
  if (ev !== null) {
    path.push(ev);
    if (stopAtDecision && path.some((n) => n.decided)) return path;
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

/** The evidence layer's node, or null when nothing asked for or promised any evidence (walk(), step 4, says what it reads). */
function evidenceNode(result: Pick<EvalResult, 'rule_results' | 'provenance'>, cfg: ComposeConfig): VerdictNode | null {
  const rows = result.rule_results;
  const evidence = result.provenance?.evidence;
  const seen = cfg.requiredEvidence.length > 0 ? (evidence !== undefined ? new Set<Need>(evidence.carried) : inputsSeen(rows)) : null;
  const required = seen ? cfg.requiredEvidence.filter((n) => !seen.has(n)) : [];
  const asked = askedAndNotSent(rows, cfg);
  const broken = brokenOf(evidence);
  const missing = [...new Set<string>([...required, ...broken, ...asked.flatMap((r) => r.lacked!)])];
  if (cfg.requiredEvidence.length === 0 && asked.length === 0 && broken.length === 0) return null;
  return { node: 'evidence', by: missing, decided: missing.length > 0 };
}

/**
 * Whether a verdict's confidence label can be derived under this
 * configuration: always when judging now, and on a stored row only when it
 * was stamped with the calibration table this build ships. The stamp is the
 * table's own version, which changes with its content, not the corpus's:
 * the table is regenerated whenever a rule moves a verdict, and the corpus
 * stays the same.
 */
export function calibrationAvailable(cfg: Pick<ComposeConfig, 'calibration'>): boolean {
  return cfg.calibration === undefined || cfg.calibration === PUBLISHED_CALIBRATION.version;
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

/** One later layer, as a clause. */
function layerText(l: VerdictLayer): string {
  const by = l.by.join(', ');
  switch (l.basis) {
    case 'detector_veto':
      return `a critical rule fired (${by})`;
    case 'critical_unknown':
      return `a critical check was asked and could not answer (${by})`;
    case 'required_evidence_missing':
      return `evidence that was asked for or promised is not in the record (${by})`;
    default:
      return `the rules that fired put the risk of a bad output over the loss threshold${by ? ` (${by})` : ''}`;
  }
}

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
 * Every question this asks is asked by walk() above, the function
 * verdictPath() reads; this stamps the verdict from the first layer that
 * fails, or when none does from the first that could not check, and lists
 * every other layer that would have decided. Adding a layer means adding a
 * node.
 */
export function compose(
  result: Pick<EvalResult, 'rule_results' | 'score' | 'insufficient_data' | 'rules_evaluated' | 'provenance'>,
  cfg: ComposeConfig,
): Verdict {
  const nodes = walk(result, cfg, false);
  const decided = primaryOf(nodes, cfg);
  const later = nodes.filter((n) => n.decided && n !== decided);
  if (decided?.node === 'nothing_judged') {
    const also = later.map((n) => layerOf(n, cfg) as VerdictLayer);
    return { state: 'unknown', passed: false, basis: 'no_rules', by: [], risk: null, ...(also.length > 0 ? { also } : {}) };
  }

  /*
   * The estimate and its label ride on the verdict only when the risk layer
   * was the last word: it decided, or nothing did. Under an earlier basis
   * the `also` entry speaks for it and no label is computed.
   */
  if (decided !== undefined && decided.node !== 'risk') {
    const first = layerOf(decided, cfg);
    const also = later.map((n) => layerOf(n, cfg) as VerdictLayer);
    return { state: first.state, passed: false, basis: first.basis, by: first.by, risk: null, ...(also.length > 0 ? { also } : {}) };
  }
  const head = decided ?? null;
  const risk = nodes.find((n) => n.node === 'risk')?.risk ?? null;
  if (risk === null) return { state: 'pass', passed: true, basis: 'clean', by: [], risk: null };
  /*
   * Decisive only where the composite corpus measured the estimate to hold
   * (./confidence.ts), and only under the table the verdict was given with:
   * a stored row labelled under another table carries no label on read.
   */
  const confidence: Verdict['confidence'] = calibrationAvailable(cfg) ? confidenceCall(result, risk, cfg).confidence : undefined;
  if (head === null) return { state: 'pass', passed: true, basis: 'clean', by: [], risk, confidence };
  // The risk layer fails it; a layer asked before it that could not check is listed, not allowed to soften it.
  const also = later.map((n) => layerOf(n, cfg) as VerdictLayer);
  return { state: 'fail', passed: false, basis: 'risk_over_loss', by: head.by, risk, confidence, ...(also.length > 0 ? { also } : {}) };
}

const WORSE: Record<Verdict['state'], number> = { pass: 0, unknown: 1, fail: 2 };
const worseOf = (a: Verdict['state'], b: Verdict['state']): Verdict['state'] => (WORSE[a] >= WORSE[b] ? a : b);

/**
 * What one bundle's row says: the evaluation's verdict, read for the rules
 * this bundle holds.
 *
 * A bundle that evaluated no rule was not checked. Otherwise the row
 * passes unless a layer of the verdict (the one that decided, or any other
 * that would have) rests on this bundle's rules, and then it is what that
 * layer made the verdict. The gate, veto and unknown layers name their
 * rules. The risk layer names failure classes, so a bundle holding a fired
 * risk-layer rule answers for it. Evidence the deployment requires on
 * every evaluation, or that the capture source declared and the record
 * left out, when missing, leaves every bundle unchecked; evidence one rule
 * lacked leaves that rule's bundle unchecked.
 *
 * The composer is not run again over the bundle's rules alone. The risk
 * estimate is a property of the whole evaluation (the prior is spread over
 * every class examined), and over one bundle's rules it comes out
 * different: a row could fail on an evaluation that passes.
 *
 * So the rows and the verdict cannot disagree: every row of a passing
 * evaluation that was checked passes, and whenever the evaluation does not
 * pass, the row whose rules are why does not pass either.
 */
export function bundleState(
  rows: readonly EvalRuleResult[],
  verdict: Verdict,
  cfg: ComposeConfig,
  all: readonly EvalRuleResult[] = rows,
  evidence?: EvidenceRecord,
): Verdict['state'] {
  const ran = rows.some((r) => !r.skipped);
  if (verdict.state === 'pass') return ran ? 'pass' : 'unknown';
  let state: Verdict['state'] = ran ? 'pass' : 'unknown';
  const layers: Array<{ basis: Verdict['basis']; state: Verdict['state']; by: string[] }> = [{ basis: verdict.basis, state: verdict.state, by: verdict.by }, ...(verdict.also ?? [])];
  // Every detection and inference that ran enters the risk estimate, a critical one included: a veto is also read as a probability.
  const isRisk = (r: EvalRuleResult): boolean => !r.skipped && (r.kind === 'detection' || r.kind === 'inference');
  for (const layer of layers) {
    if (layer.basis === 'required_evidence_missing') {
      /*
       * Evidence the deployment requires on every evaluation is missing
       * for every bundle. Evidence one rule lacked is missing for the
       * bundle that holds the rule: a cost that was not sent says nothing
       * about whether the safety rules ran.
       */
      const everywhere = cfg.requiredEvidence.some((n) => layer.by.includes(n)) || brokenOf(evidence).some((n) => layer.by.includes(n));
      const here = askedAndNotSent(rows, cfg).length > 0;
      if (everywhere || here) state = worseOf(state, layer.state);
    } else if (layer.basis === 'risk_over_loss') {
      /*
       * The risk layer names failure classes, not rules. A bundle holding
       * a fired risk-layer rule answers for it. When no rule fired at all
       * (a deployment whose loss ratio puts the line under the risk of an
       * output nothing flagged), every bundle whose rules the estimate was
       * built from answers for it.
       */
      const anyFired = all.some((r) => fired(r) && isRisk(r));
      if (anyFired ? rows.some((r) => fired(r) && isRisk(r)) : rows.some(isRisk)) state = worseOf(state, layer.state);
    } else if (rows.some((r) => layer.by.includes(r.ruleName))) state = worseOf(state, layer.state);
  }
  return state;
}

const BASIS_OF = {
  gate: 'policy_gate',
  veto: 'detector_veto',
  unknown: 'critical_unknown',
  evidence: 'required_evidence_missing',
  risk: 'risk_over_loss',
} as const;

/** What a deciding layer makes the verdict: the one place a node becomes a basis and a state. */
function layerOf(n: VerdictNode, cfg: ComposeConfig): { basis: (typeof BASIS_OF)[keyof typeof BASIS_OF]; state: 'fail' | 'unknown'; by: string[] } {
  const basis = BASIS_OF[n.node as keyof typeof BASIS_OF];
  const state = n.node === 'evidence' || (n.node === 'unknown' && cfg.onCriticalSkipped !== 'fail') ? 'unknown' : 'fail';
  return { basis, state, by: n.by };
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
export function interpretations(result: Pick<EvalResult, 'rule_results' | 'coverage' | 'provenance'>, verdict: Verdict, cfg: ComposeConfig): Interpretation[] {
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
  /*
   * The layers after the one that decided. `basis` names one layer and a
   * reader fixes what it names: an agent told only that its cost ceiling
   * failed lowers the cost and ships the credential that was in the same
   * output. A risk layer that follows a veto is not a second finding (it is
   * the vetoing detector read again, as a probability), so it stays on the
   * `also` field and gets no sentence.
   */
  const laterRules = new Set((verdict.also ?? []).filter((l) => l.basis !== 'risk_over_loss').flatMap((l) => l.by));
  const vetoed = verdict.basis === 'detector_veto' || (verdict.also ?? []).some((l) => l.basis === 'detector_veto');
  const said = (verdict.also ?? []).filter((l) => !(l.basis === 'risk_over_loss' && vetoed)).map(layerText);
  if (said.length > 0) {
    out.push({
      severity: 'block',
      addressee: 'agent',
      text: `${verdict.basis} decided this verdict, and it is not the only layer that would have: ${said.join('; ')}. Clearing ${verdict.by.join(', ') || 'the first'} alone does not clear the verdict.`,
    });
  }
  for (const r of result.rule_results) {
    if (!fired(r)) continue;
    if (verdict.by.includes(r.ruleName) || laterRules.has(r.ruleName)) continue;
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
  const unanswered = verdict.basis === 'critical_unknown' ? verdict : (verdict.also ?? []).find((l) => l.basis === 'critical_unknown');
  if (unanswered !== undefined) {
    out.push({
      severity: 'block',
      addressee: 'operator',
      text:
        verdict.basis === 'critical_unknown'
          ? `A critical check was asked and could not answer (${unanswered.by.join(', ')}), so this verdict is unknown rather than clean. Set eval.onCriticalSkipped to "pass" to accept that risk, or to "fail" to treat it as a failure.`
          : `A critical check was asked and could not answer (${unanswered.by.join(', ')}). The verdict failed on other grounds; that check is still not answered. Set eval.onCriticalSkipped to "pass" to accept that risk.`,
      configKey: 'eval.onCriticalSkipped',
    });
  }
  /*
   * Evidence somebody asked for was not sent. Said to the agent, because
   * the agent is who can send it: which rules could not run, what each
   * lacked, and who had asked. Without the sentence a reader holds
   * `required_evidence_missing: cost` and has to work out that the
   * deployment's own cost ceiling is why.
   */
  if (verdict.basis === 'required_evidence_missing' || (verdict.also ?? []).some((l) => l.basis === 'required_evidence_missing')) {
    const layer = verdict.basis === 'required_evidence_missing' ? verdict : (verdict.also ?? []).find((l) => l.basis === 'required_evidence_missing')!;
    const asked = askedAndNotSent(result.rule_results, cfg);
    const byRule = asked.map((r) => `${r.ruleName} could not run without ${r.lacked!.join(', ')} (${r.asked === 'config' ? 'this deployment asks for it' : 'this call asks for it'})`);
    /*
     * A field the capture source promised and the record lacks is the
     * capture's to fix, not the agent's to send: it gets its own sentence,
     * to the operator. What is left is the agent's to send.
     */
    const evidence = result.provenance?.evidence;
    const broken = brokenOf(evidence).filter((n) => layer.by.includes(n));
    const send = layer.by.filter((n) => !(broken as string[]).includes(n));
    const required = cfg.requiredEvidence.filter((n) => send.includes(n));
    const source = captureLabel(evidence?.capture);
    // On a verdict that failed, or that nothing could judge, the missing evidence is a second thing to fix, not the answer.
    const first = verdict.basis === 'required_evidence_missing';
    const lead = first ? 'Not checked, which is not a pass' : 'Also not checked';
    if (send.length > 0) {
      const parts = [...(required.length > 0 ? [`this deployment requires ${required.join(', ')} on every evaluation`] : []), ...byRule];
      out.push({
        severity: 'block',
        addressee: 'agent',
        text: `${lead}: ${parts.join('; ') || `${send.join(', ')} was asked for and not sent`}. ${first ? `Send ${send.join(', ')} and ask again.` : `Send ${send.join(', ')} so it can be.`}`,
        ...(required.length > 0 ? { configKey: 'eval.requiredEvidence' } : {}),
      });
    }
    if (broken.length > 0) {
      out.push({
        severity: 'block',
        addressee: 'operator',
        text: `${lead}: ${source} declares it records ${broken.join(' and ')} in full, and this trace does not carry ${broken.length === 1 ? 'it' : 'them'} in full. The record is incomplete: check how ${source} records ${broken.join(' and ')}.`,
      });
    }
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
  if (skippedCritical.length > 0 && unanswered === undefined) {
    out.push({
      severity: 'warn',
      addressee: 'operator',
      text:
        verdict.state === 'pass'
          ? `Critical check(s) did not judge this output (${skippedCritical.join(', ')}), so they could not veto it. This verdict is clean on everything else, not on those; a gate that must fail closed should treat a skipped critical check as a failure.`
          : `Critical check(s) did not judge this output (${skippedCritical.join(', ')}), so they could not veto it. The verdict above says nothing about what they check.`,
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
