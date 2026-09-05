/*
 * The published accuracy, read at runtime — the arithmetic and its provenance.
 *
 * Arc zero (2026-09-05) found the per-rule precision/recall intervals in
 * proof/results.json never reached a result, a roster entry or a resource;
 * and that the published precision is the value at corpus prevalence (about
 * one half) while no surface said what a fire is worth at field prevalence
 * (for no_pii, from 87% to about 6% at one percent). This module carries the
 * numbers into the shipped server and does that arithmetic, with intervals.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fnv1a as proofFnv1a, mulberry32 as proofMulberry32 } from '../../../proof/lib/materialise.js';
import { rulesByType } from '../../../src/eval/rules/index.js';
import {
  missRateInterval,
  ppvAt,
  ppvInterval,
  publishedAccuracyFor,
  publishedProvenance,
  publishedRuleNames,
  resetAccuracyMemo,
} from '../../../src/eval/accuracy.js';
import { beta, fnv1a, gamma, missRate, mulberry32, percentile95, ppv } from '../../../src/eval/stats.js';

const root = resolve(__dirname, '..', '..', '..');

describe('stats — the seeded generator twins the proof harness', () => {
  it('fnv1a and mulberry32 agree with proof/lib/materialise.ts on a fixed seed', () => {
    for (const seed of ['proof-f1-bootstrap-v1', 'ppv:no_pii:abc', '']) {
      expect(fnv1a(seed)).toBe(proofFnv1a(seed));
      const a = mulberry32(fnv1a(seed));
      const b = proofMulberry32(proofFnv1a(seed));
      for (let i = 0; i < 5; i++) expect(a()).toBe(b());
    }
  });

  it('gamma and beta draws are in range and reproducible', () => {
    const rng = mulberry32(fnv1a('stats-test'));
    const g = Array.from({ length: 200 }, () => gamma(0.5, rng));
    expect(g.every((x) => x > 0)).toBe(true);
    const b = Array.from({ length: 200 }, () => beta(34.5, 11.5, rng));
    expect(b.every((x) => x > 0 && x < 1)).toBe(true);
    const again = mulberry32(fnv1a('stats-test'));
    expect(gamma(0.5, again)).toBe(g[0]);
    const [lo, hi] = percentile95(b);
    expect(lo).toBeLessThanOrEqual(hi);
  });

  it('PPV and the miss rate behave like the diagnostic-test arithmetic they are', () => {
    expect(ppv(1, 1, 0.01)).toBe(1);
    expect(ppv(0.756, 0.889, 0.5)).toBeCloseTo(0.872, 2);
    expect(ppv(0.756, 0.889, 0.01)).toBeLessThan(0.1);
    // PPV rises with prevalence; the miss rate never exceeds the prevalence.
    expect(ppv(0.756, 0.889, 0.2)).toBeGreaterThan(ppv(0.756, 0.889, 0.05));
    expect(missRate(0.756, 0.889, 0.2)).toBeLessThanOrEqual(0.2);
  });
});

describe('accuracy — the published numbers and their intervals', () => {
  it('every built-in with a proof family is published, with its provenance', () => {
    const results = JSON.parse(readFileSync(resolve(root, 'proof', 'results.json'), 'utf-8')) as { corpusVersion: string; rules: Array<{ name: string }> };
    const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf-8')) as { version: string };
    const names = publishedRuleNames();
    expect(names.sort()).toEqual(results.rules.map((r) => r.name).sort());
    const builtIns = (['completeness', 'relevance', 'safety', 'cost'] as const).flatMap((t) => rulesByType[t].map((r) => r.name));
    for (const n of builtIns) expect(names, `${n} has no published family`).toContain(n);
    const prov = publishedProvenance();
    expect(prov.corpusVersion).toBe(results.corpusVersion);
    expect(prov.release).toBe(pkg.version);
    expect(['same-model', 'human-verified']).toContain(prov.labelling);
    expect(publishedAccuracyFor('no_such_rule')).toBeNull();
  });

  it('a fired detection gets a PPV interval that contains its point and moves with the prevalence', () => {
    resetAccuracyMemo();
    const at50 = ppvInterval('no_pii', 0.5);
    const at1 = ppvInterval('no_pii', 0.01);
    expect(at50).not.toBeNull();
    expect(at1).not.toBeNull();
    expect(at50!.lo).toBeLessThanOrEqual(at50!.point);
    expect(at50!.point).toBeLessThanOrEqual(at50!.hi);
    expect(at1!.point).toBeLessThan(at50!.point);
    // The point is the published precision's arithmetic at corpus prevalence.
    const counts = publishedAccuracyFor('no_pii')!;
    const sens = counts.tp / (counts.tp + counts.fn);
    const spec = counts.tn / (counts.tn + counts.fp);
    expect(at50!.point).toBeCloseTo(ppv(sens, spec, 0.5), 4);
  });

  it('the interval is a pure function of the rule, the prevalence and the corpus (seeded)', () => {
    resetAccuracyMemo();
    const first = ppvInterval('no_stub_output', 0.2);
    resetAccuracyMemo();
    const second = ppvInterval('no_stub_output', 0.2);
    expect(first).toEqual(second);
    expect(ppvInterval('no_stub_output', 0.2)).toBe(ppvInterval('no_stub_output', 0.2)); // memoised
  });

  it('a rule that did not fire gets a residual miss rate below the prevalence', () => {
    const miss = missRateInterval('no_hallucination_markers', 0.3);
    expect(miss).not.toBeNull();
    expect(miss!.point).toBeLessThanOrEqual(0.3);
    expect(miss!.lo).toBeLessThanOrEqual(miss!.point);
    expect(miss!.point).toBeLessThanOrEqual(miss!.hi);
  });

  it('ppvAt renders the field-prevalence table a reader needs beside a published precision', () => {
    const table = ppvAt('no_pii');
    expect(Object.keys(table)).toEqual(['0.01', '0.05', '0.20', '0.50']);
    expect(table['0.01']!).toBeLessThan(table['0.50']!);
    expect(ppvAt('no_such_rule')['0.50']).toBeNull();
  });
});
