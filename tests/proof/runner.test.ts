/*
 * The rule-accuracy proof (proof/run.ts): every built-in rule has a labelled
 * family, every family validates, the interval maths matches independent
 * reference values, and two runs of the measurement are byte-identical.
 *
 * These are the invariants CI's `proof` job relies on; if one breaks, the
 * numbers on /proof are either incomplete or not reproducible.
 */
import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { loadCorpus, validateCorpusFile } from '../../proof/lib/corpus.js';
import { materialise, materialiseCase, hasUnfilledSlots } from '../../proof/lib/materialise.js';
import { summarise, bootstrapF1, confusion, f1Of, type Observation } from '../../proof/lib/metrics.js';
import { measure, registryRules, toResults, stableJson, normaliseForCheck, renderMarkdown, repoRoot } from '../../proof/run.js';

function obs(tp: number, fp: number, fn: number, tn: number): Observation[] {
  const out: Observation[] = [];
  let i = 0;
  for (let k = 0; k < tp; k++) out.push({ id: `c${i++}`, actual: true, predicted: true, skipped: false });
  for (let k = 0; k < fp; k++) out.push({ id: `c${i++}`, actual: false, predicted: true, skipped: false });
  for (let k = 0; k < fn; k++) out.push({ id: `c${i++}`, actual: true, predicted: false, skipped: false });
  for (let k = 0; k < tn; k++) out.push({ id: `c${i++}`, actual: false, predicted: false, skipped: false });
  return out;
}

describe('proof corpus', () => {
  it('has exactly one valid family for every rule in the registry', async () => {
    const { files } = await loadCorpus(repoRoot);
    const rules = registryRules();
    const registry = new Map(rules.map((r) => [r.name, r.evalType]));
    const issues = files.flatMap((f) => validateCorpusFile(f, `${f.family}.json`, registry));
    expect(issues).toEqual([]);
    const families = files.map((f) => f.rule).sort();
    expect(families).toEqual(rules.map((r) => r.name).sort());
  });

  it('holds no credential-shaped string in any case (placeholders only)', async () => {
    const { files } = await loadCorpus(repoRoot);
    const shaped = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}|\bgh[oprsu]_[A-Za-z0-9]{36,}|\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}|\bAIza[A-Za-z0-9_-]{30,}|\bnpm_[A-Za-z0-9]{30,}|\bdop_v1_[a-z0-9]{50,}|\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}|-----BEGIN [A-Z ]{0,24}PRIVATE KEY-----/;
    for (const f of files) {
      for (const c of f.cases) {
        expect(shaped.test(`${c.input ?? ''}\n${c.output}`), `${f.family}/${c.id}`).toBe(false);
      }
    }
  });

  it('materialises the same value for the same slot and seed, and a credential-shaped one', () => {
    const slots = { AWS_ACCESS_KEY: { kind: 'aws_access_key', prefix: 'AKIA', mask: '9AH9AHA9AA9AAAAA' } };
    const a = materialise('key={{AWS_ACCESS_KEY}}', slots, 'pii-068');
    const b = materialise('key={{AWS_ACCESS_KEY}}', slots, 'pii-068');
    expect(a).toBe(b);
    expect(a).toMatch(/^key=AKIA[A-Z0-9]{16}$/);
    expect(materialise('key={{AWS_ACCESS_KEY}}', slots, 'other-seed')).not.toBe(a);
    expect(hasUnfilledSlots(materialise('{{TYPO}}', slots, 'x'))).toBe(true);
    const pem = materialiseCase({
      id: 'p', rule: 'no_pii', label: 'positive', output: '{{PEM_PRIVATE_KEY}}', notes: 'n',
      slots: { PEM_PRIVATE_KEY: { kind: 'pem_private_key', type: 'RSA ', lines: ['AAAA9999aaaa', 'aa==' ] } },
    });
    expect(pem.output).toMatch(/^-----BEGIN RSA PRIVATE KEY-----\n[A-Z]{4}\d{4}[a-z]{4}\n[a-z]{2}==\n-----END RSA PRIVATE KEY-----$/);
  });
});

