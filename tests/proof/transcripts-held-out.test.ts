/*
 * The 24 real transcripts stay held out of every per-rule number.
 *
 * The per-rule accuracy the risk composer reads (src/eval/published-accuracy.ts)
 * is measured on the labelled families in proof/corpus. The real-transcript
 * line in proof/COMPOSITE.md and proof/TRANSCRIPTS.md is scored by that
 * composer, so a family case copied from a transcript would make the line
 * partly in-sample: the rates would have been estimated on the runs they are
 * then scored on. Earlier releases carried 85 such cases. This test fails if
 * one comes back — by a note that names a transcript, by the transcript's
 * input, or by its output reproduced in a case.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

import { loadCorpus } from '../../proof/lib/corpus.js';
import { loadComposite } from '../../proof/lib/composite.js';
import { REAL_TRANSCRIPTS_DIR } from '../../proof/lib/composite.js';
import { repoRoot } from '../../proof/run.js';

const norm = (s: unknown): string => (typeof s === 'string' ? s.replace(/\s+/g, ' ').trim() : '');

interface Transcript {
  id: string;
  input: string;
  output: string;
}

function transcripts(): Transcript[] {
  const dir = resolve(repoRoot, REAL_TRANSCRIPTS_DIR);
  return readdirSync(dir)
    .filter((n) => /^t-\d\d-.*\.json$/.test(n))
    .map((n) => {
      const raw = JSON.parse(readFileSync(resolve(dir, n), 'utf-8')) as { input?: string; output?: string };
      return { id: n.slice(0, 4), input: norm(raw.input), output: norm(raw.output) };
    });
}

describe('real transcripts are held out of the labelled families', () => {
  it('finds all 24 transcripts to compare against', () => {
    expect(transcripts()).toHaveLength(24);
  });

  it('no family case names, repeats the input of, or reproduces the output of a transcript', async () => {
    const ts = transcripts();
    const { files } = await loadCorpus(repoRoot);
    const hits: string[] = [];
    for (const f of files) {
      for (const c of f.cases) {
        const where = `${f.family}/${c.id}`;
        const named = (c.notes ?? '').match(/\bt-\d\d\b/g);
        if (named) hits.push(`${where}: notes name ${named.join(', ')}`);
        const input = norm(c.input);
        const output = norm(c.output);
        for (const t of ts) {
          if (input.length > 0 && input === t.input) hits.push(`${where}: input is ${t.id}'s`);
          if (t.output.length >= 40 && output.includes(t.output)) hits.push(`${where}: output reproduces ${t.id}'s`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it('every composed case built on a family case points at one that exists, and so is held out too', async () => {
    const { cases } = await loadComposite(repoRoot);
    const { files } = await loadCorpus(repoRoot);
    const known = new Set(files.flatMap((f) => f.cases.map((c) => `${f.family}:${c.id}`)));
    const dangling = cases
      .filter((c) => c.provenance === 'composed' && c.base.includes(':'))
      .filter((c) => !known.has(c.base))
      .map((c) => `${c.id} → ${c.base}`);
    expect(dangling).toEqual([]);
  });
});
