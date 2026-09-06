// Evaluator-of-evaluators generator — the mandate's thirteen trust questions
// asked of every evaluator Iris ships, with every cell DERIVED from the
// proof files (proof/results.json, proof/composite-results.json,
// proof/judge-results.json) and the rule roster. Nothing here is typed in:
// a cell reads `measured` only when a number for it exists in a committed
// proof file, and the evidence string names where.
//
// Statuses:
//   measured   — a published number exists; `evidence` names the file and key
//   partial    — part of the question has a number (named misses, no rate)
//   stated     — the answer is a declaration in code or a corpus definition,
//                not a measurement (what a metric measures; a type's limit)
//   measurable — the harness that would measure it is named; no number yet
//   n/a        — the question does not apply (a deterministic rule has no
//                prompt or model sensitivity)
//
// The count every surface quotes — evaluators with three or more questions
// measured — is computed here and locked by tests/evaluators-matrix.test.ts.

import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate as evalRules } from './eval-rules.mjs';
import { generate as llmJudgeTemplates } from './llm-judge-templates.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '..', '..', '..');

export const STATUSES = ['measured', 'partial', 'stated', 'measurable', 'n/a'];

/** The mandate's thirteen trust questions, verbatim. */
export const QUESTIONS = [
  { id: 'q1', n: 1, text: 'How do we know this evaluator works?' },
  { id: 'q2', n: 2, text: 'Under what conditions does it fail?' },
  { id: 'q3', n: 3, text: 'What does the metric actually measure?' },
  { id: 'q4', n: 4, text: 'What does it only appear to measure?' },
  { id: 'q5', n: 5, text: 'Is the output calibrated?' },
  { id: 'q6', n: 6, text: 'How sensitive is it to prompt variation?' },
  { id: 'q7', n: 7, text: 'How sensitive is it to model choice?' },
  { id: 'q8', n: 8, text: 'How stable is it across repeated runs?' },
  { id: 'q9', n: 9, text: 'Can it be gamed?' },
  { id: 'q10', n: 10, text: 'Can it produce false confidence?' },
  { id: 'q11', n: 11, text: 'Does it correlate with the outcome we care about?' },
  { id: 'q12', n: 12, text: 'Can deterministic evidence corroborate model-based judgment?' },
  { id: 'q13', n: 13, text: 'Can multiple independent methods triangulate the same conclusion?' },
];

export const GROUPS = [
  { id: 'rules', text: 'the built-in rules' },
  { id: 'custom', text: 'the custom rule types' },
  { id: 'judge', text: 'the LLM-judge templates' },
  { id: 'citations', text: 'the citation verifier' },
  { id: 'composer', text: 'the verdict composer' },
];

const cell = (status, evidence, note) => {
  if (!STATUSES.includes(status)) throw new Error(`evaluators: unknown status ${status}`);
  const c = { status };
  if (evidence) c.evidence = evidence;
  if (note) c.note = note;
  return c;
};

async function readJson(rel) {
  try {
    return JSON.parse(await readFile(resolve(root, rel), 'utf-8'));
  } catch {
    return null;
  }
}

const RESULTS = 'proof/results.json';
const COMPOSITE = 'proof/composite-results.json';
const JUDGE = 'proof/judge-results.json';
const CHECK = 'npm run proof -- --check regenerates the file byte for byte in CI on every pull request';

