/*
 * Scores a human's plain-language review of the blind sample against what the
 * SHIPPED RULES ACTUALLY DO.
 *
 * The other half of this tool, `proof/blind-sample.mjs --score`, compares a
 * reviewer's answer to the corpus label. That question is "is this case
 * labelled correctly", and answering it means reading the rule's definition,
 * thresholds and config keys. It is the right question for someone who has
 * read the code.
 *
 * It is the wrong question for everybody else, and everybody else is the point.
 * The corpus was written by a language model and graded by the same model
 * family. What that cannot establish is whether the rules encode the right
 * thing — whether the outputs Iris stays quiet about are outputs a person
 * would have wanted to hear about. Only somebody outside the code can say
 * that, and asking them to first learn `max_tool_repeats` disqualifies the
 * very reviewer whose answer is worth having.
 *
 * So this scorer asks nothing about definitions. The reviewer answers one
 * question per case, in their own words' terms — would you want to be told
 * about this? — and every case is then run through the real rule registry, the
 * same objects the engine uses. The disagreements are the product's, not the
 * reviewer's:
 *
 *   MISS         the reviewer would want to be told; Iris said nothing.
 *                A gap. The most expensive kind, because it is invisible in
 *                production: nobody files a bug for an alarm that never rang.
 *
 *   FALSE ALARM  Iris flagged it; the reviewer would not have cared.
 *                A tax. Every one of these is a human dismissing a warning,
 *                and enough of them train people to dismiss all of them.
 *
 * Neither is a mistake by the reviewer. There is no answer key here.
 *
 *   npx tsx proof/human-review.ts <answers.json>
 *   npx tsx proof/human-review.ts <answers.json> --json
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { loadCorpus, type CorpusFile } from './lib/corpus.js';
import { materialiseCase } from './lib/materialise.js';
import { registryRules, contextFor } from './run.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

export type Verdict = 'fail' | 'pass' | 'unsure' | null;
export interface AnswerSheet {
  sample?: string;
  mode?: string;
  answers: Array<{ id: string; verdict: Verdict }>;
}

export interface ReviewRow {
  id: string;
  rule: string;
  /** The reviewer would want to be told about this output. */
  human: boolean;
  /** The shipped rule actually fired on this output. */
  iris: boolean;
  /** The rule declined to judge (no trajectory, no cost, no expected text). */
  skipped: boolean;
  outcome: 'agree-flag' | 'agree-quiet' | 'miss' | 'false-alarm';
}

export interface ReviewReport {
  answered: number;
  unsure: number;
  agree: number;
  misses: ReviewRow[];
  falseAlarms: ReviewRow[];
  rows: ReviewRow[];
}

/** Runs every answered case through the real registry and classifies each one. */
export async function review(sheet: AnswerSheet): Promise<ReviewReport> {
  const { files } = await loadCorpus(ROOT);
  const rules = new Map(registryRules().map((r) => [r.name, r]));

  const cases = new Map<string, { fam: CorpusFile; raw: CorpusFile['cases'][number] }>();
  for (const fam of files) for (const raw of fam.cases) cases.set(raw.id, { fam, raw });

  const answered = sheet.answers.filter((a) => a.verdict === 'fail' || a.verdict === 'pass');
  const rows: ReviewRow[] = answered.map((a) => {
    const found = cases.get(a.id);
    if (!found) throw new Error(`answer references unknown case id ${a.id}`);
    const rule = rules.get(found.fam.rule);
    if (!rule) throw new Error(`corpus family names a rule not in the registry: ${found.fam.rule}`);

    const c = materialiseCase(found.raw);
    const result = rule.evaluate(contextFor(c, found.fam.config));
    const skipped = result.skipped === true;
    const iris = !skipped && result.passed === false;
    const human = a.verdict === 'fail';

    const outcome: ReviewRow['outcome'] = human
      ? iris
        ? 'agree-flag'
        : 'miss'
      : iris
        ? 'false-alarm'
        : 'agree-quiet';
    return { id: a.id, rule: found.fam.rule, human, iris, skipped, outcome };
  });

  return {
    answered: rows.length,
    unsure: sheet.answers.length - rows.length,
    agree: rows.filter((r) => r.outcome === 'agree-flag' || r.outcome === 'agree-quiet').length,
    misses: rows.filter((r) => r.outcome === 'miss'),
    falseAlarms: rows.filter((r) => r.outcome === 'false-alarm'),
    rows,
  };
}

function render(r: ReviewReport): string {
  const pct = r.answered ? ((r.agree / r.answered) * 100).toFixed(1) : '0.0';
  const L: string[] = [];
  L.push('');
  L.push('Human review of the blind sample — reviewer judgement vs the shipped rules');
  L.push('');
  L.push(`  reviewed        ${r.answered}${r.unsure ? `  (${r.unsure} marked unsure, excluded)` : ''}`);
  L.push(`  Iris agreed     ${r.agree}  (${pct}%)`);
  L.push(`  missed          ${r.misses.length}  — the reviewer wanted to be told, Iris said nothing`);
  L.push(`  false alarms    ${r.falseAlarms.length}  — Iris flagged it, the reviewer would not have cared`);
  L.push('');

  const group = (rows: ReviewRow[]) => {
    const m = new Map<string, string[]>();
    for (const row of rows) m.set(row.rule, [...(m.get(row.rule) ?? []), row.id]);
    return [...m].sort((a, b) => b[1].length - a[1].length);
  };

  if (r.misses.length) {
    L.push('MISSES — a gap in the product. Nobody reports these in production, because');
    L.push('the alarm simply never rings.');
    L.push('');
    for (const [rule, ids] of group(r.misses)) L.push(`  ${rule}  (${ids.length}): ${ids.join(', ')}`);
    L.push('');
  }
  if (r.falseAlarms.length) {
    L.push('FALSE ALARMS — a tax on whoever reads the output. Each one is a person');
    L.push('dismissing a warning, and enough of them train people to dismiss all of them.');
    L.push('');
    for (const [rule, ids] of group(r.falseAlarms)) L.push(`  ${rule}  (${ids.length}): ${ids.join(', ')}`);
    L.push('');
  }
  if (!r.misses.length && !r.falseAlarms.length) {
    L.push('No disagreements. On this sample the rules flag what a person would want');
    L.push('flagged and stay quiet about the rest.');
    L.push('');
  }
  L.push('This is not a score for the reviewer. Every disagreement is Iris to fix.');
  L.push('');
  return L.join('\n');
}

const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  const path = process.argv[2];
  if (!path || path.startsWith('--')) {
    process.stderr.write('usage: npx tsx proof/human-review.ts <answers.json> [--json]\n');
    process.exit(2);
  }
  const sheet = JSON.parse(readFileSync(path, 'utf-8')) as AnswerSheet;
  const report = await review(sheet);
  if (process.argv.includes('--json')) {
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } else {
    process.stdout.write(render(report));
  }
}

export { render, ROOT as PROOF_ROOT };
