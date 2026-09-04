/**
 * The blind-label sample is the instrument that turns "the model agrees with itself" into
 * "a person agrees with the definition". Its whole value rests on two properties: the draw
 * is reproducible from a published seed, and the manifest carries no labels. Both are pinned
 * here, because a sample that quietly drifts between the draw and the score is not a blind
 * study, and a manifest that leaks a label is not blind at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorpus, drawSample, JUDGMENT_RULES } from '../../proof/blind-sample.mjs';

const ROOT = join(__dirname, '..', '..');
const manifest = JSON.parse(readFileSync(join(ROOT, 'proof', 'blind-sample.json'), 'utf-8')) as {
  seed: number;
  target: number;
  families: string[];
  ids: string[];
};

type Case = { id: string; rule: string; label: string };
const corpus = loadCorpus() as Array<{ rule: string; positiveClass: string; cases: Case[] }>;
const byId = new Map<string, Case>();
for (const fam of corpus) for (const c of fam.cases) byId.set(c.id, c);

describe('blind label sample', () => {
  it('the committed manifest is exactly what the seed draws', () => {
    const fresh = drawSample(corpus, manifest.seed, manifest.target) as { ids: string[] };
    expect(fresh.ids).toEqual(manifest.ids);
  });

  it('draws the stated number of distinct, real cases', () => {
    expect(manifest.ids).toHaveLength(manifest.target);
    expect(new Set(manifest.ids).size).toBe(manifest.target);
    for (const id of manifest.ids) expect(byId.get(id), `unknown case id ${id}`).toBeDefined();
  });

  it('covers every judgment family and only judgment families', () => {
    const drawn = new Set(manifest.ids.map((id) => byId.get(id)!.rule));
    expect([...drawn].sort()).toEqual([...JUDGMENT_RULES].sort());
    expect(manifest.families.slice().sort()).toEqual([...JUDGMENT_RULES].sort());
  });

  it('is not lopsided — an annotator answering all one way must not score well by accident', () => {
    const positives = manifest.ids.filter((id) => byId.get(id)!.label === 'positive').length;
    const share = positives / manifest.ids.length;
    expect(share).toBeGreaterThan(0.35);
    expect(share).toBeLessThan(0.65);
  });

  it('leaks no labels into the manifest', () => {
    const raw = readFileSync(join(ROOT, 'proof', 'blind-sample.json'), 'utf-8');
    expect(raw).not.toContain('"label"');
    expect(raw).not.toContain('positive');
    expect(raw).not.toContain('negative');
    expect(raw).not.toContain('"notes"');
  });
});
