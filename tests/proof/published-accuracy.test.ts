/*
 * The generated module equals the proof results, byte for byte.
 *
 * src/eval/published-accuracy.ts is the third output of `npm run proof`
 * and the only copy of the published numbers the shipped server can read.
 * `npm run proof -- --check` diffs it in CI; this test does the same from
 * the committed proof/results.json so a hand edit, a stale regeneration or
 * a CRLF checkout fails here with the field named.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PUBLISHED_ACCURACY_TS, renderPublishedAccuracy, type ProofResults } from '../../proof/run.js';
import { PUBLISHED_ACCURACY, PUBLISHED_ACCURACY_CORPUS_VERSION, PUBLISHED_ACCURACY_RELEASE } from '../../src/eval/published-accuracy.js';

const root = resolve(__dirname, '..', '..');
const results = JSON.parse(readFileSync(resolve(root, 'proof', 'results.json'), 'utf-8')) as ProofResults;

describe('src/eval/published-accuracy.ts', () => {
  it('is exactly what the runner renders from the committed proof/results.json', () => {
    const committed = readFileSync(resolve(root, PUBLISHED_ACCURACY_TS), 'utf-8').replace(/\r\n/g, '\n');
    expect(committed).toBe(renderPublishedAccuracy(results));
  });

  it('carries every measured rule with the same counts and intervals, and the same provenance', () => {
    expect(PUBLISHED_ACCURACY_CORPUS_VERSION).toBe(results.corpusVersion);
    expect(PUBLISHED_ACCURACY_RELEASE).toBe(results.version);
    const published = PUBLISHED_ACCURACY as Record<string, { n: number; tp: number; fp: number; fn: number; tn: number; precision: number | null; recall: number | null; f1: number | null; ci95: unknown }>;
    expect(Object.keys(published).sort()).toEqual(results.rules.map((r) => r.name).sort());
    for (const r of results.rules) {
      const p = published[r.name];
      expect({ n: p.n, tp: p.tp, fp: p.fp, fn: p.fn, tn: p.tn, precision: p.precision, recall: p.recall, f1: p.f1 }).toEqual({
        n: r.n, tp: r.tp, fp: r.fp, fn: r.fn, tn: r.tn, precision: r.precision, recall: r.recall, f1: r.f1,
      });
      expect(p.ci95).toEqual(r.ci95);
    }
  });

  it('carries no commit hash and no timestamp (a squash-merge erases branch commits; the check compares bytes)', () => {
    const committed = readFileSync(resolve(root, PUBLISHED_ACCURACY_TS), 'utf-8');
    expect(committed).not.toMatch(/generatedAt|commit/i);
    // The corpus version is the one hex token allowed; any other hex run of
    // seven or more characters that contains a letter is a hash.
    const withoutCorpus = committed.split(PUBLISHED_ACCURACY_CORPUS_VERSION).join('');
    expect(withoutCorpus).not.toMatch(/\b(?=[0-9a-f]*[a-f])[0-9a-f]{7,40}\b/i);
  });
});
