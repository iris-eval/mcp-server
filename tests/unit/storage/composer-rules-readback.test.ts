/*
 * A stored verdict reads back as its caller was given it.
 *
 * A read re-composes the verdict from the stored rule results. From 0.20.0
 * a layer that fails outranks one that could not check, so an evaluation
 * the risk layer fails on a deployment that also lacked required evidence
 * reads `fail` where it used to read `unknown`. A row written before that
 * change was given to its caller as `unknown`, and re-meaning it on the
 * next upgrade would rewrite history: the row is stamped with the composer
 * rules it was judged under (Provenance.composer.rules), and a row with no
 * stamp reads under rules 1.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteAdapter } from '../../../src/storage/sqlite-adapter.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { compose, COMPOSER_RULES, DEFAULT_COMPOSE } from '../../../src/eval/compose.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import { LOCAL_TENANT } from '../../../src/types/tenant.js';
import type { EvalResult } from '../../../src/types/eval.js';

const stores: SqliteAdapter[] = [];
afterEach(async () => {
  for (const s of stores.splice(0)) await s.close();
});
async function store(): Promise<SqliteAdapter> {
  const s = new SqliteAdapter(':memory:');
  await s.initialize();
  stores.push(s);
  return s;
}

// A deployment that requires a cost on every evaluation.
const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, requiredEvidence: ['cost'] } as never);

// The risk layer fails this: the answer claims a pass over a tool call that failed. And it carries no cost.
const context = {
  input: 'Fix the failing date parser and run the test suite.',
  output: 'I fixed the date parser so it accepts ISO week dates, and ran the test suite. All tests pass and the change is ready to merge.',
  toolCalls: [{ tool_name: 'bash', input: { command: 'npm test' }, output: '', error: 'Command failed with exit code 1' }],
};

describe('the composer rules a row was judged under', () => {
  it('this build stamps its rules, and judges a failure over a layer that could not check', async () => {
    const r = await engine.evaluateAll(context);
    expect(COMPOSER_RULES).toBe(3);
    expect(r.provenance!.composer!.rules).toBe(3);
    expect(r.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
    expect(r.verdict!.also).toContainEqual({ basis: 'required_evidence_missing', state: 'unknown', by: ['cost'] });
  });

  it('a row whose loop check threw reads back clean when it was judged under rules 2, and unknown when it is judged now', async () => {
    // An embedder's own run: a BigInt in a call's input, which no request can carry, makes the rules that write an input out throw.
    const quiet = { input: context.input, output: 'The parser now accepts ISO week dates; the change is in src/date.ts and its test.', toolCalls: [{ tool_name: 'read_file', input: { path: 'src/date.ts', at: 10n } }] };
    const plain = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval } as never);
    const r = await plain.evaluateAll(quiet);
    const threw = r.rule_results.filter((x) => x.threw === true).map((x) => x.ruleName);
    expect(threw).toContain('no_tool_loop');
    expect(r.verdict).toMatchObject({ state: 'unknown', passed: false, basis: 'critical_unknown' });
    expect(r.verdict!.by).toContain('no_tool_loop');

    const s = await store();
    // BigInt has no JSON: the row is stored as its results, which is all a read composes from.
    const stored = { ...r, id: 'now', rule_results: r.rule_results } as EvalResult;
    await s.insertEvalResult(LOCAL_TENANT, stored);
    expect((await s.getEvalById(LOCAL_TENANT, 'now'))!.verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
    // As a build before this change stored the same results: stamped with rules 2, under which a rule that threw and nobody asked for took no part.
    const earlier = structuredClone({ ...stored, id: 'earlier' }) as EvalResult;
    earlier.provenance!.composer!.rules = 2;
    await s.insertEvalResult(LOCAL_TENANT, earlier);
    const read = (await s.getEvalById(LOCAL_TENANT, 'earlier'))!;
    expect(read.verdict!.basis).not.toBe('critical_unknown');
    expect(read.verdict!.state).toBe(compose(r, { ...DEFAULT_COMPOSE, rules: 2 }).state);
  });

  it('a row stored now reads back fail; the same row without the stamp reads back as 0.19.0 gave it', async () => {
    const s = await store();
    const r = await engine.evaluateAll(context);
    await s.insertEvalResult(LOCAL_TENANT, { ...r, id: 'now' });
    const now = (await s.getEvalById(LOCAL_TENANT, 'now'))!;
    expect(now.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });

    // As 0.19.0 stored it: the same rule results, and no `rules` in the composer facts.
    const earlier = structuredClone({ ...r, id: 'earlier' }) as EvalResult;
    delete earlier.provenance!.composer!.rules;
    await s.insertEvalResult(LOCAL_TENANT, earlier);
    const read = (await s.getEvalById(LOCAL_TENANT, 'earlier'))!;
    expect(read.verdict).toMatchObject({ state: 'unknown', passed: false, basis: 'required_evidence_missing', by: ['cost'] });
    expect(read.verdict!.also).toContainEqual(expect.objectContaining({ basis: 'risk_over_loss', state: 'fail' }));
    // Neither reading is a pass, and both rows are counted the same way.
    expect(read.passed).toBe(false);
    expect(now.passed).toBe(false);
  });

  it('compose() under rules 1 takes the first layer with something to say; under rules 2 the first that fails', async () => {
    const r = await engine.evaluateAll(context);
    const cfg = { ...DEFAULT_COMPOSE, requiredEvidence: ['cost'] as const };
    expect(compose(r, { ...cfg, rules: 1 })).toMatchObject({ state: 'unknown', basis: 'required_evidence_missing' });
    expect(compose(r, { ...cfg, rules: 2 })).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
    expect(compose(r, cfg)).toMatchObject({ state: 'fail', basis: 'risk_over_loss' });
    // Where no layer fails, the two agree.
    const quiet = await engine.evaluateAll({ input: context.input, output: 'The parser now accepts ISO week dates; the change is in src/date.ts and its test.' });
    expect(compose(quiet, { ...cfg, rules: 1 })).toEqual(compose(quiet, { ...cfg, rules: 2 }));
    expect(compose(quiet, cfg).state).toBe('unknown');
  });
});

/*
 * Rows an EARLIER version judged and stored, with what that version read
 * back for each: tests/fixtures/readback/rows-stored-by-main.json, made by
 * the script beside it from main at the commit the file names, the last
 * before the composer's rules became 3.
 *
 * A row this version judges and then stamps with an earlier number holds
 * only what this version puts in a row. These hold what the earlier code
 * put there, so they are what a store written before an upgrade holds.
 * Each is compared whole: the verdict with its layers and the names in
 * them, `passed`, every sentence, and the critical rules that skipped.
 */
