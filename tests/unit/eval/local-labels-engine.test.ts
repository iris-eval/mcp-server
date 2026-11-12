/*
 * Labels exist, and a rule's local precision changes its published number
 * on this deployment at twenty labels — the engine's side.
 *
 * With nineteen labels a fired inference carries the published PPV; with
 * twenty it carries `local_labels` and the risk estimate reads the
 * deployment's own precision — so a verdict that failed on the published
 * number passes when the deployment has found the rule wrong eighteen
 * times in twenty. That is everything the labels do. An output the
 * labelled rule did not fire on is judged exactly as it is without them,
 * whichever way they went and however often the rule fires: the prior in
 * force is the deployment's when it set one and the default otherwise.
 * What the labels say about how often the failure is present is reported
 * and weighs nothing. The configuration hash carries the labels in force,
 * which a rule set to report only has none of. A stored row re-composes on
 * read to the same verdict from its own stamp, a row written before 0.22.0
 * included, and that one says how it was weighed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { compose, DEFAULT_COMPOSE } from '../../../src/eval/compose.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { localPrecision } from '../../../src/eval/labels.js';
import { buildLocalLabelSource, type LocalLabelSource } from '../../../src/eval/local-labels.js';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import type { EvalResult } from '../../../src/types/eval.js';
import type { IStorageAdapter } from '../../../src/types/query.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';

const STUB = 'TODO: write the summary.';

/** No rule fires on it. */
const CLEAN = {
  input: 'Which products does the shop carry, and what does the first one cost?',
  output: 'The shop carries three products: the Kona 250 g bag at 18.50 USD, the Maui 250 g bag at 17.00 USD and the sampler at 29.00 USD. The first one, the Kona bag, costs 18.50 USD.',
};

/** no_stub_output fires and says_something, the other rule that looks for a stub, stays quiet. */
const EMPTY_PROMISE = { input: 'What is the refund policy for opened items?', output: 'I will look into that and get back to you.' };

/** A failed tool call the answer does not mention: no_silent_tool_failure fires and no_stub_output stays quiet. */
const SILENT_FAILURE = {
  output: 'The invoice was sent to the customer and the balance is confirmed for the account.',
  input: 'Send the invoice and confirm the balance.',
  toolCalls: [{ tool_name: 'send_invoice', input: { id: 7 }, output: null, error: 'upstream timeout after 3 retries' }],
};

function source(right: number, wrong: number): LocalLabelSource {
  return {
    precision: new Map([['no_stub_output', localPrecision({ ruleName: 'no_stub_output', right, wrong })]]),
    fireRates: new Map([['no_stub_output', 0.3]]),
    prevalence: [],
    suggestion: null,
    refreshedAt: new Date().toISOString(),
  };
}

/** The source a deployment's storage gives when these rules have these labels and fired on `fired` of `judged` evaluations. */
function sourceFromStorage(rules: Array<{ ruleName: string; right: number; wrong: number; fired: number; judged: number }>): Promise<LocalLabelSource> {
  const storage = {
    labelTallies: async () => rules.map(({ ruleName, right, wrong }) => ({ ruleName, right, wrong })),
    ruleFireStats: async () => rules.map(({ ruleName, fired, judged }) => ({ ruleName, fired, judged })),
  } as unknown as IStorageAdapter;
  return buildLocalLabelSource(storage, LOCAL_TENANT);
}

const newEngine = (): EvalEngine => new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, defaultConfig.eval);

/** Everything an evaluation says that a reader or a gate acts on. */
const answer = (r: EvalResult) => ({ verdict: r.verdict, passed: r.passed, score: r.score, rule_results: r.rule_results, interpretations: r.interpretations });

