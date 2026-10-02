/*
 * What one server process holds that another can change, and how it stays
 * current.
 *
 * `install` gives every MCP client its own server process, and they share
 * one data folder: the database, the deployed-rules file, the audit log.
 * The database is shared by construction. Two things were not: each process
 * read the deployed rules and the labels once, at start, and evaluated
 * under that copy for as long as it ran. A rule deployed through one client
 * was not applied by the others, their verdicts carried different ruleset
 * hashes for the same moment, and a label written in one process moved the
 * risk estimate in that process alone.
 *
 * Both are now checked before an evaluation: one `stat` of the rules file,
 * and one read of the database's change counter. Nothing is re-read unless
 * one of them moved.
 *
 * The server checks at most once every CHECK_EVERY_MS. The two checks cost
 * about 50 µs together on Windows (a `stat` there is 30 µs), against an
 * evaluation of about 450 µs, so checking on every one of a burst of
 * evaluations slowed a batch by a tenth. Evaluations further apart than the
 * interval, which is every call an agent or a person makes one at a time,
 * are each checked; inside a burst, a change another process made is read
 * within the interval.
 */
import type { CustomRuleStore } from '../custom-rule-store.js';
import type { IStorageAdapter } from '../types/query.js';
import type { TenantId } from '../types/tenant.js';
import type { EvalEngine } from './engine.js';
import { refreshLocalLabels } from './local-labels.js';
import { createCustomRule, ruleContentHash } from './rules/custom.js';

/** How often, at most, the server looks for another process's changes. */
export const CHECK_EVERY_MS = 20;

/** `check`, skipped when it last ran less than `everyMs` ago. With 0 it runs every time. */
function atMostEvery<T extends void | Promise<void>>(everyMs: number, check: () => T, skipped: T): () => T {
  if (!(everyMs > 0)) return check;
  let last = -Infinity;
  return () => {
    const now = performance.now();
    if (now - last < everyMs) return skipped;
    last = now;
    return check();
  };
}

/**
 * The function that makes the engine's registrations match the store's
 * enabled rules. Call it once at start (it registers everything), and give
 * it to the engine (`setSharedState`) so every evaluation calls it.
 *
 * It removes only what the store listed the last time it ran and no longer
 * does, so a plugin rule or anything else registered under an id the store
 * never held is left alone. A rule whose content changed under the same id
 * (a hand-edited file) is registered again.
 */
export function deployedRulesInStep(engine: EvalEngine, store: CustomRuleStore, tenantId: TenantId): () => void {
  let seen: number | null = null;
  let live = new Set<string>();
  return () => {
    const revision = store.revision(tenantId);
    if (revision === seen) return;
    const enabled = store.enabledRules(tenantId);
    const now = new Set(enabled.map((r) => r.id));
    for (const id of live) if (!now.has(id)) engine.unregisterRule(id);
    for (const rule of enabled) {
      const registered = engine.registeredAs(rule.id);
      if (registered?.evalType === rule.evalType && registered.contentHash === ruleContentHash(rule.definition, rule.severity)) continue;
      // Severity rides along: high and critical deployed rules fail the evaluations they lose.
      engine.registerRule(rule.evalType, createCustomRule(rule.definition, rule.severity), rule.id);
    }
    live = now;
    seen = revision;
  };
}

/**
 * The function that re-reads the labels when another process wrote one.
 * The store answers `labelsStamp` from the database's change counter, so an
 * evaluation with nothing new costs one counter read.
 */
export function labelsInStep(engine: EvalEngine, storage: IStorageAdapter, tenantId: TenantId): () => Promise<void> {
  let seen: string | null = null;
  return async () => {
    const stamp = await storage.labelsStamp(tenantId);
    // The first call reads once more: a label may have been written since the read at start.
    if (stamp === seen) return;
    seen = stamp;
    await refreshLocalLabels(engine, storage, tenantId);
  };
}

/**
 * Install both on the engine, each checked at most once every `everyMs`.
 * Returns the unthrottled rules function, which the caller runs once to
 * register what is deployed now.
 */
export function keepInStep(engine: EvalEngine, store: CustomRuleStore, storage: IStorageAdapter, tenantId: TenantId, everyMs: number = CHECK_EVERY_MS): () => void {
  const rules = deployedRulesInStep(engine, store, tenantId);
  const labels = labelsInStep(engine, storage, tenantId);
  engine.setSharedState({ rules: atMostEvery(everyMs, rules, undefined), labels: atMostEvery(everyMs, labels, Promise.resolve()) });
  return rules;
}
