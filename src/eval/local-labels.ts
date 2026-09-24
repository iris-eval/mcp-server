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

export interface LocalLabelSource {
  /** Per rule, the local precision from the deployment's labels — every rule with at least one label. */
  precision: Map<string, LocalPrecision>;
  /** Per rule, the fraction of the newest LOCAL_LABEL_WINDOW evaluations it fired on, over those it ran on. */
  fireRates: Map<string, number>;
  /** The prior the labels imply, when a detection or inference has reached LOCAL_LABEL_MIN and fires; null otherwise. */
  estimatedPrior: EstimatedPrior | null;
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

export async function buildLocalLabelSource(storage: IStorageAdapter, tenantId: TenantId): Promise<LocalLabelSource> {
  const [tallies, fires] = await Promise.all([storage.labelTallies(tenantId), storage.ruleFireStats(tenantId, LOCAL_LABEL_WINDOW)]);
  const precision = new Map(tallies.map((t) => [t.ruleName, localPrecision(t)] as const));
  const fireRates = new Map(fires.map((f) => [f.ruleName, f.judged > 0 ? f.fired / f.judged : 0] as const));

  /*
   * The prior estimate reads only the kinds that enter the risk: a
   * measurement's published "sensitivity" is conformance to a formula, and
   * a prior derived from it would say how often outputs are short, not how
   * often they are bad. Over the rules that qualify, the largest estimate
   * wins — π is the prior that ANY class is present, and each rule sees
   * only its own.
   */
  let estimate: EstimatedPrior | null = null;
  for (const p of precision.values()) {
    const kind = builtInKindOf(p.ruleName);
    if (kind === undefined || !RISK_KINDS.has(kind)) continue;
    const published = publishedAccuracyFor(p.ruleName);
    const sens = published ? sensitivity(published) : null;
    const e = estimatedPrior(p, fireRates.get(p.ruleName) ?? 0, sens ?? 0);
    if (e !== null && (estimate === null || e.pi > estimate.pi)) estimate = e;
  }

  /*
   * The suggestion, likewise, names only a rule whose labels can move a
   * verdict: a label on a measurement's fire informs the table and nothing
   * else, and asking a reader for it first would spend their attention on
   * a number no decision reads.
   */
  const candidates = [...fireRates.entries()]
    .filter(([ruleName, f]) => f > 0 && RISK_KINDS.has(builtInKindOf(ruleName) ?? ''))
    .map(([ruleName, fireRate]) => ({ precision: precision.get(ruleName) ?? localPrecision({ ruleName, right: 0, wrong: 0 }), fireRate }));

  return { precision, fireRates, estimatedPrior: estimate, suggestion: samplingSuggestion(candidates), refreshedAt: new Date().toISOString() };
}

/** Rebuild the source from storage and install it on the engine every evaluation goes through. */
export async function refreshLocalLabels(engine: EvalEngine, storage: IStorageAdapter, tenantId: TenantId): Promise<LocalLabelSource> {
  const source = await buildLocalLabelSource(storage, tenantId);
  engine.setLocalLabels(source);
  return source;
}
