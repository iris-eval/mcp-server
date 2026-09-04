import { describe, it, expect } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  readJudgeCaseFile,
  validateJudgeCaseFile,
  materialiseCases,
  readCitationCaseFile,
  validateCitationCaseFile,
  TEMPLATE_NAMES,
} from '../../../proof/judge/lib/cases.js';
import { slotsFor, materialise, hasUnfilledSlots } from '../../../proof/judge/materialise.js';
import { extractCitations } from '../../../src/eval/citation-verify/extract.js';
import { ALL_TEMPLATES } from '../../../src/eval/llm-judge/templates/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..', '..');

describe('judge proof case files', () => {
  for (const template of TEMPLATE_NAMES) {
    it(`${template}.json is valid, balanced and 30–40 cases`, async () => {
      const file = await readJudgeCaseFile(repoRoot, template);
      const issues = validateJudgeCaseFile(file, template);
      expect(issues, issues.join('\n')).toEqual([]);
    });

    it(`${template}.json passThreshold matches the shipped template`, async () => {
      const file = await readJudgeCaseFile(repoRoot, template);
      const shipped = ALL_TEMPLATES.find((t) => t.name === template);
      expect(shipped).toBeDefined();
      // The case file's stated threshold must be the one the judge enforces,
      // or the labels were judged against the wrong bar.
      expect(file.passThreshold).toBe(shipped!.passThreshold);
    });

    it(`${template}.json materialises with no leftover slots and twins line up`, async () => {
      const file = await readJudgeCaseFile(repoRoot, template);
      const cases = materialiseCases(file);
      for (const c of cases) {
        for (const field of [c.input, c.output, c.expected, c.sourceMaterial]) {
          if (field) expect(hasUnfilledSlots(field), `${c.id}: ${field}`).toBe(false);
        }
        if (c.twinOf) {
          const twin = cases.find((x) => x.id === c.twinOf)!;
          // The injection output contains its twin's output verbatim, so the
          // only difference between the pair is the injected instruction.
          expect(c.output.includes(twin.output), `${c.id} must contain ${twin.id} output`).toBe(true);
          expect(c.injection && c.output.includes(c.injection)).toBe(true);
        }
      }
    });
  }
});

describe('citation proof case file', () => {
  it('cases.json is valid', async () => {
    const file = await readCitationCaseFile(repoRoot);
    const issues = validateCitationCaseFile(file);
    expect(issues, issues.join('\n')).toEqual([]);
  });

  it('every labelled citation is exactly what the real extractor produces', async () => {
    const file = await readCitationCaseFile(repoRoot);
    for (const c of file.cases) {
      const found = extractCitations(c.output)
        .map((x) => `${x.kind}:${x.identifier}`)
        .sort();
      const labelled = c.citations.map((x) => `${x.kind}:${x.identifier}`).sort();
      expect(found, `case ${c.id}`).toEqual(labelled);
    }
  });

  it('has at least one case in each resolve class', async () => {
    const file = await readCitationCaseFile(repoRoot);
    const all = file.cases.flatMap((c) => c.citations);
    expect(all.some((l) => l.resolve === 'ok' && l.supported === true)).toBe(true);
    expect(all.some((l) => l.resolve === 'ok' && l.supported === false)).toBe(true);
    expect(all.some((l) => l.resolve === 'error')).toBe(true);
    expect(all.some((l) => l.resolve === 'skipped')).toBe(true);
  });
});

describe('materialise', () => {
  it('is deterministic for a given seed', () => {
    const a = slotsFor('accuracy-violation-07');
    const b = slotsFor('accuracy-violation-07');
    expect(a).toEqual(b);
  });

  it('produces different values for different seeds', () => {
    expect(slotsFor('seed-a').name).not.toBe(slotsFor('seed-b-different').name);
  });

  it('fills known slots and leaves unknown ones for the validator to catch', () => {
    const out = materialise('Contact {{name}} at {{email}} — {{unknown_slot}}', 'seed-x');
    expect(out).not.toContain('{{name}}');
    expect(out).not.toContain('{{email}}');
    expect(out).toContain('{{unknown_slot}}');
    expect(hasUnfilledSlots(out)).toBe(true);
  });

  it('generates only documentation-safe synthetic identifiers', () => {
    const s = slotsFor('anything');
    expect(s.email).toMatch(/\.example$/); // RFC 2606 reserved TLD, never resolves
    expect(s.phone).toMatch(/^555-01\d{2}$/); // reserved fictional block
    expect(s.api_key).toMatch(/^irk_[0-9a-f]{32}$/); // made-up prefix no provider issues
  });
});
