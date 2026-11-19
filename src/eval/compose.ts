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
 *   3. UNKNOWN   — a check whose answer would have counted and that could
 *                  not answer: it threw, was stopped at a limit, read a
 *                  record that was cut, or its definition is broken. A
 *                  critical rule; and from 0.22.0 a rule somebody asked
 *                  for, a gate, and a weighed rule that threw (hadToAnswer).
 *                  Not the same as never asked, which is coverage. This is
 *                  the fail-open seam the audit found, and closing it is
 *                  why the verdict has three states.
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
import { riskEstimate, detectorsOf, weighedByTheEstimate, DEFAULT_PRIOR, DEFAULT_PRIOR_MODE, DEFAULT_FALSE_PASS_COST, type PriorMode } from './risk.js';
import { publishedAccuracyFor } from './accuracy.js';
import { verdictConfidence, MIN_BIN_N, MIN_BIN_PATTERNS, type ConfidenceCall } from './confidence.js';
import { PUBLISHED_CALIBRATION } from './published-calibration.js';
import { couldNotAnswer, decides, isCritical } from './gate.js';
import { LOCAL_LABEL_MIN } from './labels.js';
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
  /** What a check the third layer names does to the verdict: a rule whose answer would have counted and that could not answer. The key keeps the name it had when that layer read critical rules alone. */
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
 *   3  from 0.22.0: a check that could not answer leaves the verdict unknown
 *      wherever its answer would have counted, by the role it plays (walk,
 *      the third layer), and a verdict the risk estimate failed names the
 *      class that carried it (carriedBy). A row stored under 2, or under no
 *      number, holds results that would compose otherwise under 3: a rule
 *      that threw (no release stored one, and a build since #1012 did), a
 *      gate that could not answer and was not critical, a risk failure in
 *      which no class is more likely than not. Each reads back as given.
 *
 * Moved only when the same stored rule results would compose to a different
 * verdict: another state, another basis, or other names in it. A new rule,
 * a new stamp or a new layer input does not move it: an old row does not
 * carry them and reads as it did.
 */
export const COMPOSER_RULES = 3;

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
 * disagree.
 *
 * On a result that answered it is what the composer did with it. On one
 * that could not answer it is the part its answer could have played, read
 * from the same row by the same lines: the engine writes on such a row the
 * facts an answer would have carried (that it only reports, and why; whose
 * number a rule with a threshold stood at), so a fire and a silence are
 * read by one predicate over one kind of input. Where a rule's answered
 * role turns on what the answer found (answers_the_ask is a gate by the
 * measurement that fired), the silent row has the strongest of them: a
 * gate when somebody set one of the rule's numbers. A policy that could not
 * answer and whose row carries no such fact is read as a gate: a rule that
 * declares no threshold has no shipped number to advise at.
 *
 * A result that had nothing to judge took no part in anything; its role
 * says what its rule's kind is weighed as.
 */
export function roleOf(r: EvalRuleResult, cfg: ComposeConfig): Role {
  // The result reports only: the deployment named the rule in eval.advisoryRules, or the rule gave its own reason (advisoryWhy). It is in no layer below.
  if (r.advisory === true) return 'advisory';
  if (r.kind === 'judgment') return 'gate';
  if (r.kind === 'policy') return decides(r, cfg.defaultsGate) ? 'gate' : 'advisory';
  if (isCritical(r)) return 'veto';
  // A detection or an inference is weighed by its published accuracy. One with none (a plugin's) is read by no layer: it reports.
  if (r.kind === 'detection' || r.kind === 'inference') return publishedAccuracyFor(r.ruleName) !== null ? 'risk' : 'advisory';
  return 'advisory';
}

/**
 * Whether a result that could not answer is one whose answer would have
 * counted. The third layer reads this, and the sentences about that layer
 * are written from it, so a layer and its sentence cannot name different
 * rows.
 *
 * A critical rule, always. Until 0.22.0 nothing else was read, so a gate
 * that was not critical, or a detection the estimate weighs, could fail a
 * verdict by firing and pass it by throwing: a run that repeated one call
 * six times failed, and the same run with that call's input nested 2,000
 * levels deep passed clean, the loop check having thrown (#1040). A row
 * stored under the earlier rules reads back as it was given.
 *
 * From composer rules 3:
 *   - a rule somebody asked for (stamp.ts, askedOf) counts whatever its
 *     kind, as it does in the layer below when it lacked an input;
 *   - a gate or a veto decides alone, so one that could not answer, however
 *     it came to that, counts: a policy the deployment set or installed, a
 *     judgment, a critical rule. What gates is read off the role (roleOf),
 *     the one predicate the layers above and below decide by;
 *   - a detection or an inference the estimate weighs is one voice among
 *     several. It counts when it THREW, which no natural run does and an
 *     input built for it can. Stopped at a limit of work, by a record that
 *     was cut, by an input it could not judge or by a definition that is
 *     broken, it takes no part, as before (#1038 is where those are decided);
 *   - a rule that only reports and that nobody asked for takes no part by
 *     its fire, and none by its silence. Its row says that it reports, on
 *     an answer and on a silence alike (engine.ts).
 */
function hadToAnswer(r: EvalRuleResult, cfg: ComposeConfig): boolean {
  if (isCritical(r)) return true;
  if ((cfg.rules ?? COMPOSER_RULES) < 3) return false;
  if (r.asked !== undefined) return true;
  const role = roleOf(r, cfg);
  return role === 'gate' || role === 'veto' || (role === 'risk' && r.threw === true);
}

/** A row the third layer names, as a sentence names it: with why it had to answer, unless it is critical. */
function whyItHadTo(r: EvalRuleResult): string {
  if (isCritical(r)) return r.ruleName;
  if (r.asked !== undefined) return `${r.ruleName}, which this ${r.asked === 'config' ? 'deployment' : 'call'} asked for`;
  return r.threw === true ? `${r.ruleName}, which failed while it judged this run` : `${r.ruleName}, which gates here`;
}

/** The results the third layer names, in the order they stand in the evaluation. */
function unansweredRows(rows: readonly EvalRuleResult[], cfg: ComposeConfig): EvalRuleResult[] {
  return rows.filter((r) => couldNotAnswer(r) && hadToAnswer(r, cfg));
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
 *
 * Pass the whole evaluation. `provenance` carries the evidence record (what
 * the call carried, and the capture source's declaration), and a result
 * without one is read as a row stored before that record existed: required
 * evidence met by what an evaluated rule read, and no capture source, so a
 * hole in a declared record is not seen.
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
   *
   * A check that could not answer counts here where its answer would have
   * counted: which rows those are is hadToAnswer, above.
   */
  const fromRules3 = (cfg.rules ?? COMPOSER_RULES) >= 3;
  const unknown = unansweredRows(rows, cfg);
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
  // The classes a weighed rule fired in: what an estimate that no class carries alone can be put down to. Weighed as the estimate weighs (risk.ts, detectorsOf): a fire with no published accuracy behind it, a plugin's, moved nothing and is named for nothing.
  // From rules 3. A row stored under the earlier rules named a class only when it was more likely than not by itself, and reads back naming what it named: with no class to fall back on, carriedBy says exactly that.
  const firedIn = new Set<string>(
    fromRules3
      ? detectorsOf(result as EvalResult)
          .filter((d) => d.fired)
          .flatMap((d) => d.classes)
      : [],
  );
  path.push({ node: 'risk', by: risk !== null && risk.pBad > t ? carriedBy(risk.perClass, firedIn) : [], decided: risk !== null && risk.pBad > t, risk });
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

/**
 * The failure classes that carried a risk estimate: each one that is more
 * likely than not by itself. When none is, a fire may still have carried
 * it: a lone fire worth 0.49 beside four classes that found nothing is a
 * risk of 0.53 (an unfilled template, at the shipped settings), and the
 * verdict failed naming no class at all. Named then
 * is the class with the highest estimate among those a weighed rule fired
 * in (`firedIn`). With no weighed fire nobody is named: under a loss ratio
 * strict enough, the risk of an output nothing flagged is over the line by
 * itself.
 */
export function carriedBy(perClass: Readonly<Record<string, number | null | undefined>>, firedIn: ReadonlySet<string>): string[] {
  const estimates = Object.entries(perClass).filter((entry): entry is [string, number] => typeof entry[1] === 'number');
  const overHalf = estimates.filter(([, q]) => q > 0.5).map(([cls]) => cls);
  if (overHalf.length > 0) return overHalf;
  const fired = estimates.filter(([cls]) => firedIn.has(cls));
  const most = fired.reduce((max, [, q]) => Math.max(max, q), 0);
  return most === 0 ? [] : fired.filter(([, q]) => q === most).map(([cls]) => cls);
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

/** One later layer, as a clause. `beyondCritical`: the third layer names a rule that is not critical, which it can from composer rules 3. */
function layerText(l: VerdictLayer, beyondCritical: boolean): string {
  const by = l.by.join(', ');
  switch (l.basis) {
    case 'detector_veto':
      return `a critical rule fired (${by})`;
    case 'critical_unknown':
      // Of critical rules alone the clause is the one it always was, which is also what a verdict given under the earlier rules was told. Where the layer names another rule (asked for, a gate here, or weighed and thrown), the clause is the one true of each.
      return beyondCritical ? `a check whose answer would have counted could not answer (${by})` : `a critical check was asked and could not answer (${by})`;
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
 * node. As with verdictPath(), a result without `provenance` is read as a
 * row stored before the evidence record existed.
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
  // Every detection and inference that ran enters the risk estimate, a critical one included: a veto is also read as a probability. One set to report only does not.
  const isRisk = (r: EvalRuleResult): boolean => !r.skipped && r.advisory !== true && (r.kind === 'detection' || r.kind === 'inference');
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
  /*
   * The rows the third layer named, from the layer's own list (hadToAnswer)
   * and never by looking a name up among the rows: two rules can carry one
   * name (a custom rule may be called `cost_under_threshold`), and found by
   * name a critical custom rule was told by the built-in's row, which skipped
   * beside it.
   */
  const couldNot = unansweredRows(result.rule_results, cfg);
  const beyondCritical = couldNot.some((r) => !isCritical(r));
  const said = (verdict.also ?? []).filter((l) => !(l.basis === 'risk_over_loss' && vetoed)).map((l) => layerText(l, beyondCritical));
  // Nothing judged is not a layer anything could clear; the evidence beside it has its own sentence below.
  if (said.length > 0 && verdict.basis !== 'no_rules') {
    out.push({
      severity: 'block',
      addressee: 'agent',
      text: `${verdict.basis} decided this verdict, and it is not the only layer that would have: ${said.join('; ')}. Clearing ${verdict.by.join(', ') || 'the first'} alone does not clear the verdict.`,
    });
  }
  /** The rules the risk estimate read on this evaluation, found when the first fire on a passing verdict asks. */
  let weighedRows: Set<string> | undefined;
  for (const r of result.rule_results) {
    if (!fired(r)) continue;
    if (verdict.by.includes(r.ruleName) || laterRules.has(r.ruleName)) continue;
    if (r.advisory === true && r.advisoryWhy !== undefined) {
      /*
       * A result the rule itself reported below the standing its error
       * rates were measured at. No setting did this, so none is named: the
       * rule's own reason is the sentence.
       */
      out.push({
        severity: 'note',
        addressee: 'operator',
        rule: r.ruleName,
        text: `${r.ruleName} failed and took no part in this verdict: ${r.advisoryWhy}. It reports what it found and neither vetoes nor enters the risk estimate.`,
      });
      continue;
    }
    if (r.advisory === true) {
      /*
       * A rule the deployment set to report only. Said whatever the verdict
       * is: a reader who sees a detector fail beside a pass, or beside a
       * failure that names other rules, has to be told the detector was
       * left out on purpose, and by which setting.
       */
      out.push({
        severity: 'note',
        addressee: 'operator',
        rule: r.ruleName,
        text: `${r.ruleName} failed and took no part in this verdict: this deployment names it in eval.advisoryRules, so it reports and neither vetoes nor enters the risk estimate. Take it off that list to have its fires weighed again.`,
        configKey: 'eval.advisoryRules',
      });
      continue;
    }
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
      /*
       * A fire the risk estimate does not read took no part in the verdict,
       * and is told that and what would make it decide. It used to be told
       * that "on its published accuracy this rule alone does not carry the
       * risk" and to raise eval.falsePassCost: a measurement has no such
       * accuracy and is in no estimate, so the reason was not the reason
       * and the setting moved nothing (#988). The same sentence went to a
       * plugin's detection, which has no published family either, and with
       * twenty labels on it to "the precision your labels measured", for a
       * precision nothing weighs.
       */
      weighedRows ??= new Set(detectorsOf(result).map((d) => d.name));
      if (!weighedRows.has(r.ruleName)) {
        const plugin = r.origin === 'plugin';
        out.push({
          severity: 'note',
          addressee: 'operator',
          rule: r.ruleName,
          text: plugin
            ? `${r.ruleName} failed and took no part in this verdict: the risk estimate weighs a rule by a published accuracy, and a plugin's rule has none. Its failure is reported and scored. Declare the rule critical in the plugin to have its failure fail the verdict.`
            : r.kind === 'measurement'
              ? `${r.ruleName} failed and took no part in this verdict: it is a measurement, which reports a number and decides no verdict. Name it in eval.criticalRules to have its failure fail the verdict.`
              : `${r.ruleName} failed and took no part in this verdict: the risk estimate reads a detection or an inference that has a published accuracy, and this rule is not one. Its failure is reported and scored.`,
          ...(!plugin && r.kind === 'measurement' ? { configKey: 'eval.criticalRules' } : {}),
        });
        continue;
      }
      /*
       * A fire weighed by the deployment's own labels is told so. On its
       * published accuracy the same fire can carry the verdict: it passed
       * here because the labels call the rule wrong on this traffic, and a
       * sentence that named the published number would send the reader to
       * the one setting that did not decide it.
       */
      const u = r.uncertainty;
      const weighedBy =
        u !== undefined && u.basis === 'local_labels'
          ? `at the precision your ${u.n} labels on its fires measured (${Math.round(u.precision.point * u.n)} right)`
          : 'on its published accuracy';
      out.push({
        severity: 'note',
        addressee: 'operator',
        rule: r.ruleName,
        text: `${r.ruleName} failed but the verdict passed: ${weighedBy} this rule alone does not carry the risk past your loss threshold. Raise eval.falsePassCost to block on weaker evidence (the loss threshold is 1 / (1 + falsePassCost)).`,
        configKey: 'eval.falsePassCost',
      });
    }
  }
  /*
   * A verdict the risk layer failed names failure classes, and said nothing
   * about what a deployment can do when the rules behind them are wrong
   * about its own traffic. Two things can be done: label the fires (at
   * LOCAL_LABEL_MIN labels on a rule's fires the estimate reads the
   * precision the deployment measured), or name the rule in
   * eval.advisoryRules and have it report only. Said once, to the operator,
   * naming the weighed rules that fired. A veto is not weighed, so a
   * verdict a critical rule decided gets no such sentence.
   *
   * The sentence says everything labels do, and that is one thing: the
   * labelled rule's fires are weighed by the precision the labels show.
   * No other rule's fire, and no rule's silence, is weighed differently
   * for them (engine.effectivePrior says why), so a reader invited to
   * label one rule is told how far the labels reach.
   *
   * A verdict stamped with a prior estimated from labels was given by
   * 0.14.0 through 0.21.0, where labels did reach every rule, through that
   * prior. It reads back as it was given, so it is not told that nothing
   * else read the labels: it gets the note after this one, which says how
   * it was weighed and how to have it weighed as verdicts are now.
   */
  const weighedAtLabelsPrior = result.provenance?.composer?.priorSource === 'estimated';
  if (verdict.basis === 'risk_over_loss') {
    /*
     * The rows the estimate weighed and that fired, asked of each ROW by the
     * estimate's own predicate (risk.ts, weighedByTheEstimate): a plugin's
     * detection has no published accuracy, and the estimate does not rest on
     * it. Asked by NAME, a custom rule that carries a weighed rule's name
     * would be named beside it, though it is a policy the estimate does not
     * read, and though it may have passed.
     *
     * From rules 3. A verdict given under the earlier rules was told every
     * detection and inference that fired, weighed or not, and is told the
     * same on a later read.
     */
    const named = (r: EvalRuleResult): boolean =>
      (cfg.rules ?? COMPOSER_RULES) >= 3 ? fired(r) && weighedByTheEstimate(r) : fired(r) && r.advisory !== true && (r.kind === 'detection' || r.kind === 'inference');
    const weighedFires = result.rule_results.filter((r) => named(r) && !isCritical(r)).map((r) => r.ruleName);
    if (weighedFires.length > 0) {
      out.push({
        severity: 'note',
        addressee: 'operator',
        text: `The risk estimate that failed this verdict rests on ${weighedFires.join(', ')}. If ${weighedFires.length === 1 ? 'its fires are' : 'their fires are'} not failures on your traffic, label them, or name the rule in eval.advisoryRules to have it report and take no part in the verdict. From ${LOCAL_LABEL_MIN} labels on a rule's fires, that rule's fires are weighed by the precision you measured.${weighedAtLabelsPrior ? '' : " Nothing else in a verdict reads your labels: every other rule's fire, and that rule's silence, are weighed as before."}`,
        configKey: 'eval.advisoryRules',
      });
    }
  }
  if (weighedAtLabelsPrior) {
    out.push({
      severity: 'note',
      addressee: 'operator',
      text: `This verdict was weighed at a prior of ${Math.round(cfg.prior * 1e4) / 1e4} that an earlier version estimated from your labels and applied to every rule. A verdict given now starts from your eval.prior or the default, and labels change what the labelled rule's own fires are worth and nothing else, so this one can read differently today. Re-evaluating it weighs it that way.`,
    });
  }
  const unanswered = verdict.basis === 'critical_unknown' ? verdict : (verdict.also ?? []).find((l) => l.basis === 'critical_unknown');
  // Whether the layer was composed from these rows (couldNot, in order); a verdict handed in with a layer these rows do not make is known only by its names.
  const layerFromRows = unanswered !== undefined && couldNot.length === unanswered.by.length && couldNot.every((r, i) => r.ruleName === unanswered.by[i]);
  if (unanswered !== undefined) {
    /*
     * A rule that is not critical is here because somebody asked for it
     * (stamp.ts, askedOf), because it threw where its finding is weighed, or
     * because it gates here and could not answer: the sentence says which,
     * of the row the layer named. A verdict handed in with a layer these
     * rows do not make (it was not composed from them) is told by its names.
     */
    const fromRows = layerFromRows;
    const tells = fromRows ? couldNot.map(whyItHadTo) : unanswered.by;
    // Of critical rules alone the sentence is the one it always was, which is also what a verdict given under the earlier rules was told.
    const allCritical = !fromRows || !beyondCritical;
    const could = allCritical ? 'A critical check was asked and could not answer' : 'A check that had to answer could not';
    const names = tells.join(allCritical ? ', ' : '; ');
    /*
     * Three endings. The verdict is unknown; or it failed on other grounds
     * and this is beside it; or, from composer rules 3, the deployment set
     * eval.onCriticalSkipped to "fail" and the verdict failed for this. That
     * last one was told "this verdict is unknown rather than clean", of a
     * verdict whose state is `fail`; a verdict given under the earlier rules
     * keeps the sentence it was given.
     */
    const failedForThis = verdict.basis === 'critical_unknown' && verdict.state === 'fail' && (cfg.rules ?? COMPOSER_RULES) >= 3;
    out.push({
      severity: 'block',
      addressee: 'operator',
      text: failedForThis
        ? `${could} (${names}), and this deployment treats that as a failure: eval.onCriticalSkipped is "fail". Set it to "unknown" to have such a verdict read as not checked, or to "pass" to accept that risk.`
        : verdict.basis === 'critical_unknown'
          ? `${could} (${names}), so this verdict is unknown rather than clean. Set eval.onCriticalSkipped to "pass" to accept that risk, or to "fail" to treat it as a failure.`
          : `${could} (${names}). The verdict failed on other grounds; that check is still not answered. Set eval.onCriticalSkipped to "pass" to accept that risk.`,
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
   * must-not-ship check never ran. From composer rules 3 it is said of each
   * such rule the third layer did not name, beside the layer's own
   * sentence: a critical rule with nothing to judge was told nothing when
   * the layer named another check.
   */
  const rulesNow = (cfg.rules ?? COMPOSER_RULES) >= 3;
  // The layer's own rows where it was composed from these rows, never a name looked up among them: a critical rule beside a check of its name is still told.
  const namedByLayer = (r: EvalRuleResult): boolean => unanswered !== undefined && (layerFromRows ? couldNot.includes(r) : unanswered.by.includes(r.ruleName));
  const skippedCritical = result.rule_results.filter((r) => isCritical(r) && r.skipped === true && !namedByLayer(r)).map((r) => r.ruleName);
  if (skippedCritical.length > 0 && (unanswered === undefined || rulesNow)) {
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
  /*
   * Under `onCriticalSkipped: "pass"` the deployment accepts a check that
   * could not answer, and the layer decides nothing. A critical one is told
   * by the sentence above; one that had to answer for another reason (it
   * gates here, somebody asked for it, or it failed while it judged) was
   * named only by its row and the path. From composer rules 3 it is told in
   * words as well.
   */
  const accepted = rulesNow && cfg.onCriticalSkipped === 'pass' ? couldNot.filter((r) => !isCritical(r)) : [];
  if (accepted.length > 0) {
    out.push({
      severity: 'warn',
      addressee: 'operator',
      text: `A check that had to answer could not (${accepted.map(whyItHadTo).join('; ')}), and this deployment accepts that: eval.onCriticalSkipped is "pass". The verdict above says nothing about what ${accepted.length === 1 ? 'it checks' : 'they check'}.`,
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
  /*
   * An argument that asked for more than the operator allows: fetching,
   * domains or spend (src/tools/operator-ceilings.ts). The call went on
   * under the operator's setting and the agent was told in its reply. The
   * operator is told here, because an agent's arguments can be steered by
   * text it read, and a steered agent need not pass the warning on.
   */
  for (const n of result.provenance?.narrowed ?? []) {
    out.push({ severity: 'warn', addressee: 'operator', text: `The calling agent asked for more than you allow. ${n.message}`, configKey: n.setting });
  }
  return out;
}