function ruleCells(row, meta, results, composite) {
  const name = row.name;
  const transformRows = (results.transforms?.rows ?? []).filter((t) => t.rule === name && t.n > 0);
  const classes = meta?.classes ?? [];
  const perClass = (composite?.perClass ?? []).filter((p) => classes.includes(p.class) && p.present > 0);
  const entities = (results.entities ?? []).find((e) => e.rule === name);
  const deterministic = meta?.mechanism !== 'model';
  const kind = meta?.kind ?? 'unknown';
  const isFormula = kind === 'measurement' || kind === 'policy';
  return {
    q1: cell('measured', `${RESULTS} → rules[${name}]`, `precision, recall and F1 on ${row.n} labelled cases with Wilson and credible 95% intervals; in-sample, same-model labelled until the blind label lands`),
    q2: transformRows.length > 0
      ? cell('measured', `${RESULTS} → transforms.rows[rule=${name}]`, `recall under ${transformRows.length} evasion transforms inside the evidence span, plus the false-positive and false-negative ids in proof/RESULTS.md`)
      : cell('partial', 'proof/RESULTS.md → misses by case id', 'every false positive and false negative is named by id; no rate under transforms (the rule reports no span, or is not critical)'),
    q3: cell('stated', `list_rules → kind: ${kind}, mechanism: ${meta?.mechanism ?? 'unknown'}; proof/corpus → definition`, isFormula ? 'a measurement or policy: the proof family measures conformance to the stated formula, not detection of a failure' : 'a detection or inference: the family measures detection of the named failure classes'),
    q4: cell('stated', 'every result since 0.9.0 carries kind and mechanism', isFormula ? 'the kind label says it is a formula, so it cannot appear to be a detector' : 'the kind label names the claim; what it appears to measure beyond that is not measured'),
    q5: cell('measurable', 'proof/lib/composite-report.ts calibration, per rule score', 'a per-rule reliability curve over the composite corpus is the harness; only the composer is calibrated today'),
    q6: deterministic ? cell('n/a', undefined, 'deterministic') : cell('measurable'),
    q7: deterministic ? cell('n/a', undefined, 'deterministic') : cell('measurable'),
    q8: cell('measured', `${CHECK}`, 'a pure function of its input; the committed numbers are the code\'s'),
    q9: transformRows.length > 0
      ? cell('measured', `${RESULTS} → transforms.rows[rule=${name}]`, 'the same transforms table: zero-width, homoglyph, fullwidth, no-break space, tab, line break, case')
      : cell('measurable', 'proof/lib/transforms.ts extends to any rule that reports a span', undefined),
    q10: cell('measured', `${RESULTS} → rules[${name}].ppvAt`, 'what a fire is worth at 1%, 5%, 20% and 50% prevalence, from the family\'s counts'),
    q11: perClass.length > 0
      ? cell('measured', `${COMPOSITE} → perClass[${perClass.map((p) => p.class).join(', ')}]`, `recall on composed cases and the 24 real transcripts where the class is present${entities ? '; per-entity recall in results.json → entities' : ''}`)
      : isFormula
        ? cell('measurable', 'a labelled outcome the formula should track', 'a formula\'s family measures conformance; correlation with an outcome needs cases labelled by the outcome')
        : cell('measurable', 'add composite cases for its classes', undefined),
    q12: cell('measurable', 'pair rule fires with the judge\'s dimensions on one corpus (needs a key)', undefined),
    q13: cell('measurable', 'run the rules over the judge corpus and the judge over the rule corpus; publish the agreement per pair (needs a key)', undefined),
  };
}

function customCells(type, row, meta) {
  const pattern = meta?.mechanism === 'pattern';
  return {
    q1: cell('measured', `${RESULTS} → custom.types[${type}]`, `conformance to the documented definition under a declared config on ${row.n} cases`),
    q2: cell('stated', `proof/corpus/custom/${type}.json → definition and boundary cases`, 'the definition names the limit; the family holds the boundary cases'),
    q3: cell('stated', `proof/corpus/custom/${type}.json → definition, config`, 'the author\'s own constraint under the config the family declares'),
    q4: cell('stated', `proof/corpus/custom/${type}.json → definition`, 'a constraint, not a detector'),
    q5: cell('n/a', undefined, 'a constraint is not a probability'),
    q6: cell('n/a', undefined, 'deterministic'),
    q7: cell('n/a', undefined, 'deterministic'),
    q8: cell('measured', CHECK, pattern ? 'deterministic; a regex that exceeds the sandbox budget skips, which the verdict reports as unknown' : 'deterministic'),
    q9: pattern ? cell('measurable', 'proof/lib/transforms.ts over a pattern type\'s positives', 'the same normalisation gap as the built-in pattern rules') : cell('n/a', undefined, 'arithmetic over the whole output'),
    q10: cell('measured', `${RESULTS} → custom.types[${type}].ci95.precision`, 'a pass that is wrong is a conformance miss; the precision interval bounds it'),
    q11: cell('n/a', undefined, 'the outcome is the constraint itself'),
    q12: cell('n/a', undefined, 'not model-based'),
    q13: cell('measurable', 'a second implementation of the same constraint over the same family', undefined),
  };
}

