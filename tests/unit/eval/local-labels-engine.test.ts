/*
 * Labels exist, and a rule's local precision changes its published number
 * on this deployment at twenty labels — the engine's side.
 *
 * With nineteen labels a fired inference carries the published PPV; with
 * twenty it carries `local_labels` and the risk estimate reads the
 * deployment's own precision — so a verdict that failed on the published
 * number passes when the deployment has found the rule wrong eighteen
 * times in twenty. The labels also estimate how often the rule's own
 * failure class is present, and that estimate is the prior of that class
 * and of no other: a verdict that rests on another rule's fire is where it
 * was. The prior in force for every class without an estimate is the
 * deployment's when it set one, the default otherwise, and the provenance
 * says which and names each class the labels estimated. A stored row
 * re-composes on read to the same verdict from its own stamp.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { compose, DEFAULT_COMPOSE } from '../../../src/eval/compose.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { localPrecision, type ClassPrior } from '../../../src/eval/labels.js';
import { buildLocalLabelSource, type LocalLabelSource } from '../../../src/eval/local-labels.js';
import { FAILURE_CLASS_IDS } from '../../../src/eval/failure-classes.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import type { IStorageAdapter } from '../../../src/types/query.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const STUB = 'TODO: write the summary.';

/** A failed tool call the answer does not mention: no_silent_tool_failure fires and no_stub_output stays quiet. */
const SILENT_FAILURE = {
  output: 'The invoice was sent to the customer and the balance is confirmed for the account.',
  input: 'Send the invoice and confirm the balance.',
  toolCalls: [{ tool_name: 'send_invoice', input: { id: 7 }, output: null, error: 'upstream timeout after 3 retries' }],
};

const STUB_PRIOR: ClassPrior = { class: 'stub', pi: 0.12, lo: 0.05, hi: 0.2, ruleName: 'no_stub_output', fireRate: 0.3, sensitivity: 0.8 };

function source(right: number, wrong: number, classPriors: ClassPrior[] = []): LocalLabelSource {
  return {
    precision: new Map([['no_stub_output', localPrecision({ ruleName: 'no_stub_output', right, wrong })]]),
    fireRates: new Map([['no_stub_output', 0.3]]),
    classPriors,
    suggestion: null,
    refreshedAt: new Date().toISOString(),
  };
}

/** The source a deployment's storage gives when one rule has these labels and fired on `fired` of `judged` evaluations. */
function sourceFromStorage(ruleName: string, right: number, wrong: number, fired: number, judged: number): Promise<LocalLabelSource> {
  const storage = { labelTallies: async () => [{ ruleName, right, wrong }], ruleFireStats: async () => [{ ruleName, judged, fired }] } as unknown as IStorageAdapter;
  return buildLocalLabelSource(storage, LOCAL_TENANT);
}

const newEngine = (): EvalEngine => new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);

const dirs: string[] = [];
const stores: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close().catch(() => undefined);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
});

async function store(): Promise<SqliteAdapter> {
  const dir = mkdtempSync(join(tmpdir(), 'iris-local-labels-'));
  dirs.push(dir);
  const s = new SqliteAdapter(join(dir, 'iris.db'));
  await s.initialize();
  stores.push(s);
  return s;
}