const firedOn = (r: EvalResult): string[] => r.rule_results.filter((x) => !x.skipped && x.passed === false).map((x) => x.ruleName);

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

  it('the prior in force is the default, or the deployment’s own: labels are not a source of it', async () => {
    const plain = await newEngine().evaluateAll({ output: STUB });
    expect(plain.provenance?.composer).toMatchObject({ prior: 0.5, priorSource: 'default' });
    expect(plain.rule_results.find((r) => r.ruleName === 'no_pii')!.uncertainty).toMatchObject({ basis: 'published_accuracy', prior: { pi: 0.5, source: 'default' } });

    // Twenty labels on a rule that fires on three evaluations in ten: through 0.21.0 this set the prior of every class to about 0.04.
    const labels = await sourceFromStorage([{ ruleName: 'no_stub_output', right: 2, wrong: 18, fired: 300, judged: 1000 }]);
    expect(labels.prevalence).toHaveLength(1);
    const labelled = newEngine();
    labelled.setLocalLabels(labels);
    const withLabels = await labelled.evaluateAll({ output: STUB });
    expect(withLabels.provenance?.composer).toMatchObject({ prior: 0.5, priorSource: 'default' });
    // A quiet rule for another failure states its number at the prior it always had.
    expect(withLabels.rule_results.find((r) => r.ruleName === 'no_pii')!.uncertainty).toEqual(plain.rule_results.find((r) => r.ruleName === 'no_pii')!.uncertainty);
    expect(withLabels.verdict?.risk?.assumptions.join(' ')).not.toMatch(/estimated/);

    const configured = new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, prior: 0.3, priorConfigured: true });
    configured.setLocalLabels(labels);
    const own = await configured.evaluateAll({ output: STUB });
    expect(own.provenance?.composer).toMatchObject({ prior: 0.3, priorSource: 'config' });
    expect(own.rule_results.find((r) => r.ruleName === 'no_pii')!.uncertainty).toMatchObject({ prior: { pi: 0.3, source: 'config' } });
  });

  it('an output the labelled rule did not fire on is judged exactly as without labels, whichever way they went and however often the rule fires', async () => {
    const contexts = { CLEAN, EMPTY_PROMISE, SILENT_FAILURE, STUB: { output: STUB } };
    const plain = Object.fromEntries(await Promise.all(Object.entries(contexts).map(async ([name, context]) => [name, await newEngine().evaluateAll(context)] as const)));
    // What each output is: nothing fired; the stub rule fired and its sibling did not; a rule for another failure fired.
    expect(firedOn(plain.CLEAN)).toEqual([]);
    expect(plain.CLEAN.verdict).toMatchObject({ state: 'pass' });
    expect(firedOn(plain.EMPTY_PROMISE)).toContain('no_stub_output');
    expect(firedOn(plain.EMPTY_PROMISE)).not.toContain('says_something');
    expect(plain.SILENT_FAILURE.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['silent_tool_failure'] });
    expect(firedOn(plain.SILENT_FAILURE)).not.toContain('no_stub_output');

    const labellings = [
      // A rule that fires on one evaluation in five, every fire called right: through 0.21.0 this failed the clean answer.
      { ruleName: 'says_something', right: 20, wrong: 0, fired: 200, judged: 1000 },
      { ruleName: 'says_something', right: 0, wrong: 20, fired: 200, judged: 1000 },
      { ruleName: 'no_stub_output', right: 20, wrong: 0, fired: 600, judged: 1000 },
      // Rare, and every fire called wrong: through 0.21.0 this passed the verdict another rule had failed.
      { ruleName: 'no_stub_output', right: 0, wrong: 20, fired: 20, judged: 1000 },
      { ruleName: 'no_stub_output', right: 10, wrong: 10, fired: 100, judged: 1000 },
      { ruleName: 'no_silent_tool_failure', right: 20, wrong: 0, fired: 300, judged: 1000 },
      { ruleName: 'no_hallucination_markers', right: 20, wrong: 0, fired: 500, judged: 1000 },
    ];
    let compared = 0;
    for (const labelling of labellings) {
      const engine = newEngine();
      engine.setLocalLabels(await sourceFromStorage([labelling]));
      for (const [name, context] of Object.entries(contexts)) {
        if (firedOn(plain[name]).includes(labelling.ruleName)) continue;
        const after = await engine.evaluateAll(context);
        expect(answer(after), `${name} with ${labelling.right} right and ${labelling.wrong} wrong on ${labelling.ruleName}`).toEqual(answer(plain[name]));
        compared += 1;
      }
    }
    // Every pairing but the seven where the labelled rule is one that fired: the stub rule on the two stubs, three labellings each, and the tool-failure rule on its own fire.
    expect(compared).toBe(labellings.length * 4 - 7);
  });

  it('where the labelled rule fired, the verdict reads the precision of the labels and not how often the rule fires', async () => {
    const plain = await newEngine().evaluateAll(EMPTY_PROMISE);
    expect(plain.verdict?.state).toBe('fail');
    const at = async (right: number, wrong: number, fired: number): Promise<EvalResult> => {
      const engine = newEngine();
      engine.setLocalLabels(await sourceFromStorage([{ ruleName: 'no_stub_output', right, wrong, fired, judged: 1000 }]));
      return engine.evaluateAll(EMPTY_PROMISE);
    };
    // Called wrong eighteen times in twenty, the fire no longer carries the verdict, at any fire rate.
    const rare = await at(2, 18, 10);
    const common = await at(2, 18, 600);
    expect(rare.verdict?.state).toBe('pass');
    expect(answer(common)).toEqual(answer(rare));
    // Called right every time, it carries more than the published number did, at any fire rate.
    const rightRare = await at(20, 0, 10);
    const rightCommon = await at(20, 0, 600);
    expect(rightRare.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['stub'] });
    expect(rightRare.verdict!.risk!.pBad).toBeGreaterThan(plain.verdict!.risk!.pBad);
    expect(answer(rightCommon)).toEqual(answer(rightRare));
  });

  it('the source reports how often each labelled rule’s failure is present: one entry a rule, in name order, for the rules whose fires a verdict weighs', async () => {
    const src = await sourceFromStorage([
      { ruleName: 'says_something', right: 20, wrong: 0, fired: 50, judged: 1000 },
      { ruleName: 'no_stub_output', right: 12, wrong: 8, fired: 250, judged: 1000 },
      { ruleName: 'no_pii', right: 18, wrong: 2, fired: 40, judged: 1000 },
      // Not reported: a measurement, a rule one label short, and a rule that fires on nothing.
      { ruleName: 'min_output_length', right: 20, wrong: 0, fired: 300, judged: 1000 },
      { ruleName: 'no_tool_loop', right: 19, wrong: 0, fired: 100, judged: 1000 },
      { ruleName: 'no_hallucination_markers', right: 20, wrong: 0, fired: 0, judged: 1000 },
    ]);
    expect(src.prevalence.map((p) => p.ruleName)).toEqual(['no_pii', 'no_stub_output', 'says_something']);
    expect(src.prevalence.map((p) => p.classes)).toEqual([['pii_leak', 'credential_leak'], ['stub'], ['stub']]);
    // Two rules that look for the same failure each say what their own labels imply; neither is picked over the other.
    const [, stub, says] = src.prevalence;
    expect(stub).toMatchObject({ fireRate: 0.25 });
    expect(stub.pi).toBeCloseTo((0.25 * 0.6) / stub.sensitivity, 10);
    expect(says.pi).toBeCloseTo((0.05 * 1) / says.sensitivity, 10);
    expect(stub.lo).toBeLessThan(stub.pi);
    expect(stub.hi).toBeGreaterThan(stub.pi);
    expect((await sourceFromStorage([])).prevalence).toEqual([]);
  });

  it('the configuration hash carries the labels in force: it moves with a label that weighs a fire, and with nothing else the labels touch', async () => {
    const hashWith = async (rules: Parameters<typeof sourceFromStorage>[0]): Promise<string> => {
      const engine = newEngine();
      engine.setLocalLabels(await sourceFromStorage(rules));
      return (await engine.evaluateAll(CLEAN)).provenance!.configHash;
    };
    const none = (await newEngine().evaluateAll(CLEAN)).provenance!.configHash;
    const twenty = await hashWith([{ ruleName: 'no_stub_output', right: 2, wrong: 18, fired: 50, judged: 1000 }]);
    expect(twenty).not.toBe(none);
    // More traffic under the same labels is the same configuration: through 0.21.0 it was another.
    expect(await hashWith([{ ruleName: 'no_stub_output', right: 2, wrong: 18, fired: 60, judged: 1100 }])).toBe(twenty);
    // One more label weighs the rule's fires differently, whether or not it moves the precision's point.
    expect(await hashWith([{ ruleName: 'no_stub_output', right: 2, wrong: 19, fired: 50, judged: 1000 }])).not.toBe(twenty);
    const allRight = await hashWith([{ ruleName: 'no_stub_output', right: 20, wrong: 0, fired: 50, judged: 1000 }]);
    expect(await hashWith([{ ruleName: 'no_stub_output', right: 21, wrong: 0, fired: 50, judged: 1000 }])).not.toBe(allRight);
    // Labels that weigh nothing leave it alone: one short of the floor, and a measurement's.
    expect(await hashWith([{ ruleName: 'no_stub_output', right: 1, wrong: 18, fired: 50, judged: 1000 }])).toBe(none);
    expect(await hashWith([{ ruleName: 'min_output_length', right: 20, wrong: 0, fired: 300, judged: 1000 }])).toBe(none);
  });

  it('a rule the deployment set to report only is not weighed: its labels are not labels in force and move nothing', async () => {
    const reportOnly = (): EvalEngine => new EvalEngine(0.7, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, advisoryRules: ['no_stub_output'] });
    expect(newEngine().weighsFiresOf('no_stub_output')).toBe(true);
    expect(reportOnly().weighsFiresOf('no_stub_output')).toBe(false);
    // The setting is about one rule: the others are weighed as they were, and a measurement or a rule nobody ships never is.
    expect(reportOnly().weighsFiresOf('no_silent_tool_failure')).toBe(true);
    expect(reportOnly().weighsFiresOf('min_output_length')).toBe(false);
    expect(reportOnly().weighsFiresOf('a-rule-of-my-own')).toBe(false);
    // A rule that vetoes is weighed: its labels move the estimate the verdict carries.
    expect(newEngine().weighsFiresOf('no_pii')).toBe(true);

    const plain = await reportOnly().evaluateAll(EMPTY_PROMISE);
    expect(firedOn(plain)).toContain('no_stub_output');
    expect(plain.rule_results.find((r) => r.ruleName === 'no_stub_output')).toMatchObject({ advisory: true });
    for (const [right, wrong] of [[20, 0], [0, 20]] as const) {
      const engine = reportOnly();
      engine.setLocalLabels(await sourceFromStorage([{ ruleName: 'no_stub_output', right, wrong, fired: 300, judged: 1000 }]));
      const labelled = await engine.evaluateAll(EMPTY_PROMISE);
      // On the rule's own fire: the verdict is the one given without labels, under the same configuration.
      expect(labelled.verdict, `${right} right, ${wrong} wrong`).toEqual(plain.verdict);
      expect(labelled.provenance!.configHash).toBe(plain.provenance!.configHash);
    }
  });

  it('a stored row re-composes on read to the same verdict and the same risk, from its own stamp', async () => {
    const s = await store();
    const engine = newEngine();
    engine.setLocalLabels(await sourceFromStorage([{ ruleName: 'no_stub_output', right: 2, wrong: 18, fired: 300, judged: 1000 }]));
    for (const context of [{ output: STUB }, SILENT_FAILURE]) {
      const written = await engine.evaluateAll(context);
      await s.insertEvalResult(LOCAL_TENANT, written);
      const read = (await s.getEvalById(LOCAL_TENANT, written.id))!;
      expect(read.verdict?.state).toBe(written.verdict?.state);
      expect(read.verdict?.basis).toBe(written.verdict?.basis);
      expect(read.verdict?.risk).toEqual(written.verdict?.risk);
      expect(read.verdict?.confidence).toBe(written.verdict?.confidence);
      expect(read.provenance?.composer).toMatchObject({ prior: 0.5, priorSource: 'default' });
    }
  });

  it('a row stored when the labels’ estimate was the prior of every class reads back as it was given', async () => {
    const s = await store();
    // Through 0.21.0 the estimate replaced `prior` itself and the row said `estimated`.
    const written = await newEngine().evaluateAll(SILENT_FAILURE);
    written.provenance!.composer = { ...written.provenance!.composer!, prior: 0.12, priorSource: 'estimated' };
    const asGiven = compose(written, { ...DEFAULT_COMPOSE, prior: 0.12 });
    expect(asGiven.risk!.pBad).not.toBe(written.verdict!.risk!.pBad);
    await s.insertEvalResult(LOCAL_TENANT, written);
    const read = (await s.getEvalById(LOCAL_TENANT, written.id))!;
    expect(read.provenance?.composer).toMatchObject({ prior: 0.12, priorSource: 'estimated' });
    expect(read.verdict?.state).toBe(asGiven.state);
    expect(read.verdict?.risk).toEqual(asGiven.risk);

    // It says how it was weighed, and is not told that nothing but the labelled rule's fire read the labels: on this row the prior did.
    const texts = (read.interpretations ?? []).map((i) => i.text);
    expect(texts.filter((t) => t.startsWith('This verdict was weighed at a prior of 0.12 that an earlier version estimated from your labels and applied to every rule.'))).toHaveLength(1);
    expect(texts.join(' ')).toContain('Re-evaluating it weighs it that way.');
    expect(texts.join(' ')).not.toContain('Nothing else in a verdict reads your labels');

    // A verdict given now carries neither that note nor that stamp, and its sentence says how far labels reach.
    const now = await newEngine().evaluateAll(SILENT_FAILURE);
    await s.insertEvalResult(LOCAL_TENANT, now);
    const nowRead = (await s.getEvalById(LOCAL_TENANT, now.id))!;
    for (const r of [now, nowRead]) {
      const said = (r.interpretations ?? []).map((i) => i.text).join(' ');
      expect(said).not.toContain('earlier version');
      expect(said).toContain("Nothing else in a verdict reads your labels: every other rule's fire, and that rule's silence, are weighed as before.");
    }
  });
});
