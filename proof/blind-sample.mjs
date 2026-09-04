#!/usr/bin/env node
/**
 * Draw a stratified, reproducible sample of corpus cases for blind human
 * labelling, and score a returned answer sheet against the corpus gold labels.
 *
 * The corpus is LLM-authored and LLM-labelled. That is disclosed everywhere the
 * numbers appear, and it is the single biggest caveat on them: a rule measured
 * against labels from the same model family that wrote the cases can look
 * accurate while both sides share a blind spot. Human agreement on a sample is
 * what turns "the model agrees with itself" into "a person agrees with the
 * definition". This script is the sampling half.
 *
 *   node proof/blind-sample.mjs                  # write proof/blind-sample.json
 *   node proof/blind-sample.mjs --score ans.json # score an answer sheet
 *
 * The sample manifest carries case ids in a fixed shuffled order and the seed
 * that produced it. It carries NO labels — that is the point. Anyone can
 * regenerate the identical sample from the seed, and anyone can check our
 * scoring by rerunning it against the public corpus.
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, 'corpus');
const MANIFEST = join(HERE, 'blind-sample.json');
const SEED = 20260904;
const TARGET = 40;

/** Deterministic PRNG so the same seed always draws the same sample. */
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const shuffle = (arr, rnd) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

export function loadCorpus() {
  const families = readdirSync(CORPUS)
    .filter((f) => f.endsWith('.json'))
    .sort();
  return families.map((f) => JSON.parse(readFileSync(join(CORPUS, f), 'utf8')));
}

/**
 * The judgment families. A blind human label is only informative where the
 * label is an OPINION. Seven of the fifteen rules are arithmetic — a character
 * count, a token ratio, a cost against a threshold, a share of overlapping
 * terms — and a person asked to eyeball "is at least 35% of the input's
 * vocabulary present" is being asked to do long division, not to judge. A
 * disagreement there would mean the annotator miscounted, which tells us
 * nothing about whether the rule is right. Those families are verified a
 * different way, by the definition tests in the suite. Human agreement is
 * spent on the seven rules where two careful people can genuinely disagree.
 */
export const JUDGMENT_RULES = [
  'no_pii',
  'no_injection_patterns',
  'no_hallucination_markers',
  'no_stub_output',
  'no_blocklist_words',
  'no_silent_tool_failure',
  'no_tool_loop',
];

/**
 * Stratified draw over the judgment families: positives and negatives
 * alternate within each family, and the four large families carry more of the
 * sample because they are where the ambiguity lives.
 */
export function drawSample(corpus, seed = SEED, target = TARGET) {
  const rnd = mulberry32(seed);
  const fams = corpus
    .filter((f) => JUDGMENT_RULES.includes(f.rule))
    .sort((a, b) => a.rule.localeCompare(b.rule));
  if (fams.length !== JUDGMENT_RULES.length) {
    throw new Error(`expected ${JUDGMENT_RULES.length} judgment families, found ${fams.length}`);
  }
  const big = fams.filter((f) => f.cases.length >= 80);
  const quota = new Map(fams.map((f) => [f.rule, 4]));
  let remaining = target - fams.length * 4;
  for (let i = 0; remaining > 0; i++, remaining--) {
    const r = big[i % big.length].rule;
    quota.set(r, quota.get(r) + 1);
  }
  const picked = [];
  for (const f of fams) {
    const n = quota.get(f.rule);
    const pos = shuffle(
      f.cases.filter((c) => c.label === 'positive'),
      rnd,
    );
    const neg = shuffle(
      f.cases.filter((c) => c.label === 'negative'),
      rnd,
    );
    for (let i = 0; i < n; i++) {
      const pool = i % 2 === 0 ? pos : neg;
      const alt = i % 2 === 0 ? neg : pos;
      const c = pool.shift() ?? alt.shift();
      if (c) picked.push(c.id);
    }
  }
  if (picked.length !== target) throw new Error(`drew ${picked.length}, wanted ${target}`);
  return {
    seed,
    target,
    families: JUDGMENT_RULES.slice(),
    drawnAt: null,
    ids: shuffle(picked, rnd),
  };
}