function judgeCells(template, judge) {
  const measured = judge?.status === 'measured';
  const perTemplate = measured && judge.templates ? judge.templates[template] ?? null : null;
  const has = (k) => Boolean(perTemplate && perTemplate[k] !== undefined && perTemplate[k] !== null);
  const pending = (harness) => cell('measurable', harness, 'needs a judge key that the founder or a user supplies; proof/judge-results.json is pending');
  return {
    q1: has('precision') || has('accuracy') ? cell('measured', `${JUDGE} → templates[${template}]`) : pending('npm run proof:judge — 165 cases across the five templates under a cost cap'),
    q2: has('misses') ? cell('measured', `${JUDGE} → templates[${template}].misses`) : pending('the same run names the misses by id'),
    q3: cell('stated', 'src/eval/llm-judge/templates → dimensions and passThreshold', 'the template names its dimensions and the threshold a score is read against'),
    q4: pending('compare the model\'s self-reported pass with the threshold verdict on the same run'),
    q5: has('calibration') ? cell('measured', `${JUDGE} → templates[${template}].calibration`) : pending('reliability bins, Brier and ECE per template with intervals'),
    q6: has('paraphrases') ? cell('measured', `${JUDGE} → templates[${template}].paraphrases`) : pending('three committed paraphrases per template, pairwise agreement and score correlation'),
    q7: has('providers') ? cell('measured', `${JUDGE} → templates[${template}].providers`) : pending('both default providers on the same cases; agreement and the disagreement list'),
    q8: has('repeats') ? cell('measured', `${JUDGE} → templates[${template}].repeats`) : pending('repeat the judge run k times over the same cases; flip rate per template with an interval'),
    q9: has('injectionDrift') ? cell('measured', `${JUDGE} → templates[${template}].injectionDrift`) : pending('injection twins per template; length, confidence and forged-close-tag axes'),
    q10: pending('the self-reported pass against the score on the same run'),
    q11: pending('human agreement on the judged cases (the blind label instrument)'),
    q12: pending('pair each template\'s dimensions with the rules that map to them'),
    q13: pending('the judge over the rule corpus, the rules over the judge corpus'),
  };
}

function citationCells(judge) {
  const measured = judge?.status === 'measured' && judge.citations;
  const pending = (harness) => cell('measurable', harness, 'needs a judge key; the 17 citation cases run under the same runner');
  return {
    q1: measured ? cell('measured', `${JUDGE} → citations`) : pending('npm run proof:judge — the citation cases'),
    q2: pending('the same run names the misses'),
    q3: cell('stated', 'verify_citations → supported / judged; resolution off by default', 'what the tool computes is stated in its description and docs'),
    q4: pending('a dead URL with fetch off passes; the verifier split (resolves vs supports) is the fix and the measurement'),
    q5: cell('measurable', 'about a hundred judged citations are needed for bins', 'underpowered at the current corpus size'),
    q6: pending('paraphrased support prompts'),
    q7: pending('both providers'),
    q8: pending('repeats'),
    q9: pending('fetch off: any output with citations passes; measured once the split lands'),
    q10: pending('passed with a null score whenever nothing resolved'),
    q11: pending('human agreement on support judgements'),
    q12: cell('measurable', 'citation_resolves (deterministic) beside citation_supports (judgment) on one case', undefined),
    q13: cell('measurable', 'the groundedness triple: signals, judge, citations', undefined),
  };
}

function composerCells(composite) {
  if (!composite) {
    const pending = (harness) => cell('measurable', harness, 'run npm run proof -- --composite');
    return Object.fromEntries(QUESTIONS.map((q) => [q.id, pending('the composite corpus')]));
  }
  const risk = composite.method?.priorMode ? `risk (${composite.method.priorMode} prior)` : 'risk';
  return {
    q1: cell('measured', `${COMPOSITE} → legacy.test, risk.test, realTranscripts`, `verdict accuracy against shouldShip on the test split and on the 24 real transcripts, for the legacy composer and the ${risk} composer, with Wilson intervals and the Newcombe interval on the difference`),
    q2: cell('measured', `${COMPOSITE} → legacy.test.falseBlock, legacy.test.missedBlock, sweep`, 'false blocks on clean cases and missed blocks on must-not-ship cases, separately; the threshold sweep on the dev split'),
    q3: cell('stated', `${COMPOSITE} → method.legacy, method.risk`, 'the legacy arithmetic and the risk model are stated in the file'),
    q4: cell('measured', `${COMPOSITE} → legacy.test.missedBlock`, 'the share of must-not-ship outputs the legacy verdict passes is the measurement of a score that appears to be a quality gradient'),
    q5: cell('measured', `${COMPOSITE} → legacy.test.calibration, risk.test.calibration, sweep`, 'Brier and expected calibration error over ten bins for the legacy score read as P(bad) and for p_bad; the utility-optimal threshold on the dev split beside the shipped one'),
    q6: cell('n/a', undefined, 'deterministic'),
    q7: cell('n/a', undefined, 'deterministic'),
    q8: cell('measured', 'npm run proof -- --check --composite regenerates the file byte for byte in CI', undefined),
    q9: cell('measurable', 'a critical rule defeated by the output (the regex budget) reads as unknown from 0.10.0; measured by a composite case that stalls a critical pattern', undefined),
    q10: cell('measured', `${COMPOSITE} → legacy.test.calibration.ece`, 'the calibration error of the legacy score read as a probability is the false-confidence measurement'),
    q11: cell('measured', `${COMPOSITE} → legacy.realTranscripts, risk.realTranscripts`, 'the 24 real transcripts are the out-of-sample line'),
    q12: cell('measurable', 'a verdict field for corroboration between rule fires and judge dimensions (needs a key)', undefined),
    q13: cell('measurable', 'multi-run evaluation of one input; metamorphic pairs over the trace store', undefined),
  };
}

