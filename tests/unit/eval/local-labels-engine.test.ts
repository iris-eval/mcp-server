/*
 * Labels exist, and a rule's local precision changes its published number
 * on this deployment at twenty labels — the engine's side.
 *
 * With nineteen labels a fired inference carries the published PPV; with
 * twenty it carries `local_labels` and the risk estimate reads the
 * deployment's own precision — so a verdict that failed on the published
 * number passes when the deployment has found the rule wrong eighteen
 * times in twenty. The prior in force is the deployment's when it set one,
 * the labels' estimate when they imply one, the default otherwise, and the
 * provenance says which. A stored row re-composes on read to the same
 * verdict from its own stamp.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { localPrecision } from '../../../src/eval/labels.js';
import type { LocalLabelSource } from '../../../src/eval/local-labels.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const STUB = 'TODO: write the summary.';

function source(right: number, wrong: number, estimatedPrior: LocalLabelSource['estimatedPrior'] = null): LocalLabelSource {
  return {
    precision: new Map([['no_stub_output', localPrecision({ ruleName: 'no_stub_output', right, wrong })]]),
    fireRates: new Map([['no_stub_output', 0.3]]),
    estimatedPrior,
    suggestion: null,
    refreshedAt: new Date().toISOString(),
  };
}

const dirs: string[] = [];
const stores: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('local precision on the engine', () => {
  it('nineteen labels: the fire still carries the published PPV; twenty: it carries local_labels and the verdict moves', async () => {
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const before = await engine.evaluateAll({ output: STUB });
    const firedBefore = before.rule_results.find((r) => r.ruleName === 'no_stub_output')!;
    expect(firedBefore.passed).toBe(false);
    expect(firedBefore.uncertainty?.basis).toBe('published_accuracy');
    expect(before.verdict?.state).toBe('fail');
    expect(before.verdict?.basis).toBe('risk_over_loss');

    engine.setLocalLabels(source(1, 18));
    const nineteen = await engine.evaluateAll({ output: STUB });
    expect(nineteen.rule_results.find((r) => r.ruleName === 'no_stub_output')!.uncertainty?.basis).toBe('published_accuracy');
    expect(nineteen.verdict?.state).toBe('fail');

    engine.setLocalLabels(source(2, 18));
    const twenty = await engine.evaluateAll({ output: STUB });
    const fired = twenty.rule_results.find((r) => r.ruleName === 'no_stub_output')!;
    expect(fired.uncertainty).toMatchObject({ basis: 'local_labels', n: 20 });
    if (fired.uncertainty?.basis === 'local_labels') {
      expect(fired.uncertainty.precision.point).toBe(0.1);
      expect(fired.uncertainty.precision.lo).toBeLessThan(0.1);
      expect(fired.uncertainty.precision.hi).toBeGreaterThan(0.1);
    }
    // The risk estimate read the deployment's own number and says so.
    expect(twenty.verdict?.state).toBe('pass');
    expect(twenty.verdict?.risk?.pBad).toBeLessThan(before.verdict!.risk!.pBad);
    expect(twenty.verdict?.risk?.assumptions.some((a) => a.includes('local precision') && a.includes('no_stub_output (20 labels)'))).toBe(true);

    // A quiet rule keeps the published miss rate: labels on fires say nothing about misses.
    const quiet = twenty.rule_results.find((r) => r.ruleName === 'no_pii')!;
    expect(quiet.uncertainty?.basis).toBe('published_accuracy');

    // Clearing the source restores the published path.
    engine.setLocalLabels(null);
    const after = await engine.evaluateAll({ output: STUB });
    expect(after.rule_results.find((r) => r.ruleName === 'no_stub_output')!.uncertainty?.basis).toBe('published_accuracy');
    expect(after.verdict?.state).toBe('fail');
  });

  it('the prior in force: default, then estimated from labels, and the deployment’s own always wins', async () => {
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const plain = await engine.evaluateAll({ output: STUB });
    expect(plain.provenance?.composer).toMatchObject({ prior: 0.5, priorSource: 'default' });
    const quietPlain = plain.rule_results.find((r) => r.ruleName === 'no_pii')!;
    expect(quietPlain.uncertainty).toMatchObject({ basis: 'published_accuracy', prior: { pi: 0.5, source: 'default' } });

    engine.setLocalLabels(source(2, 18, { pi: 0.12, lo: 0.05, hi: 0.2, ruleName: 'no_stub_output', fireRate: 0.3, sensitivity: 0.8 }));
    const estimated = await engine.evaluateAll({ output: STUB });
    expect(estimated.provenance?.composer).toMatchObject({ prior: 0.12, priorSource: 'estimated' });
    expect(estimated.rule_results.find((r) => r.ruleName === 'no_pii')!.uncertainty).toMatchObject({ prior: { pi: 0.12, source: 'estimated' } });

    const configured = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, prior: 0.3, priorConfigured: true });
    configured.setLocalLabels(source(2, 18, { pi: 0.12, lo: 0.05, hi: 0.2, ruleName: 'no_stub_output', fireRate: 0.3, sensitivity: 0.8 }));
    const own = await configured.evaluateAll({ output: STUB });
    expect(own.provenance?.composer).toMatchObject({ prior: 0.3, priorSource: 'config' });
    expect(own.rule_results.find((r) => r.ruleName === 'no_pii')!.uncertainty).toMatchObject({ prior: { pi: 0.3, source: 'config' } });
  });

  it('a stored row re-composes on read to the same verdict and the same risk, from its own stamp', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'iris-local-labels-'));
    dirs.push(dir);
    const store = new SqliteAdapter(join(dir, 'iris.db'));
    await store.initialize();
    stores.push(store);
    const engine = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    engine.setLocalLabels(source(2, 18, { pi: 0.12, lo: 0.05, hi: 0.2, ruleName: 'no_stub_output', fireRate: 0.3, sensitivity: 0.8 }));
    const written = await engine.evaluateAll({ output: STUB });
    await store.insertEvalResult(LOCAL_TENANT, written);
    const read = (await store.getEvalById(LOCAL_TENANT, written.id))!;
    expect(read.verdict?.state).toBe(written.verdict?.state);
    expect(read.verdict?.basis).toBe(written.verdict?.basis);
    expect(read.verdict?.risk?.pBad).toBe(written.verdict?.risk?.pBad);
    expect(read.verdict?.risk?.lo).toBe(written.verdict?.risk?.lo);
    expect(read.verdict?.risk?.hi).toBe(written.verdict?.risk?.hi);
    expect(read.provenance?.composer).toMatchObject({ prior: 0.12, priorSource: 'estimated' });
  });
});
