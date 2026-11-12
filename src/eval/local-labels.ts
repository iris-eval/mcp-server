/*
 * The local-label source: what the engine reads from the
 * deployment's own labels, built from storage once at boot and again after
 * every label write. The arithmetic lives in ./labels.ts; this module is
 * the one that knows about storage and the rule registry.
 */
import type { IStorageAdapter } from '../types/query.js';
import type { TenantId } from '../types/tenant.js';
import type { EvalEngine } from './engine.js';
import { publishedAccuracyFor } from './accuracy.js';
import { builtInRules } from './criticality.js';
import { sensitivity } from './stats.js';
import { LOCAL_LABEL_WINDOW, estimatedPrior, localPrecision, samplingSuggestion, type EstimatedPrior, type LocalPrecision, type SamplingSuggestion } from './labels.js';

/** How often the failure one labelled rule looks for is present on this deployment's traffic, as that rule's labels and fire rate imply it. */
export interface RulePrevalence extends EstimatedPrior {
  /** The failure classes the rule declares: the estimate is that one of them is present. */
  classes: readonly string[];
}

export interface LocalLabelSource {
  /** Per rule, the local precision from the deployment's labels — every rule with at least one label. */
  precision: Map<string, LocalPrecision>;
  /** Per rule, the fraction of the newest LOCAL_LABEL_WINDOW evaluations it fired on, over those it ran on. */
  fireRates: Map<string, number>;
  /**
   * What the labels imply about how often a failure is present: one entry
   * for each detection or inference that has reached LOCAL_LABEL_MIN labels
   * and fires, in rule-name order. The labels routes report it. No verdict
   * reads it: what the engine takes from this source is `precision`, for
   * the labelled rule's own fires (engine.ts, effectivePrior).
   */
  prevalence: RulePrevalence[];
  /** Which rule's next label buys the most. */
  suggestion: SamplingSuggestion | null;
  refreshedAt: string;
}

/** The kinds whose fires enter the risk estimate, and so whose labels can move a verdict. */
const RISK_KINDS = new Set(['detection', 'inference']);

/** The declared kind of a built-in rule, or undefined for a custom one. */
export function builtInKindOf(ruleName: string): string | undefined {
  return builtInRules().find((r) => r.name === ruleName)?.kind;
}

/**
 * Whether a rule is of a kind the risk estimate weighs: a built-in
 * detection or inference. Whether a deployment weighs it is the engine's
 * answer (EvalEngine.weighsFiresOf): one it named in eval.advisoryRules
 * reports only, and labels on its fires move no verdict.
 */
export function isWeighedKind(ruleName: string): boolean {
  return RISK_KINDS.has(builtInKindOf(ruleName) ?? '');
}

/** The failure classes a built-in rule declares; none for a custom rule, or one that declares none. */
function builtInClassesOf(ruleName: string): readonly string[] {
  return builtInRules().find((r) => r.name === ruleName)?.classes ?? [];
}

/**
 * `decides` says on whose fires a label can change pass or fail, for the
 * suggestion. An engine gives its own answer (refreshLocalLabels): a rule
 * it weighs and that does not veto. With no engine it is the rule's kind.
 */
export async function buildLocalLabelSource(storage: IStorageAdapter, tenantId: TenantId, decides: (ruleName: string) => boolean = isWeighedKind): Promise<LocalLabelSource> {
  const [tallies, fires] = await Promise.all([storage.labelTallies(tenantId), storage.ruleFireStats(tenantId, LOCAL_LABEL_WINDOW)]);
  const precision = new Map(tallies.map((t) => [t.ruleName, localPrecision(t)] as const));
  const fireRates = new Map(fires.map((f) => [f.ruleName, f.judged > 0 ? f.fired / f.judged : 0] as const));

  /*
   * How often each labelled rule's failure is present, for the kinds the
   * risk estimate weighs: a measurement's published "sensitivity" is
   * conformance to a formula, and an estimate derived from it would say how
   * often outputs are short, not how often they are bad. Each rule speaks
   * for the failure it looks for, so there is one entry a rule and no
   * largest one to pick. The list is for the reader of the labels routes
   * and is the prior of no verdict, so a rule set to report only is in it
   * too: its labelled fires say as much about the traffic as any other's.
   */
  const prevalence: RulePrevalence[] = [];
  for (const p of precision.values()) {
    if (!isWeighedKind(p.ruleName)) continue;
    const published = publishedAccuracyFor(p.ruleName);
    const sens = published ? sensitivity(published) : null;
    const e = estimatedPrior(p, fireRates.get(p.ruleName) ?? 0, sens ?? 0);
    if (e !== null) prevalence.push({ ...e, classes: builtInClassesOf(p.ruleName) });
  }
  prevalence.sort((a, b) => (a.ruleName < b.ruleName ? -1 : a.ruleName > b.ruleName ? 1 : 0));

  /*
   * The suggestion names only a rule whose labels can change pass or fail.
   * A label on the fire of a measurement, or of a rule the deployment set
   * to report only, informs the table and nothing else. A label on the
   * fire of a rule that vetoes cannot undo the veto. Asking a reader for
   * either first would spend their attention on a number no decision reads.
   */
  const candidates = [...fireRates.entries()]
    .filter(([ruleName, f]) => f > 0 && decides(ruleName))
    .map(([ruleName, fireRate]) => ({ precision: precision.get(ruleName) ?? localPrecision({ ruleName, right: 0, wrong: 0 }), fireRate }));

  return { precision, fireRates, prevalence, suggestion: samplingSuggestion(candidates), refreshedAt: new Date().toISOString() };
}

/** Rebuild the source from storage and install it on the engine every evaluation goes through. */
export async function refreshLocalLabels(engine: EvalEngine, storage: IStorageAdapter, tenantId: TenantId): Promise<LocalLabelSource> {
  const source = await buildLocalLabelSource(storage, tenantId, (ruleName) => engine.labelsCanDecide(ruleName));
  engine.setLocalLabels(source);
  return source;
}