describe('proof metrics', () => {
  it('computes precision, recall and F1 from the confusion matrix', () => {
    const s = summarise(obs(34, 6, 11, 39));
    expect([s.tp, s.fp, s.fn, s.tn, s.n]).toEqual([34, 6, 11, 39, 90]);
    expect(s.precision).toBe(0.85);
    expect(s.recall).toBeCloseTo(0.7556, 4);
    expect(s.f1).toBe(0.8);
  });

  it('Wilson 95% intervals match independent reference values', () => {
    // Reference values (SciPy / by hand) at z = 1.959963984540054.
    const p = summarise(obs(5, 5, 0, 0)); // precision 5/10
    expect(p.ci95.precision).toEqual([0.2366, 0.7634]);
    const r = summarise(obs(30, 0, 6, 0)); // recall 30/36
    expect(r.ci95.recall).toEqual([0.6811, 0.9213]);
    const z = summarise(obs(0, 10, 0, 0)); // precision 0/10
    expect(z.ci95.precision).toEqual([0, 0.2775]);
    const full = summarise(obs(10, 0, 0, 5)); // precision and recall 10/10
    expect(full.ci95.precision).toEqual([0.7225, 1]);
    expect(full.ci95.recall).toEqual([0.7225, 1]);
  });

  it('reports null, not a number, when a proportion has no denominator', () => {
    const s = summarise(obs(0, 0, 3, 5)); // the rule never fired
    expect(s.precision).toBeNull();
    expect(s.ci95.precision).toBeNull();
    expect(s.recall).toBe(0);
    expect(s.f1).toBe(0);
  });

  it('bootstrap F1 interval is deterministic, brackets the point estimate, and stays in [0, 1]', () => {
    const o = obs(34, 6, 11, 39);
    const a = bootstrapF1(o);
    const b = bootstrapF1(o);
    expect(a).toEqual(b);
    expect(a).not.toBeNull();
    const point = f1Of(confusion(o)) as number;
    expect(a![0]).toBeLessThanOrEqual(point);
    expect(a![1]).toBeGreaterThanOrEqual(point);
    expect(a![0]).toBeGreaterThanOrEqual(0);
    expect(a![1]).toBeLessThanOrEqual(1);
    expect(bootstrapF1(obs(10, 0, 0, 10))![1]).toBe(1);
  });
});

describe('proof runner', () => {
  it('is deterministic across two runs and matches the committed results', async () => {
    const one = await measure(repoRoot);
    const two = await measure(repoRoot);
    expect(one.missing).toEqual([]);
    // The runner stamps the package version so a public surface can cite something a reader
    // can resolve (a squash-merge erases the branch commit); the committed file carries it, so
    // the comparison has to use the same value rather than a placeholder.
    const version = (JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf-8')) as { version: string }).version;
    const j1 = stableJson(toResults(one.rows, one.corpusVersion, 'T', 'C', version));
    const j2 = stableJson(toResults(two.rows, two.corpusVersion, 'T', 'C', version));
    expect(j1).toBe(j2);
    expect(one.rows.length).toBe(registryRules().length);

    const committed = await readFile(resolve(repoRoot, 'proof/results.json'), 'utf-8');
    const md = await readFile(resolve(repoRoot, 'proof/RESULTS.md'), 'utf-8');
    const fresh = normaliseForCheck(j1, renderMarkdown(one.rows, one.corpusVersion, 'T', 'C', one.missing, version));
    const onDisk = normaliseForCheck(committed, md);
    expect(fresh.json).toBe(onDisk.json);
    expect(fresh.md).toBe(onDisk.md);
  }, 60_000);

  it('rounds every published number to four places and keys every row by a registry rule', async () => {
    const results = JSON.parse(await readFile(resolve(repoRoot, 'proof/results.json'), 'utf-8'));
    const names = new Set(registryRules().map((r) => r.name));
    for (const row of results.rules) {
      expect(names.has(row.name), row.name).toBe(true);
      for (const v of [row.precision, row.recall, row.f1, ...Object.values(row.ci95).flat()]) {
        if (v === null) continue;
        expect(Math.round((v as number) * 10_000) / 10_000).toBe(v);
      }
      expect(row.tp + row.fp + row.fn + row.tn).toBe(row.n);
    }
    expect(results.method.ci).toBe('wilson-95');
    expect(results.humanAgreement.status).toBe('pending');
  });
});
