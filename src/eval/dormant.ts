/*
 * Dormant rules — the ones a deployment meant to run and this version
 * could not load.
 *
 * The custom-rule store quarantines an entry it cannot validate (a rule
 * written by an older or newer Iris, a hand-edit) instead of destroying
 * it: kept on disk, never registered. A quarantined rule of severity
 * `high` or `critical` is a gate the operator believes is standing and is
 * not. `list_rules.quarantined[]` names every entry; this module names the
 * ones that matter to a verdict, so `coverage.dormant` can carry them on
 * every evaluation — a gate reads the verdict, never list_rules.
 */
import type { Coverage } from '../types/eval.js';

export type DormantRule = NonNullable<Coverage['dormant']>[number];

const GATING = new Set(['high', 'critical']);

function field(entry: unknown, key: string): string | undefined {
  if (!entry || typeof entry !== 'object') return undefined;
  const value = (entry as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

/** The quarantined entries that would have gated, as `coverage.dormant` rows. */
export function dormantRulesFrom(quarantined: readonly unknown[]): DormantRule[] {
  const out: DormantRule[] = [];
  for (const entry of quarantined) {
    const severity = field(entry, 'severity');
    if (!severity || !GATING.has(severity)) continue;
    out.push({
      ruleId: field(entry, 'id') ?? 'unknown',
      name: field(entry, 'name') ?? 'unnamed',
      reason: `quarantined: the stored definition failed validation in this version, so this ${severity} rule is not running`,
    });
  }
  return out;
}