describe('local precision on the engine', () => {
  it('nineteen labels: the fire still carries the published PPV; twenty: it carries local_labels and the verdict moves', async () => {
    const engine = newEngine();
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

  it('the prior in force is the default or the deployment’s own; the labels’ estimate is the prior of the labelled rule’s class and of no other', async () => {
    const engine = newEngine();
    const plain = await engine.evaluateAll({ output: STUB });
    expect(plain.provenance?.composer).toMatchObject({ prior: 0.5, priorSource: 'default' });
    expect(plain.provenance?.composer).not.toHaveProperty('classPriors');
    expect(plain.rule_results.find((r) => r.ruleName === 'no_pii')!.uncertainty).toMatchObject({ basis: 'published_accuracy', prior: { pi: 0.5, source: 'default' } });

    engine.setLocalLabels(source(2, 18, [STUB_PRIOR]));
    const estimated = await engine.evaluateAll({ output: STUB });
    // The prior every class starts from is still the default, and the one class the labels speak for is named with its own.
    expect(estimated.provenance?.composer).toMatchObject({ prior: 0.5, priorSource: 'default', classPriors: { stub: 0.12 } });
    // A rule for another class states its number at the prior it had.
    expect(estimated.rule_results.find((r) => r.ruleName === 'no_pii')!.uncertainty).toMatchObject({ prior: { pi: 0.5, source: 'default' } });
    // A rule for the labelled class, labelled or not, states its number at the estimate.
    expect(estimated.rule_results.find((r) => r.ruleName === 'says_something')!.uncertainty).toMatchObject({ prior: { pi: 0.12, source: 'estimated' } });
    expect(estimated.verdict?.risk?.assumptions.some((a) => a.includes('the prior of stub is 0.12') && a.includes('every other class keeps its share of prior 0.5'))).toBe(true);

    const configured = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, prior: 0.3, priorConfigured: true });
    configured.setLocalLabels(source(2, 18, [STUB_PRIOR]));
    const own = await configured.evaluateAll({ output: STUB });
    // The deployment's own eval.prior stands for every class, the labelled one included.
    expect(own.provenance?.composer).toMatchObject({ prior: 0.3, priorSource: 'config' });
    expect(own.provenance?.composer).not.toHaveProperty('classPriors');
    expect(own.rule_results.find((r) => r.ruleName === 'no_pii')!.uncertainty).toMatchObject({ prior: { pi: 0.3, source: 'config' } });
    expect(own.rule_results.find((r) => r.ruleName === 'says_something')!.uncertainty).toMatchObject({ prior: { pi: 0.3, source: 'config' } });
  });

  it('twenty labels on one rule’s fires leave a verdict that rests on another rule’s fire where it was, whichever way the labels went', async () => {
    const plain = await newEngine().evaluateAll(SILENT_FAILURE);
    expect(plain.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['silent_tool_failure'] });
    expect(plain.rule_results.find((r) => r.ruleName === 'no_stub_output')!.passed).toBe(true);
    const plainRisk = plain.verdict!.risk!;

    // A stub rule that fires on 2% of traffic: twenty labels put the prior of its class at a few percent or at the floor.
    for (const [right, wrong] of [[0, 20], [20, 0], [10, 10]] as const) {
      const labelled = newEngine();
      const src = await sourceFromStorage('no_stub_output', right, wrong, 20, 1000);
      expect(src.classPriors.map((p) => p.class)).toEqual(['stub']);
      expect(src.classPriors[0].pi).toBeLessThan(0.05);
      labelled.setLocalLabels(src);
      const after = await labelled.evaluateAll(SILENT_FAILURE);

      expect(after.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['silent_tool_failure'] });
      // Every class but the labelled rule's own is weighed exactly as it was, the class the verdict rests on among them.
      const risk = after.verdict!.risk!;
      for (const cls of FAILURE_CLASS_IDS) {
        if (cls === 'stub') continue;
        expect(risk.perClass[cls], cls).toBe(plainRisk.perClass[cls]);
      }
      // The labelled class is the one thing that moved: its rules were quiet here, and it is rarer than the default took it to be.
      expect(risk.perClass.stub).toBeLessThan(plainRisk.perClass.stub!);
      expect(plainRisk.pBad - risk.pBad).toBeGreaterThan(0);
      expect(plainRisk.pBad - risk.pBad).toBeLessThan(0.01);
      // The fire that failed the verdict states the number it stated without labels.
      const fire = (r: typeof plain) => r.rule_results.find((x) => x.ruleName === 'no_silent_tool_failure')!.uncertainty;
      expect(fire(after)).toEqual(fire(plain));
    }
  });

  it('a verdict no rule of the labelled class examined does not move at all, and is seeded as it was', async () => {
    // no_unusual_action reads a case's history; a call that carries none is not examined for its class.
    const plain = await newEngine().evaluateAll(SILENT_FAILURE);
    expect(plain.verdict!.risk!.perClass.wrong_trajectory).toBeNull();
    const labelled = newEngine();
    labelled.setLocalLabels(await sourceFromStorage('no_unusual_action', 0, 20, 20, 1000));
    const after = await labelled.evaluateAll(SILENT_FAILURE);
    expect(after.provenance?.composer).toMatchObject({ classPriors: { wrong_trajectory: 0.01 } });
    expect(after.verdict!.risk).toEqual(plain.verdict!.risk);
    expect(after.verdict!.state).toBe(plain.verdict!.state);
    expect(after.verdict!.confidence).toBe(plain.verdict!.confidence);
  });

  it('a stored row re-composes on read to the same verdict and the same risk, from its own stamp', async () => {
    const s = await store();
    const engine = newEngine();
    engine.setLocalLabels(source(2, 18, [STUB_PRIOR]));
    for (const context of [{ output: STUB }, SILENT_FAILURE]) {
      const written = await engine.evaluateAll(context);
      await s.insertEvalResult(LOCAL_TENANT, written);
      const read = (await s.getEvalById(LOCAL_TENANT, written.id))!;
      expect(read.verdict?.state).toBe(written.verdict?.state);
      expect(read.verdict?.basis).toBe(written.verdict?.basis);
      expect(read.verdict?.risk).toEqual(written.verdict?.risk);
      expect(read.verdict?.confidence).toBe(written.verdict?.confidence);
      expect(read.provenance?.composer).toMatchObject({ prior: 0.5, priorSource: 'default', classPriors: { stub: 0.12 } });
    }
  });

  it('a row stored when one estimate was the prior of every class reads back as it was given', async () => {
    const s = await store();
    // Through 0.21.0 the labels' estimate replaced `prior` itself and the row said `estimated`.
    const written = await newEngine().evaluateAll(SILENT_FAILURE);
    written.provenance!.composer = { ...written.provenance!.composer!, prior: 0.12, priorSource: 'estimated' };
    const asGiven = compose(written, { ...DEFAULT_COMPOSE, prior: 0.12 });
    expect(asGiven.risk!.pBad).not.toBe(written.verdict!.risk!.pBad);
    await s.insertEvalResult(LOCAL_TENANT, written);
    const read = (await s.getEvalById(LOCAL_TENANT, written.id))!;
    expect(read.provenance?.composer).toMatchObject({ prior: 0.12, priorSource: 'estimated' });
    expect(read.verdict?.state).toBe(asGiven.state);
    expect(read.verdict?.risk).toEqual(asGiven.risk);
  });
});
