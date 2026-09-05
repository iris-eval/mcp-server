/*
 * The composite corpus and the verdict measurement (arc 2, M1–M3, M11).
 *
 * The corpus validates (≥100 cases, every transcript promoted once, every
 * class a shipped detector maps to present, shouldShip consistent with the
 * stated rule); the split is a pure function of the id; the committed
 * results equal what the code produces; the risk composer agrees with the
 * legacy one wherever a critical rule vetoed; the sweep runs on dev only.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadComposite, splitOf, validateComposite, compositeContext, SPLIT_SALT } from '../../proof/lib/composite.js';
import { measureComposite, normaliseCompositeForCheck, renderCompositeMarkdown, COMPOSITE_RESULTS_JSON, COMPOSITE_MD, type CompositeResults } from '../../proof/lib/composite-report.js';
import { fnv1a } from '../../proof/lib/materialise.js';
import { repoRoot, stableJson } from '../../proof/run.js';
import { rulesByType } from '../../src/eval/rules/index.js';
import type { FailureClass } from '../../src/types/eval.js';

const DETECTED_CLASSES = new Set<FailureClass>(
  (['completeness', 'relevance', 'safety', 'cost'] as const).flatMap((t) => rulesByType[t]).flatMap((r) => [...(r.classes ?? [])] as FailureClass[]),
);

describe('composite corpus', () => {
  it('validates: at least 100 cases, every transcript promoted once, every detected class present, shouldShip by the stated rule', async () => {
    const loaded = await loadComposite(repoRoot);
    expect(validateComposite(loaded)).toEqual([]);
    expect(loaded.cases.length).toBeGreaterThanOrEqual(100);
    const present = new Set(loaded.cases.flatMap((c) => c.expected.classes));
    for (const cls of DETECTED_CLASSES) expect(present.has(cls), `no composite case carries ${cls}`).toBe(true);
    expect(loaded.cases.filter((c) => c.expected.shouldShip === true).length).toBeGreaterThanOrEqual(20);
    expect(loaded.cases.filter((c) => c.expected.shouldShip === false).length).toBeGreaterThanOrEqual(40);
  });

  it('the split is a pure function of the id, roughly 70/30, and is never stored', async () => {
    const loaded = await loadComposite(repoRoot);
    for (const c of loaded.cases) expect(splitOf(c.id)).toBe(fnv1a(c.id + SPLIT_SALT) % 100 < 70 ? 'dev' : 'test');
    const dev = loaded.cases.filter((c) => splitOf(c.id) === 'dev').length;
    expect(dev / loaded.cases.length).toBeGreaterThan(0.55);
    expect(dev / loaded.cases.length).toBeLessThan(0.85);
    for (const c of loaded.cases) expect((c as unknown as { split?: unknown }).split).toBeUndefined();
  });

  it('every case materialises to a non-empty evaluation input, and an injection changes the field it names', async () => {
    const loaded = await loadComposite(repoRoot);
    for (const c of loaded.cases) {
      const ctx = compositeContext(loaded, c);
      // An empty output is the one legitimate empty: it is what the `format` class looks like.
      if (!c.expected.classes.includes('format')) expect(ctx.output.length, c.id).toBeGreaterThan(0);
    }
    const injected = loaded.cases.find((c) => c.inject?.some((i) => i.where === 'output' && i.position === 'append'))!;
    const base = loaded.cases.find((c) => c.base === injected.base && !c.inject)!;
    expect(compositeContext(loaded, injected).output.length).toBeGreaterThan(compositeContext(loaded, base).output.length);
  });
});

describe('composite results', () => {
  it('the committed results equal what this code produces', async () => {
    const { results } = await measureComposite(repoRoot);
    const version = (JSON.parse(await readFile(resolve(repoRoot, 'package.json'), 'utf-8')) as { version: string }).version;
    const full: CompositeResults = { ...results, generatedAt: 'x', commit: 'x', version };
    const fresh = normaliseCompositeForCheck(stableJson(full), renderCompositeMarkdown(full));
    const committed = normaliseCompositeForCheck(
      await readFile(resolve(repoRoot, COMPOSITE_RESULTS_JSON), 'utf-8'),
      await readFile(resolve(repoRoot, COMPOSITE_MD), 'utf-8'),
    );
    expect(fresh.json).toBe(committed.json);
    expect(fresh.md).toBe(committed.md);
  }, 60_000);

  it('all three composers are scored on the test split with intervals, and each difference carries the Newcombe interval', async () => {
    const { results } = await measureComposite(repoRoot);
    for (const comp of ['legacy', 'risk', 'riskPerClass'] as const) {
      expect(results[comp].test.accuracy.n).toBeGreaterThan(20);
      expect(results[comp].test.accuracy.ci95).not.toBeNull();
      expect(results[comp].realTranscripts.accuracy.n).toBe(24);
    }
    for (const variant of ['risk', 'riskPerClass'] as const) {
      for (const split of ['test', 'realTranscripts'] as const) {
        const d = results.difference[variant][split];
        expect(d, `${variant}.${split}`).not.toBeNull();
        expect(d!.lo).toBeLessThanOrEqual(d!.delta);
        expect(d!.hi).toBeGreaterThanOrEqual(d!.delta);
      }
    }
    expect(results.method.priorMode).toBe('per-output');
  }, 60_000);

  it('the per-class prior is the degenerate reading: it blocks nearly every clean case, and the per-output prior does not', async () => {
    const { results } = await measureComposite(repoRoot);
    // Ten examined classes at a 0.5 prior each leave (1 − 0.5)^10 as the prior that nothing is wrong.
    expect(results.riskPerClass.dev.falseBlock.rate!).toBeGreaterThan(0.9);
    expect(results.risk.dev.falseBlock.rate!).toBeLessThan(results.riskPerClass.dev.falseBlock.rate!);
  }, 60_000);

  it('the risk composer fails every case the legacy composer vetoed, and the sweep never touches the test split', async () => {
    const { rows, results } = await measureComposite(repoRoot);
    for (const r of rows) {
      for (const cell of [r.risk, r.riskPerClass]) {
        if (r.legacy.criticalFailures.length > 0) expect(cell.state, r.id).toBe('fail');
        if (cell.pBad !== null) {
          expect(cell.lo).toBeLessThanOrEqual(cell.pBad);
          expect(cell.hi).toBeGreaterThanOrEqual(cell.pBad);
        }
      }
    }
    expect(results.sweep.split).toBe('dev');
    expect(results.sweep.variant).toBe('per-output');
    const devLabelled = rows.filter((r) => r.split === 'dev' && r.shouldShip !== null).length;
    for (const s of results.sweep.rows) expect(s.tp + s.fp + s.fn + s.tn).toBe(devLabelled);
    expect(results.sweep.shippedTau).toBe(0.5);
  }, 60_000);
});
