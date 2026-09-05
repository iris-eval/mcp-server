/*
 * The verdict, the coverage and the provenance — computed once, derived on
 * read, never fabricated.
 *
 * Arc zero (2026-09-05) found the same fact encoded three ways
 * (`insufficient_data`, `critical_skipped`, `rule_results[].budgetExceeded`),
 * the verdict's basis nowhere (a reader could not tell a veto from a low
 * score without knowing the rule library), coverage counted in rules rather
 * than evaluation questions, and no stored evaluation carrying the version,
 * ruleset or thresholds that produced it — "why did this pass on that day"
 * was unanswerable from Iris alone.
 *
 * This module answers those from what the engine already knows. It changes
 * no verdict: `deriveVerdict` names the basis of today's arithmetic
 * (`passed` here equals the engine's `passed`, and a test proves it); the
 * compose-by-kind release replaces the arithmetic and keeps the shape.
 */
import { createHash } from 'node:crypto';
import type { Coverage, EvalResult, EvalRule, EvalRuleResult, Need, Provenance, Verdict } from '../types/eval.js';
import type { EffectiveCriticality } from './criticality.js';
import { RULE_QUESTION_IDS } from './questions.js';
import { NEEDS } from './failure-classes.js';
import { publishedProvenance } from './accuracy.js';

/**
 * The basis of the verdict under the shipped composer (a weighted mean plus
 * the critical veto). `passed` is `state === 'pass'` and equals the engine's
 * own `passed` for every result; the basis says which layer decided.
 */
export function deriveVerdict(result: Pick<EvalResult, 'passed' | 'score' | 'rule_results' | 'insufficient_data' | 'critical_failures' | 'rules_evaluated'>, threshold: number): Verdict {
  const evaluated = result.rules_evaluated ?? result.rule_results.filter((r) => !r.skipped).length;
  if (result.insufficient_data || evaluated === 0) {
    return { state: 'unknown', passed: false, basis: 'no_rules', by: [], risk: null };
  }
  const vetoes = result.critical_failures ?? [];
  if (vetoes.length > 0) {
    const kinds = new Map(result.rule_results.map((r) => [r.ruleName, r.kind]));
    const allPolicies = vetoes.every((name) => kinds.get(name) === 'policy');
    return { state: 'fail', passed: false, basis: allPolicies ? 'policy_gate' : 'detector_veto', by: [...vetoes], risk: null };
  }
  if (result.score < threshold) {
    const by = result.rule_results.filter((r) => !r.skipped && !r.passed).map((r) => r.ruleName);
    return { state: 'fail', passed: false, basis: 'score_below_threshold', by, risk: null };
  }
  return { state: 'pass', passed: true, basis: 'clean', by: [], risk: null };
}

/**
 * Which evaluation questions were judged, which were not and why. At write
 * time the engine passes the inputs the call carried; at read time they are
 * reconstructed as the union of what the rules saw (a rule that saw an input
 * proves the call carried it; one that did not cannot prove the reverse).
 */
export function deriveCoverage(ruleResults: readonly EvalRuleResult[], present?: ReadonlySet<Need>): Coverage {
  const inputs = {} as Record<Need, boolean>;
  const seen = new Set<Need>(present ?? []);
  if (!present) for (const r of ruleResults) for (const n of r.saw ?? []) seen.add(n);
  for (const n of NEEDS) inputs[n] = seen.has(n);

  const questions: Coverage['questions'] = [];
  for (const id of RULE_QUESTION_IDS) {
    const rows = ruleResults.filter((r) => r.question === id);
    if (rows.length === 0) {
      questions.push({ id, status: 'not_applicable', why: 'no rule that answers this question ran in the selected bundles' });
      continue;
    }
    if (rows.some((r) => !r.skipped)) {
      questions.push({ id, status: 'judged' });
      continue;
    }
    const defeated = rows.filter((r) => r.skipClass === 'defeated').map((r) => r.ruleName);
    const broken = rows.filter((r) => r.skipClass === 'config_invalid').map((r) => r.ruleName);
    if (defeated.length > 0) {
      questions.push({ id, status: 'unjudged', why: `defeated: ${defeated.join(', ')} could not judge this output (sandbox budget)` });
      continue;
    }
    if (broken.length > 0) {
      questions.push({ id, status: 'unjudged', why: `config_invalid: ${broken.join(', ')} has a broken definition` });
      continue;
    }
    const missing = new Set<string>();
    for (const r of rows) {
      const saw = new Set(r.saw ?? []);
      // The rule's needs are not on the result; what it lacked is what its
      // skip reason names. Prefer the structured form when the stamp gave
      // us `saw`: anything in NEEDS the call did not carry and this rule's
      // family is known to read. Fall back to the skip reason text.
      if (r.skipReason) missing.add(r.skipReason);
      else for (const n of NEEDS) if (!saw.has(n) && !seen.has(n)) missing.add(n);
    }
    questions.push({ id, status: 'unjudged', why: `not supplied: ${[...missing].join('; ')}` });
  }
  return { inputs, questions };
}

/** The critical rules that skipped — derived from the stamped flags on every read, never a column. */
export function deriveCriticalSkipped(ruleResults: readonly EvalRuleResult[]): string[] | undefined {
  if (!ruleResults.some((r) => r.critical !== undefined)) return undefined;
  const names = ruleResults.filter((r) => r.skipped && r.critical).map((r) => r.ruleName);
  return names.length > 0 ? names : undefined;
}

/** sha256 over the rules that ran — name, definition version, kind, effective criticality, weight — so two evaluations under the same ruleset hash the same. */
export function rulesetHash(rules: readonly EvalRule[], resolve: (rule: EvalRule) => EffectiveCriticality): string {
  const rows = rules
    .map((r) => [r.name, r.version ?? 0, r.kind ?? '', resolve(r).critical ? 1 : 0, r.weight] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  return createHash('sha256').update(JSON.stringify(rows)).digest('hex').slice(0, 16);
}

/** sha256 over the evaluation configuration that shapes a verdict. */
export function configHash(config: { threshold: number; ruleThresholds?: Record<string, unknown>; criticalRules?: readonly string[]; nonCriticalRules?: readonly string[] }): string {
  const stable = JSON.stringify({
    threshold: config.threshold,
    ruleThresholds: Object.fromEntries(Object.entries(config.ruleThresholds ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))),
    criticalRules: [...(config.criticalRules ?? [])].sort(),
    nonCriticalRules: [...(config.nonCriticalRules ?? [])].sort(),
  });
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

export function buildProvenance(input: {
  irisVersion: string;
  rulesetHash: string;
  configHash: string;
  threshold: number;
  ruleThresholds?: Record<string, unknown>;
  judgedAt: string;
}): Provenance {
  return {
    irisVersion: input.irisVersion,
    rulesetHash: input.rulesetHash,
    configHash: input.configHash,
    thresholds: { default: input.threshold, ...(input.ruleThresholds ? { perRule: input.ruleThresholds } : {}) },
    corpusVersion: publishedProvenance().corpusVersion,
    judgedAt: input.judgedAt,
  };
}
