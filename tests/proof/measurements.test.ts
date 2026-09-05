/*
 * Arc 2's per-rule measurements beyond precision and recall (M3, M4, M7, M9):
 * the credible intervals do not collapse, the transforms land inside the
 * evidence span and are measured per rule, the PII positives name what they
 * contain and the per-entity table reads them, the eight custom types have
 * conformance families that validate and run through the real factory, and
 * the committed results file carries all of it at schemaVersion 2.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadCorpus, validateCorpusFile, PII_ENTITIES } from '../../proof/lib/corpus.js';
import { TRANSFORMS, TRANSFORM_RULES, transformOutput, measureTransforms } from '../../proof/lib/transforms.js';
import { CUSTOM_RULE_TYPES, loadCustomCorpus, validateCustomCorpusFile, measureCustom } from '../../proof/lib/custom-corpus.js';
import { measure, measureEntities, ppvFromCounts, registryRules, repoRoot, RESULTS_JSON, type ProofResults } from '../../proof/run.js';

describe('credible intervals in the results file', () => {
  it('every rule carries a Dirichlet credible interval beside the Wilson one, and no zero-error family reads [1, 1]', async () => {
    const results = JSON.parse(await readFile(resolve(repoRoot, RESULTS_JSON), 'utf-8')) as ProofResults;
    expect(results.schemaVersion).toBe(2);
    for (const r of results.rules) {
      expect(r.credible95, r.name).toBeDefined();
      if (r.fp === 0 && r.fn === 0 && r.tp > 0) {
        expect(r.credible95.f1![0], `${r.name} F1 lower bound`).toBeLessThan(1);
        expect(r.ci95.f1![0], `${r.name} bootstrap collapses`).toBe(1);
      }
      expect(Object.keys(r.ppvAt)).toEqual(['0.01', '0.05', '0.2', '0.5']);
    }
  });

  it('ppvAt follows sens·π / (sens·π + (1 − spec)(1 − π))', () => {
    // sens 0.8, spec 0.9: at π = 0.5 → 0.8·0.5 / (0.4 + 0.05) = 0.8889
    expect(ppvFromCounts({ tp: 8, fn: 2, tn: 9, fp: 1 }, 0.5)).toBeCloseTo(0.8889, 4);
    expect(ppvFromCounts({ tp: 8, fn: 2, tn: 9, fp: 1 }, 0.01)).toBeCloseTo(0.0748, 4);
    expect(ppvFromCounts({ tp: 0, fn: 0, tn: 9, fp: 1 }, 0.5)).toBeNull();
  });
});

describe('transforms', () => {
  it('each transform changes only the span it is given, and says when it does not apply', () => {
    const out = 'Call 415-555-0134 now';
    const span = [{ start: 5, end: 17 }];
    const zw = transformOutput(out, span, TRANSFORMS.find((t) => t.id === 'zero_width')!)!;
    expect(zw.length).toBe(out.length + 1);
    expect(zw.startsWith('Call ')).toBe(true);
    expect(zw.endsWith(' now')).toBe(true);
    expect(transformOutput('1234', [{ start: 0, end: 4 }], TRANSFORMS.find((t) => t.id === 'homoglyph')!)).toBeNull();
    expect(transformOutput('1234', [{ start: 0, end: 4 }], TRANSFORMS.find((t) => t.id === 'nbsp')!)).toBeNull();
    expect(transformOutput('abc', [{ start: 0, end: 3 }], TRANSFORMS.find((t) => t.id === 'fullwidth')!)).toBe('ａｂｃ');
    expect(transformOutput('aBc', [{ start: 0, end: 3 }], TRANSFORMS.find((t) => t.id === 'case')!)).toBe('AbC');
  });

  it('is measured for the three critical rules, with a row per transform and a denominator no larger than the fired-with-span count', async () => {
    const { files } = await loadCorpus(repoRoot);
    const byName = new Map(registryRules().map((r) => [r.name, r]));
    const t = measureTransforms(files, byName);
    expect(t.rules.map((r) => r.rule)).toEqual([...TRANSFORM_RULES]);
    expect(t.rows.length).toBe(TRANSFORM_RULES.length * TRANSFORMS.length);
    for (const s of t.rules) {
      expect(s.firedOriginally).toBeGreaterThan(0);
      expect(s.withSpan).toBeGreaterThan(0);
      expect(s.withSpan).toBeLessThanOrEqual(s.firedOriginally);
    }
    for (const row of t.rows) {
      const s = t.rules.find((r) => r.rule === row.rule)!;
      expect(row.n).toBeLessThanOrEqual(s.withSpan);
      expect(row.caught + row.dropped.length).toBe(row.n);
      if (row.n > 0) expect(row.ci95).not.toBeNull();
    }
    // Swapping case inside a blocklisted phrase must not defeat a case-insensitive match.
    expect(t.rows.find((r) => r.rule === 'no_blocklist_words' && r.transform === 'case')!.recall).toBe(1);
  });
});

describe('entities on the PII positives', () => {
  it('every no_pii positive names what it contains, from the entity vocabulary, and the family still validates', async () => {
    const { files } = await loadCorpus(repoRoot);
    const pii = files.find((f) => f.rule === 'no_pii')!;
    const registry = new Map(registryRules().map((r) => [r.name, r.evalType]));
    expect(validateCorpusFile(pii, 'pii.json', registry)).toEqual([]);
    for (const c of pii.cases) {
      if (c.label === 'positive') {
        expect(c.entities, c.id).toBeDefined();
        for (const e of c.entities!) expect(PII_ENTITIES as readonly string[]).toContain(e);
      } else {
        expect(c.entities, c.id).toBeUndefined();
      }
    }
  });

  it('the per-entity table separates caught from named, and reads the definition gap as rows', async () => {
    const { files } = await loadCorpus(repoRoot);
    const pii = files.find((f) => f.rule === 'no_pii')!;
    const rows = measureEntities(pii, registryRules().find((r) => r.name === 'no_pii')!);
    const by = Object.fromEntries(rows.map((r) => [r.entity, r]));
    for (const r of rows) {
      expect(r.named).toBeLessThanOrEqual(r.caught);
      expect(r.caught).toBeLessThanOrEqual(r.present);
    }
    // An address is not in the rule's definition: present in the corpus, never named.
    expect(by.address.present).toBeGreaterThan(0);
    expect(by.address.named).toBe(0);
    // An SSN is: every case present is named.
    expect(by.ssn.named).toBe(by.ssn.present);
  });

  it('a validator rejects an entity on a negative case or outside the vocabulary', async () => {
    const { files } = await loadCorpus(repoRoot);
    const pii = structuredClone(files.find((f) => f.rule === 'no_pii')!);
    const registry = new Map(registryRules().map((r) => [r.name, r.evalType]));
    const neg = pii.cases.find((c) => c.label === 'negative')!;
    neg.entities = ['email'];
    const pos = pii.cases.find((c) => c.label === 'positive')!;
    pos.entities = ['passport_number'];
    const issues = validateCorpusFile(pii, 'pii.json', registry);
    expect(issues.some((i) => i.includes(neg.id) && i.includes('positive cases only'))).toBe(true);
    expect(issues.some((i) => i.includes(pos.id) && i.includes('unknown entity'))).toBe(true);
  });
});

describe('custom rule type conformance', () => {
  it('one family per custom type, each validating with 24+ cases and 30–70% positive', async () => {
    const { files } = await loadCustomCorpus(repoRoot);
    expect(files.map((f) => f.type).sort()).toEqual([...CUSTOM_RULE_TYPES].sort());
    for (const f of files) expect(validateCustomCorpusFile(f, `custom/${f.type}.json`), f.type).toEqual([]);
  });

  it('runs every family through the real factory; cost_threshold skips without a cost instead of failing', async () => {
    const { files } = await loadCustomCorpus(repoRoot);
    const rows = measureCustom(files);
    for (const r of rows) {
      expect(r.n).toBeGreaterThanOrEqual(24);
      expect(r.tp + r.fp + r.fn + r.tn).toBe(r.n);
    }
    const cost = rows.find((r) => r.type === 'cost_threshold')!;
    expect(cost.skipped).toBe(2);
    expect(cost.fp).toBe(0);
  });

  it('the validator rejects a family that is unbalanced or mis-typed', async () => {
    const { files } = await loadCustomCorpus(repoRoot);
    const f = structuredClone(files[0]);
    f.cases = f.cases.filter((c) => c.label === 'negative');
    (f as { type: string }).type = 'not_a_type';
    const issues = validateCustomCorpusFile(f, 'x.json');
    expect(issues.some((i) => i.includes('not a custom rule type'))).toBe(true);
    expect(issues.some((i) => i.includes('30–70%') || i.includes('at least 24'))).toBe(true);
  });
});

describe('the committed results carry the arc-2 blocks', () => {
  it('results.json holds transforms, entities and custom, and measure() reproduces them', async () => {
    const results = JSON.parse(await readFile(resolve(repoRoot, RESULTS_JSON), 'utf-8')) as ProofResults;
    expect(results.transforms.rows.length).toBe(TRANSFORM_RULES.length * TRANSFORMS.length);
    expect(results.entities.map((e) => e.rule)).toEqual(['no_pii']);
    expect(results.custom.types.map((t) => t.type).sort()).toEqual([...CUSTOM_RULE_TYPES].sort());
    const fresh = await measure(repoRoot);
    expect(fresh.transforms.rows).toEqual(results.transforms.rows);
    expect(fresh.custom.map((c) => [c.type, c.tp, c.fp, c.fn, c.tn])).toEqual(results.custom.types.map((c) => [c.type, c.tp, c.fp, c.fn, c.tn]));
  }, 60_000);
});