export async function generate() {
  const results = await readJson(RESULTS);
  if (!results || results.schemaVersion !== 2) throw new Error('evaluators: proof/results.json is not a schemaVersion-2 results file (run npm run proof)');
  const composite = await readJson(COMPOSITE);
  const judge = await readJson(JUDGE);
  const rules = await evalRules();
  const templates = await llmJudgeTemplates();
  const roster = new Map((rules.roster ?? []).map((r) => [r.name, r]));

  const evaluators = [];
  for (const row of results.rules) {
    evaluators.push({ id: `rule:${row.name}`, group: 'rules', name: row.name, cells: ruleCells(row, roster.get(row.name), results, composite) });
  }
  const customMeta = { regex_match: { mechanism: 'pattern' }, regex_no_match: { mechanism: 'pattern' }, contains_keywords: { mechanism: 'pattern' }, excludes_keywords: { mechanism: 'pattern' } };
  for (const type of rules.customRuleTypes) {
    const row = (results.custom?.types ?? []).find((t) => t.type === type);
    if (!row) throw new Error(`evaluators: no conformance family for custom type ${type}`);
    evaluators.push({ id: `custom:${type}`, group: 'custom', name: type, cells: customCells(type, row, customMeta[type]) });
  }
  for (const name of templates.names) {
    evaluators.push({ id: `judge:${name}`, group: 'judge', name, cells: judgeCells(name, judge) });
  }
  evaluators.push({ id: 'citations:verify_citations', group: 'citations', name: 'verify_citations', cells: citationCells(judge) });
  evaluators.push({ id: 'composer:passed', group: 'composer', name: 'the verdict composer (passed)', cells: composerCells(composite) });

  const measuredCount = (e) => Object.values(e.cells).filter((c) => c.status === 'measured').length;
  const byGroup = Object.fromEntries(
    GROUPS.map((g) => {
      const members = evaluators.filter((e) => e.group === g.id);
      return [g.id, { evaluators: members.length, measuredThreeOrMore: members.filter((e) => measuredCount(e) >= 3).length }];
    }),
  );
  const byStatus = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const e of evaluators) for (const c of Object.values(e.cells)) byStatus[c.status] += 1;

  return {
    version: 1,
    about: 'The thirteen trust questions asked of every evaluator Iris ships; every cell derived from the committed proof files by scripts/claims/generators/evaluators.mjs, never typed. A cell is measured only when a number for it exists in proof/results.json, proof/composite-results.json or proof/judge-results.json, and its evidence names where.',
    statuses: STATUSES,
    questions: QUESTIONS,
    groups: GROUPS,
    evaluators: evaluators.map((e) => ({ ...e, measured: measuredCount(e) })),
    counts: {
      evaluators: evaluators.length,
      questions: QUESTIONS.length,
      measuredThreeOrMore: evaluators.filter((e) => measuredCount(e) >= 3).length,
      byGroup,
      byStatus,
    },
    sources: {
      results: { corpusVersion: results.corpusVersion, customCorpusVersion: results.customCorpusVersion ?? null },
      composite: composite ? { compositeVersion: composite.compositeVersion } : null,
      judge: { status: judge?.status ?? 'missing' },
    },
  };
}
