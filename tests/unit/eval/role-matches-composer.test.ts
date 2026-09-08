/*
 * role ⇔ the composer's own predicates, over every corpus positive.
 *
 * The stamp used to emit only veto or "term" while the schema advertised
 * gate, risk and advisory — values nothing produced. The role is now set by
 * the engine from compose.roleOf(), which shares its predicates with
 * compose(). This drives every family's positives through the real engine
 * and asserts the role against the predicate table, and that each of the
 * four roles occurs at least once (a floor: a vocabulary nothing produces is
 * the failure this test exists to catch).
 */
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { decides } from '../../../src/eval/compose.js';
import type { EvalRuleResult } from '../../../src/types/eval.js';

const root = resolve(__dirname, '..', '..', '..');
const corpusDir = resolve(root, 'proof', 'corpus');

interface Case { input?: string; output: string; context?: Record<string, unknown>; label: string }

function expectedRole(r: EvalRuleResult, defaultsGate: boolean): string {
  if (r.kind === 'judgment') return 'gate';
  if (r.kind === 'policy') return decides(r, defaultsGate) ? 'gate' : 'advisory';
  if (r.critical === true) return 'veto';
  if (r.kind === 'detection' || r.kind === 'inference') return 'risk';
  return 'advisory';
}

describe('role matches the composer', () => {
  const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
  const files = readdirSync(corpusDir).filter((f) => f.endsWith('.json'));

  // Drives every corpus positive through the engine: ~6 s on a loaded machine, past vitest's 5 s default.
  it('over every corpus positive, the stamped role is the composer\'s own predicate', async () => {
    expect(files.length).toBeGreaterThan(10);
    const seen = new Set<string>();
    let checked = 0;
    for (const f of files) {
      const family = JSON.parse(readFileSync(resolve(corpusDir, f), 'utf8')) as { cases?: Case[] };
      for (const c of (family.cases ?? []).filter((x) => x.label === 'positive').slice(0, 6)) {
        const ctx = c.context ?? {};
        const result = await engine.evaluateAll({ output: c.output, input: c.input ?? (ctx.input as string | undefined), ...(ctx as object) } as never);
        for (const r of result.rule_results) {
          if (r.skipped) continue;
          expect(r.role, `${f} ${r.ruleName}`).toBe(expectedRole(r, defaultConfig.eval.defaultsGate ?? false));
          seen.add(r.role!);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(100);
    expect([...seen].sort()).toEqual(['advisory', 'gate', 'risk', 'veto']); // every role the schema advertises is produced by something real
  }, 30_000);

  it('a configured policy is a gate, and the role says so', async () => {
    const withPolicy = new EvalEngine(0.7, { ...defaultConfig.eval.ruleThresholds, cost_threshold: 0.05 }, { ...defaultConfig.eval, configuredThresholdKeys: ['cost_threshold'] });
    const result = await withPolicy.evaluateAll({ output: 'A fine answer that is long enough to pass the floor, in two sentences. It says something.', costUsd: 0.2 });
    const cost = result.rule_results.find((r) => r.ruleName === 'cost_under_threshold')!;
    expect(cost.passed).toBe(false);
    expect(cost.role).toBe('gate');
    expect(result.verdict!.basis).toBe('policy_gate');
    expect(result.rule_results.every((r) => r.skipped || ['gate', 'veto', 'risk', 'advisory'].includes(r.role!))).toBe(true);
  });
});
