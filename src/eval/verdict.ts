/*
 * The verdict, the coverage and the provenance — computed once, derived on
 * read, never fabricated.
 *
 * An audit on 2026-09-05 found the same fact encoded three ways
 * (`insufficient_data`, `critical_skipped`, `rule_results[].budgetExceeded`),
 * the verdict's basis nowhere (a reader could not tell a veto from a low
 * score without knowing the rule library), coverage counted in rules rather
 * than evaluation questions, and no stored evaluation carrying the version,
 * ruleset or thresholds that produced it — "why did this pass on that day"
 * was unanswerable from Iris alone.
 *
 * This module answers those from what the engine already knows: coverage,
 * provenance, and the hashes that let one verdict be compared with another.
 *
 * The verdict itself is composed in compose.ts. `deriveVerdict` used to
 * live here — the pre-0.10.0 weighted-mean arithmetic, kept for the two
 * minors 0.10.0 promised — and went in 0.12.0 with the composer that
 * selected it. Its one exclusive basis, `score_below_threshold`, went with
 * it rather than staying in the union as a value nothing can produce.
 */
import { createHash } from 'node:crypto';
import type { Coverage, EvalRule, EvalRuleResult, Need, Provenance } from '../types/eval.js';
import type { EffectiveCriticality } from './criticality.js';
import { RULE_QUESTION_IDS } from './questions.js';
import { NEEDS } from './failure-classes.js';
import { publishedProvenance } from './accuracy.js';

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
    const evaluated = rows.filter((r) => !r.skipped).length;
    if (evaluated > 0) {
      // "judged" used to mean "at least one rule ran". With the counts a
      // reader can see 1 of 3, and the sentence names what the others lacked.
      const lacking = [...new Set(rows.filter((r) => r.skipped).map((r) => r.skipReason ?? r.skipClass ?? 'skipped'))];
      questions.push({
        id,
        status: 'judged',
        evaluated,
        of: rows.length,
        ...(evaluated < rows.length ? { why: `partial: ${rows.length - evaluated} of ${rows.length} rules skipped (${lacking.join('; ')})` } : {}),
      });
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

/**
 * sha256 over the rules that ran — name, definition version, kind, effective
 * criticality, weight, and for a rule the deployment supplied the hash of
 * its content — so two evaluations under the same ruleset hash the same,
 * and two under different rules do not.
 *
 * The content hash is appended only where a rule carries one (a deployed or
 * inline rule, a plugin): a ruleset of built-in rules hashes exactly as it
 * did. Without it the hash named a custom rule by its name alone, and a rule
 * replaced by one that checks nothing kept the fingerprint of the rule it
 * replaced.
 */
export function rulesetHash(rules: readonly EvalRule[], resolve: (rule: EvalRule) => EffectiveCriticality, judge?: string): string {
  const rows = rules
    .map((r) => [r.name, r.version ?? 0, r.kind ?? '', resolve(r).critical ? 1 : 0, r.weight, ...(r.contentHash !== undefined ? [r.contentHash] : [])] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  /*
   * A relevance judge changes what answers_the_ask decides (#649), so a
   * ruleset with one is a different ruleset. Appended only when present:
   * every hash computed without a judge stays exactly what it was.
   */
  const payload = judge === undefined ? rows : [...rows, ['judge', judge]];
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

/** The composer settings that decide a verdict, as the configuration hash reads them. */
export interface ComposerSettings {
  defaultsGate: boolean;
  falsePassCost: number;
  onCriticalSkipped: string;
  requiredEvidence: readonly string[];
  prior: number;
  priorSource: string;
  priorMode: string;
}

/** What the composer does when a deployment sets nothing (compose.ts, DEFAULT_COMPOSE; risk.ts). Restated here so this module imports neither. */
const SHIPPED_COMPOSER: ComposerSettings = {
  defaultsGate: false,
  falsePassCost: 1,
  onCriticalSkipped: 'unknown',
  requiredEvidence: [],
  prior: 0.5,
  priorSource: 'default',
  priorMode: 'per-output',
};

/** The composer settings that differ from the shipped ones, keys in a fixed order; empty at the defaults. */
function composerMoved(c: ComposerSettings): Record<string, unknown> {
  const moved: Record<string, unknown> = {};
  if (c.defaultsGate !== SHIPPED_COMPOSER.defaultsGate) moved.defaultsGate = c.defaultsGate;
  if (c.falsePassCost !== SHIPPED_COMPOSER.falsePassCost) moved.falsePassCost = c.falsePassCost;
  if (c.onCriticalSkipped !== SHIPPED_COMPOSER.onCriticalSkipped) moved.onCriticalSkipped = c.onCriticalSkipped;
  if (c.requiredEvidence.length > 0) moved.requiredEvidence = [...c.requiredEvidence].sort();
  // The prior in force when it is not the shipped one: set in config, or estimated from the deployment's own labels.
  if (c.priorSource !== SHIPPED_COMPOSER.priorSource || c.prior !== SHIPPED_COMPOSER.prior) {
    moved.prior = c.prior;
    moved.priorSource = c.priorSource;
  }
  if (c.priorMode !== SHIPPED_COMPOSER.priorMode) moved.priorMode = c.priorMode;
  return moved;
}

/**
 * sha256 over the evaluation configuration that shapes a verdict.
 *
 * `composer` carries the settings that decide a verdict without touching a
 * rule: whether a shipped threshold gates, the loss ratio, what a critical
 * check that could not answer does, the evidence required, the prior. They
 * were not in the hash, so the same output could pass and fail under one
 * fingerprint, and compare_runs called two runs comparable when the only
 * difference between them was the setting that flipped their verdicts.
 * They are appended only where they differ from the shipped ones: a
 * deployment that set none of them hashes exactly as it did.
 */
export function configHash(config: { threshold: number; ruleThresholds?: Record<string, unknown>; criticalRules?: readonly string[]; nonCriticalRules?: readonly string[]; judge?: string; composer?: ComposerSettings }): string {
  const moved = config.composer ? composerMoved(config.composer) : {};
  const stable = JSON.stringify({
    threshold: config.threshold,
    ruleThresholds: Object.fromEntries(Object.entries(config.ruleThresholds ?? {}).sort(([a], [b]) => (a < b ? -1 : 1))),
    criticalRules: [...(config.criticalRules ?? [])].sort(),
    nonCriticalRules: [...(config.nonCriticalRules ?? [])].sort(),
    // The relevance judge in force, when there is one; absent keeps every judge-less hash as it was.
    ...(config.judge !== undefined ? { judge: config.judge } : {}),
    ...(Object.keys(moved).length > 0 ? { composer: moved } : {}),
  });
  return createHash('sha256').update(stable).digest('hex').slice(0, 16);
}

export function buildProvenance(input: {
  irisVersion: string;
  rulesetHash: string;
  configHash: string;
  threshold: number;
  ruleThresholds?: Record<string, unknown>;
  toolsHash?: string;
  composer?: Provenance['composer'];
  supersedes?: string;
  judgedAt: string;
}): Provenance {
  return {
    irisVersion: input.irisVersion,
    rulesetHash: input.rulesetHash,
    configHash: input.configHash,
    thresholds: { default: input.threshold, ...(input.ruleThresholds ? { perRule: input.ruleThresholds } : {}) },
    ...(input.toolsHash !== undefined ? { toolsHash: input.toolsHash } : {}),
    ...(input.composer !== undefined ? { composer: input.composer } : {}),
    ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
    corpusVersion: publishedProvenance().corpusVersion,
    judgedAt: input.judgedAt,
  };
}