interface StoredByMain {
  madeFrom: string;
  rows: Array<{ id: string; what: string; stored: EvalResult; read: { verdict: unknown; passed: boolean; interpretations: unknown[]; critical_skipped: string[] } }>;
}
const storedByMain = JSON.parse(readFileSync(resolve(__dirname, '../../fixtures/readback/rows-stored-by-main.json'), 'utf8')) as StoredByMain;

describe('a row an earlier version judged and stored reads back as that version gave it', () => {
  const readBack = async (stored: EvalResult) => {
    const s = await store();
    await s.insertEvalResult(LOCAL_TENANT, stored);
    const read = (await s.getEvalById(LOCAL_TENANT, stored.id))!;
    return { verdict: read.verdict, passed: read.passed, interpretations: read.interpretations ?? [], critical_skipped: read.critical_skipped ?? [] };
  };

  it('the rows are of the earlier rules, and each kind of row this change could have re-meant is among them', () => {
    expect(storedByMain.madeFrom).toBe('bba11172');
    expect(storedByMain.rows.map((row) => row.id)).toEqual([
      'risk-no-class',
      'risk-no-class-and-evidence',
      'plugin-fire-beside-a-weighed-one',
      'threw',
      'threw-with-its-threshold-set',
      'critical-threw-beside-a-veto',
      'report-only-lacking-its-input',
      'risk-no-class-unstamped',
    ]);
    for (const row of storedByMain.rows) expect(row.stored.provenance?.composer?.rules ?? 1, row.id).toBeLessThan(3);
    // The rows the earlier rules read otherwise than these do: a risk failure that names no class, and a rule that threw and takes no part.
    const given = (id: string) => storedByMain.rows.find((row) => row.id === id)!.read.verdict;
    expect(given('risk-no-class')).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: [] });
    expect(given('threw')).toMatchObject({ state: 'pass', basis: 'clean' });
    expect(storedByMain.rows.find((row) => row.id === 'threw')!.stored.rule_results.filter((r) => r.threw === true).map((r) => r.ruleName)).toContain('no_tool_loop');
  });

  for (const row of storedByMain.rows) {
    it(`${row.id}: ${row.what}`, async () => {
      expect(await readBack(row.stored)).toEqual(row.read);
    });
  }

  it('the same rule results stamped with these rules compose otherwise: what the rules number holds apart', async () => {
    // The probe can fail: stamped 3, three of the rows read as another verdict than the earlier version gave, and it is by the stamp that they do not.
    const restamped = async (id: string) => {
      const stored = structuredClone(storedByMain.rows.find((row) => row.id === id)!.stored);
      stored.id = `${stored.id}-under-rules-3`;
      stored.provenance!.composer!.rules = 3;
      return readBack(stored);
    };
    expect((await restamped('risk-no-class')).verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['stub'] });
    expect((await restamped('threw')).verdict).toMatchObject({ state: 'unknown', basis: 'critical_unknown' });
    const plugin = await restamped('plugin-fire-beside-a-weighed-one');
    expect(plugin.verdict).toMatchObject({ state: 'fail', basis: 'risk_over_loss', by: ['stub'] });
    expect(JSON.stringify(plugin.interpretations)).toContain('rests on no_stub_output.');
    expect(JSON.stringify(storedByMain.rows.find((row) => row.id === 'plugin-fire-beside-a-weighed-one')!.read.interpretations)).toContain('rests on no_stub_output, acme_account_scan.');
  });
});