function score(answerPath) {
  const corpus = loadCorpus();
  const byId = new Map();
  for (const f of corpus)
    for (const c of f.cases) byId.set(c.id, { ...c, positiveClass: f.positiveClass });
  const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const answers = JSON.parse(readFileSync(answerPath, 'utf8'));
  const rows = (answers.answers ?? answers).filter((a) => a.verdict && a.verdict !== 'unsure');
  const unsure = (answers.answers ?? answers).length - rows.length;

  let agree = 0;
  const disagreements = [];
  for (const a of rows) {
    const c = byId.get(a.id);
    if (!c) throw new Error(`answer references unknown case id ${a.id}`);
    // A human "fail" verdict means the output should trip the rule = the
    // corpus positive class. Compare on that, not on the word.
    const human = a.verdict === 'fail' ? 'positive' : 'negative';
    if (human === c.label) agree++;
    else disagreements.push({ id: a.id, rule: c.rule, gold: c.label, human, notes: c.notes });
  }
  // The annotator's own opinion of the rule, kept separate from the verdict on
  // purpose. A flagged case is NOT a disagreement: the annotator judged the
  // rule as written, agreed with the corpus, and then said the rule is written
  // wrong. That is the most actionable thing this exercise produces, so it is
  // reported even when agreement is 100%.
  const flagged = (answers.answers ?? answers)
    .filter((a) => a.ruleWrong)
    .map((a) => ({ id: a.id, rule: byId.get(a.id)?.rule ?? '?', verdict: a.verdict }));
  const n = rows.length;
  const pct = n ? ((agree / n) * 100).toFixed(1) : '0.0';
  console.log(
    `\nBlind label agreement — sample seed ${manifest.seed}, ${manifest.ids.length} cases drawn`,
  );
  console.log(`  answered   ${n}${unsure ? `  (${unsure} marked unsure, excluded)` : ''}`);
  console.log(`  agree      ${agree}`);
  console.log(`  agreement  ${pct}%`);
  console.log(`  rule flagged as wrong  ${flagged.length}\n`);
  if (disagreements.length) {
    console.log(
      'Disagreements — each one is either a mislabelled case or a definition that needs rewriting:\n',
    );
    for (const d of disagreements) {
      console.log(`  ${d.id}  [${d.rule}]  corpus says ${d.gold}, human says ${d.human}`);
      if (d.notes) console.log(`      corpus reasoning: ${String(d.notes).slice(0, 220)}`);
    }
    console.log('');
  }
  if (flagged.length) {
    const byRule = new Map();
    for (const f of flagged) byRule.set(f.rule, [...(byRule.get(f.rule) ?? []), f.id]);
    console.log(
      'Rules the annotator says are written wrong. These are product decisions, not label errors:\n',
    );
    for (const [rule, ids] of [...byRule].sort((a, b) => b[1].length - a[1].length)) {
      console.log(`  ${rule}  (${ids.length}): ${ids.join(', ')}`);
    }
    console.log('');
  }
  return { n, agree, disagreements, flagged };
}

// CLI only. The test suite imports drawSample/loadCorpus, and an import that
// rewrites a committed file would make the determinism test verify its own
// output instead of the manifest in the tree.
const invokedDirectly =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
const arg = invokedDirectly ? process.argv[2] : undefined;
if (!invokedDirectly) {
  // imported as a module — export only
} else if (arg === '--score') {
  const p = process.argv[3];
  if (!p) {
    console.error('usage: node proof/blind-sample.mjs --score <answers.json>');
    process.exit(2);
  }
  score(p);
} else if (arg === '--check') {
  const fresh = drawSample(loadCorpus());
  const committed = JSON.parse(readFileSync(MANIFEST, 'utf8'));
  const same = JSON.stringify(fresh.ids) === JSON.stringify(committed.ids);
  console.log(
    same
      ? 'blind sample manifest matches a fresh draw'
      : 'DRIFT: manifest does not match a fresh draw from the same seed',
  );
  process.exit(same ? 0 : 1);
} else {
  const s = drawSample(loadCorpus());
  s.drawnAt = new Date().toISOString().slice(0, 10);
  s.note =
    'Case ids only, in presentation order. No labels: this manifest is meant to be safe to hand to a labeller. Regenerate with `node proof/blind-sample.mjs`; verify with `--check`.';
  writeFileSync(MANIFEST, JSON.stringify(s, null, 2) + '\n');
  console.log(`wrote ${MANIFEST} — ${s.ids.length} cases`);
}
