/*
 * The evaluator-of-evaluators matrix is derived, not typed (arc 2, M5).
 *
 * Twenty-six evaluators by thirteen questions; every status in the
 * vocabulary; every `measured` cell's evidence points at a committed proof
 * file and, where it names a key, the key exists; the count every surface
 * quotes equals what the generator computes from the files on disk; and the
 * arc-2 bar — at least fifteen evaluators with three or more questions
 * measured — holds from the files, not from prose.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { generate, QUESTIONS, STATUSES, GROUPS } from '../scripts/claims/generators/evaluators.mjs';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');

interface Cell {
  status: string;
  evidence?: string;
  note?: string;
}
interface Evaluator {
  id: string;
  group: string;
  name: string;
  cells: Record<string, Cell>;
  measured: number;
}
interface Matrix {
  evaluators: Evaluator[];
  counts: { evaluators: number; questions: number; measuredThreeOrMore: number; byGroup: Record<string, { evaluators: number; measuredThreeOrMore: number }> };
  questions: typeof QUESTIONS;
}

describe('evaluator-of-evaluators matrix', () => {
  it('has one evaluator per registered rule, custom type and judge template plus the verifier and the composer, thirteen questions each, every status in the vocabulary', async () => {
    const m = (await generate()) as Matrix;
    const claims = JSON.parse(await readFile(resolve(root, '.claims.json'), 'utf-8')) as { evalRules: { builtInCount: number; customRuleTypeCount: number }; llmJudgeTemplates: { count: number } };
    // Arc zero's matrix said 26 by grouping the custom types; the generator counts each registered thing once.
    expect(m.counts.evaluators).toBe(claims.evalRules.builtInCount + claims.evalRules.customRuleTypeCount + claims.llmJudgeTemplates.count + 2);
    expect(m.counts.questions).toBe(13);
    expect(m.questions.map((q) => q.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(new Set(m.evaluators.map((e) => e.group))).toEqual(new Set(GROUPS.map((g) => g.id)));
    expect(m.counts.byGroup.rules.evaluators).toBe(15);
    expect(m.counts.byGroup.custom.evaluators).toBe(8);
    expect(m.counts.byGroup.judge.evaluators).toBe(5);
    for (const e of m.evaluators) {
      expect(Object.keys(e.cells).sort()).toEqual(QUESTIONS.map((q) => q.id).sort());
      for (const [q, c] of Object.entries(e.cells)) {
        expect(STATUSES, `${e.id} ${q} status ${c.status}`).toContain(c.status);
        if (c.status === 'measured') expect(c.evidence, `${e.id} ${q} measured without evidence`).toBeTruthy();
      }
    }
  });

  it('every measured cell points at a committed proof file, and a named rule or type key exists there', async () => {
    const m = (await generate()) as Matrix;
    const results = JSON.parse(await readFile(resolve(root, 'proof/results.json'), 'utf-8')) as {
      rules: Array<{ name: string }>;
      custom: { types: Array<{ type: string }> };
      transforms: { rows: Array<{ rule: string; n: number }> };
    };
    const composite = JSON.parse(await readFile(resolve(root, 'proof/composite-results.json'), 'utf-8')) as { perClass: Array<{ class: string; present: number }> };
    const ruleNames = new Set(results.rules.map((r) => r.name));
    const typeNames = new Set(results.custom.types.map((t) => t.type));
    for (const e of m.evaluators) {
      for (const [q, c] of Object.entries(e.cells)) {
        if (c.status !== 'measured') continue;
        const ev = c.evidence!;
        const fileBacked = /^proof\/(results|composite-results|judge-results)\.json/.test(ev) || /npm run proof -- --check/.test(ev);
        expect(fileBacked, `${e.id} ${q}: ${ev}`).toBe(true);
        const rule = ev.match(/rules\[([a-z_]+)\]/);
        if (rule) expect(ruleNames.has(rule[1]), `${e.id} ${q}: rule ${rule[1]}`).toBe(true);
        const type = ev.match(/custom\.types\[([a-z_]+)\]/);
        if (type) expect(typeNames.has(type[1]), `${e.id} ${q}: type ${type[1]}`).toBe(true);
        const transform = ev.match(/transforms\.rows\[rule=([a-z_]+)\]/);
        if (transform) expect(results.transforms.rows.some((r) => r.rule === transform[1] && r.n > 0), `${e.id} ${q}: transforms for ${transform[1]}`).toBe(true);
        const perClass = ev.match(/perClass\[([a-z_, ]+)\]/);
        if (perClass) for (const cls of perClass[1].split(', ')) expect(composite.perClass.some((p) => p.class === cls && p.present > 0), `${e.id} ${q}: class ${cls}`).toBe(true);
      }
    }
  });

  it('the arc-2 bar holds from the files: at least fifteen evaluators with three or more questions measured, and the committed truthbase agrees', async () => {
    const m = (await generate()) as Matrix;
    expect(m.counts.measuredThreeOrMore).toBeGreaterThanOrEqual(15);
    for (const e of m.evaluators) expect(e.measured).toBe(Object.values(e.cells).filter((c) => c.status === 'measured').length);
    const committed = JSON.parse(await readFile(resolve(root, '.claims.json'), 'utf-8')) as { evaluators: Matrix };
    expect(committed.evaluators.counts).toEqual(m.counts);
    expect(committed.evaluators.evaluators.map((e) => [e.id, e.measured])).toEqual(m.evaluators.map((e) => [e.id, e.measured]));
  });

  it('the judge rows stay measurable, not measured, while proof/judge-results.json is pending', async () => {
    const judge = JSON.parse(await readFile(resolve(root, 'proof/judge-results.json'), 'utf-8')) as { status: string };
    const m = (await generate()) as Matrix;
    for (const e of m.evaluators.filter((x) => x.group === 'judge' || x.group === 'citations')) {
      const measuredCells = Object.values(e.cells).filter((c) => c.status === 'measured').length;
      if (judge.status === 'pending') expect(measuredCells, e.id).toBe(0);
    }
  });
});
