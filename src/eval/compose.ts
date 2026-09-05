/*
 * The verdict, composed by kind.
 *
 * Until 0.10.0 `passed` was a weighted mean of every rule's score against
 * one threshold, with a veto for the critical rules. Arc zero measured what
 * that costs: no single non-critical rule, and no pair of them, could move
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
 *                  fail-open seam arc zero found, and closing it is why the
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
 * that the AI council closed on with its failure mode stated, not a ruling.
 * The record is strategy/product/iris-arc2-measure-the-verdict-2026-09-05/
 * COUNCIL-REPORT.md; each surface that shows a default says it is a
 * recommendation until it is ruled.
 */
import type { EvalResult, EvalRuleResult, Interpretation, Need, Verdict } from '../types/eval.js';
import { riskEstimate, DEFAULT_PRIOR, DEFAULT_PRIOR_MODE, DEFAULT_FALSE_PASS_COST, type PriorMode } from './risk.js';

export interface ComposeConfig {
  /** `risk` composes by kind; `legacy` runs the pre-0.10.0 arithmetic. */
  composer: 'risk' | 'legacy';
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

const isCritical = (r: EvalRuleResult): boolean => r.critical === true;
const fired = (r: EvalRuleResult): boolean => !r.skipped && r.passed === false;

/**
 * Whether a policy rule DECIDES the verdict here, or only advises.
 *
 * "A default is not your policy." A shipped threshold — a cost ceiling of
 * $0.50, a length floor of 50 characters — is our guess about a deployment
 * we have never seen, and stopping someone's build on it is presumptuous.
 * A threshold the deployment SET is their decision and gates.
 *
 * The distinction is not a list of rule names. For a BUILT-IN policy it is
 * whether the number the rule compared against is one we chose, which every
 * result already records as `thresholdSource` on its count evidence (0.9.0);
 * a policy with no number at all — "the output is empty" — is structural,
 * has no guess in it, and gates.
 *
 * A CUSTOM rule is different: its severity is the deployment's own statement
 * of how much it matters, made when the rule was deployed. High and critical
 * gate (they resolve to critical); medium and low advise, which is the
 * contract `deploy_rule` has always had. An inline rule passed in the call
 * carries no severity and advises, for the same reason.
 */
export function decides(r: EvalRuleResult, defaultsGate: boolean): boolean {
  if (isCritical(r)) return true;
  if (defaultsGate) return true;
  if (r.origin === 'custom') return false;
  const ourDefault = (r.evidence ?? []).some(
    (e) => e.type === 'count' && e.threshold !== undefined && (e.thresholdSource ?? 'default') === 'default',
  );
  return !ourDefault;
}

/** The inputs at least one evaluated rule actually read. */
function inputsSeen(rows: readonly EvalRuleResult[]): Set<Need> {
  const seen = new Set<Need>();
  for (const r of rows) if (!r.skipped) for (const n of r.saw ?? []) seen.add(n);
  return seen;
}

/**
 * The verdict for one evaluation. The weighted mean is never consulted: it
 * survives as a quality gradient on the score field and is never re-meant.
 */
export function compose(
  result: Pick<EvalResult, 'rule_results' | 'score' | 'insufficient_data' | 'rules_evaluated'>,
  cfg: ComposeConfig,
): Verdict {
  const rows = result.rule_results;
  const evaluated = result.rules_evaluated ?? rows.filter((r) => !r.skipped).length;
  if (result.insufficient_data || evaluated === 0) {
    return { state: 'unknown', passed: false, basis: 'no_rules', by: [], risk: null };
  }

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
  if (gates.length > 0) {
    return { state: 'fail', passed: false, basis: 'policy_gate', by: gates.map((r) => r.ruleName), risk: null };
  }

  /*
   * 2. Vetoes: an effectively-critical rule that is not a policy. Keyed on
   * "not a policy" rather than on the two detecting kinds, so a rule built
   * by hand without metadata — a test double, an embedder's own rule —
   * still vetoes when it is marked critical. Silently ignoring a critical
   * rule because it forgot to declare its kind is the failure mode this
   * composer exists to remove, not one to introduce.
   */
  const vetoes = rows.filter((r) => r.kind !== 'policy' && fired(r) && isCritical(r));
  if (vetoes.length > 0) {
    return { state: 'fail', passed: false, basis: 'detector_veto', by: vetoes.map((r) => r.ruleName), risk: null };
  }

  /*
   * 3. Asked and could not answer. `not_applicable` is NEVER this: a
   * trajectory rule with no tool calls was not asked, and treating that as
   * unknown would make every text-only evaluation unknown, which is worse
   * than the fail-open it replaces.
   */
  const unknown = rows.filter((r) => isCritical(r) && r.skipped === true && r.skipClass !== undefined && r.skipClass !== 'not_applicable');
  if (unknown.length > 0 && cfg.onCriticalSkipped !== 'pass') {
    const by = unknown.map((r) => r.ruleName);
    return cfg.onCriticalSkipped === 'fail'
      ? { state: 'fail', passed: false, basis: 'critical_unknown', by, risk: null }
      : { state: 'unknown', passed: false, basis: 'critical_unknown', by, risk: null };
  }

  // 4. Evidence the deployment insists on.
  if (cfg.requiredEvidence.length > 0) {
    const seen = inputsSeen(rows);
    const missing = cfg.requiredEvidence.filter((n) => !seen.has(n));
    if (missing.length > 0) {
      return { state: 'unknown', passed: false, basis: 'required_evidence_missing', by: [...missing], risk: null };
    }
  }

  // 5. Everything that carries a published error rate, as one probability.
  const risk = riskEstimate(result as EvalResult, cfg.prior, cfg.priorMode);
  if (risk === null) {
    return { state: 'pass', passed: true, basis: 'clean', by: [], risk: null };
  }
  const t = tau(cfg.falsePassCost);
  const confidence: Verdict['confidence'] = risk.lo <= t && t <= risk.hi ? 'marginal' : 'decisive';
  if (risk.pBad > t) {
    const by = Object.entries(risk.perClass)
      .filter(([, q]) => q !== null && q !== undefined && q > 0.5)
      .map(([cls]) => cls);
    return { state: 'fail', passed: false, basis: 'risk_over_loss', by, risk, confidence };
  }
  return { state: 'pass', passed: true, basis: 'clean', by: [], risk, confidence };
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
export function interpretations(result: Pick<EvalResult, 'rule_results'>, verdict: Verdict, cfg: ComposeConfig): Interpretation[] {
  const out: Interpretation[] = [];
  for (const r of result.rule_results) {
    if (!fired(r)) continue;
    if (verdict.by.includes(r.ruleName)) continue;
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
        text: `${r.ruleName} failed but the verdict passed: on its published accuracy this rule alone does not carry the risk past your loss threshold. Lower eval.falsePassCost to block on weaker evidence.`,
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
  if (verdict.confidence === 'marginal') {
    out.push({
      severity: 'note',
      addressee: 'operator',
      text: 'The credible interval on this risk estimate straddles your threshold, so this verdict could go either way on the evidence available. Treat it as a close call rather than a clear one.',
    });
  }
  return out;
}
