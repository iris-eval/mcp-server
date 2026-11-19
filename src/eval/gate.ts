/*
 * The one gating predicate. It used to live inside compose.ts,
 * and the harness composer in risk.ts — the one the composite corpus
 * measures — carried its own, narrower reading: a policy gated only when it
 * was critical. So no_stub_output blocked an unfilled template in the
 * product and read as a "missed block" on the proof page. Both composers
 * now ask this module.
 */
import type { EvalRuleResult } from '../types/eval.js';

export const isCritical = (r: EvalRuleResult): boolean => r.critical === true;

/** A result that gave no answer though there was something to judge: the rule threw, was stopped at a limit, read cut evidence, could not judge what it was sent, or its definition is broken. */
export const couldNotAnswer = (r: EvalRuleResult): boolean => r.skipped === true && r.skipClass !== undefined && r.skipClass !== 'not_applicable';

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
 * takes the same `severity` field (2026-09-23): high or critical gates, and
 * without one it advises, for the same reason.
 *
 * A result that COULD NOT ANSWER carries no evidence, so nothing in its
 * answer says whose number the rule stood at. Read by the evidence alone, a
 * policy at a shipped threshold that threw was a gate, where the same rule
 * answering advises: its row read `role: "gate"` beside `advisory` on every
 * answered one. So the engine writes the same fact on such a row, from the
 * rule in hand (`thresholdSource`, stamp.ts), and this reads it there: the
 * rule gates when somebody set its number, or asked for it some other way
 * (`asked`). The fact is the row's own. Nothing here looks a rule up, so a
 * rule object that carries a built-in policy's name is read by what it
 * declares, and a stored row by what was written when it was judged.
 */
export function decides(r: EvalRuleResult, defaultsGate: boolean): boolean {
  if (isCritical(r)) return true;
  if (defaultsGate) return true;
  if (r.origin === 'custom') return false;
  if (couldNotAnswer(r) && r.thresholdSource !== undefined) return r.thresholdSource !== 'default' || r.asked !== undefined;
  const ourDefault = (r.evidence ?? []).some(
    (e) => e.type === 'count' && e.threshold !== undefined && (e.thresholdSource ?? 'default') === 'default',
  );
  return !ourDefault;
}
