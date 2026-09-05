/*
 * `npm run proof -- --composite` — scores the VERDICT on the composite corpus.
 *
 * For every composite case the real engine runs `evaluateAll` under the
 * shipped defaults, and three composers read the same rule results:
 *
 *   legacy            — today's arithmetic: `passed` (score ≥ threshold and
 *                       no critical failure), as the tool returns it
 *   risk (per-output) — arc 3's composer, in the harness only
 *                       (src/eval/risk.ts, the module the product uses): gates, then vetoes, then p_bad
 *                       against τ = 1 / (1 + c), with the prior read as
 *                       "this output is bad" and spread over the classes
 *                       the detectors examine
 *   risk (per-class)  — the same composer with the prior read as plan §4.3
 *                       wrote it, per class — measured because it is what
 *                       the plan specified, and reported because it blocks
 *                       nearly everything (the finding arc 3 deliberates on)
 *
 * Against `shouldShip` (true by construction or by a human label) each gets
 * an accuracy with a Wilson interval, the false-block rate on clean cases,
 * the missed-block rate, and calibration (Brier, ECE, ten bins) — the legacy
 * score read as P(bad) = 1 − score, the risk as p_bad. Each risk variant's
 * accuracy difference from legacy carries the Newcombe interval. Per class:
 * recall (class present → some mapped detector fired). The 24 real
 * transcripts are reported as their own out-of-sample line. The threshold
 * sweep runs on the dev split only, for the default variant; every headline
 * number is the test split; the shipped τ stays the loss-derived 0.5 and the
 * sweep's argmax is published as a check on the loss model, never adopted.
 *
 * Writes proof/composite-results.json and proof/COMPOSITE.md; `--check
 * --composite` regenerates both to a temp path and fails on any difference.
 */
import type { EvalResult, FailureClass } from '../../src/types/eval.js';
import { EvalEngine } from '../../src/eval/engine.js';
import { defaultConfig } from '../../src/config/defaults.js';
import { FAILURE_CLASS_IDS } from '../../src/eval/failure-classes.js';
import { wilson } from '../judge/lib/wilson.js';
import { calibration, newcombeDifference, type Calibration } from './intervals.js';
import { compositeContext, loadComposite, splitOf, validateComposite, type CompositeCase, type LoadedComposite, type Split } from './composite.js';
import { riskVerdict, DEFAULT_TAU, DEFAULT_PRIOR, DEFAULT_FALSE_PASS_COST, DEFAULT_PRIOR_MODE, type PriorMode, type RiskVerdict } from '../../src/eval/risk.js';
import { deriveVerdict } from '../../src/eval/verdict.js';

export const COMPOSITE_RESULTS_JSON = 'proof/composite-results.json';
export const COMPOSITE_MD = 'proof/COMPOSITE.md';

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

export interface RiskCell {
  state: RiskVerdict['state'];
  basis: RiskVerdict['basis'];
  by: string[];
  pBad: number | null;
  lo: number | null;
  hi: number | null;
  confidence: RiskVerdict['confidence'];
}

export interface CaseRow {
  id: string;
  split: Split;
  provenance: CompositeCase['provenance'];
  shouldShip: boolean | null;
  classes: FailureClass[];
  legacy: { passed: boolean; score: number; criticalFailures: string[] };
  /** The default variant (per-output prior). */
  risk: RiskCell;
  /** Plan §4.3 as written (per-class prior). */
  riskPerClass: RiskCell;
  classesCaught: FailureClass[];
}

export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  ci95: [number, number] | null;
}

export interface ComposerSlice {
  accuracy: Rate;
  falseBlock: Rate;
  missedBlock: Rate;
  calibration: Calibration | null;
}

export interface ComposerSlices {
  test: ComposerSlice;
  dev: ComposerSlice;
  realTranscripts: ComposerSlice;
}

export interface SweepRow {
  tau: number;
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  accuracy: number;
  utility: number;
}

export type Difference = { delta: number; lo: number; hi: number } | null;

export interface CompositeResults {
  schemaVersion: 1;
  compositeVersion: string;
  corpusVersion: string;
  generatedAt: string;
  commit: string;
  version: string;
  method: {
    split: string;
    tau: number;
    falsePassCost: number;
    prior: number;
    priorMode: PriorMode;
    risk: string;
    priorModes: Record<PriorMode, string>;
    legacy: string;
    accuracyCi: 'wilson-95';
    differenceCi: 'newcombe-hybrid-score-95';
    calibration: string;
    shouldShip: string;
  };
  counts: { cases: number; dev: number; test: number; realTranscripts: number; composed: number; clean: number; mustNotShip: number; unlabelled: number; byClass: Record<string, number> };
  legacy: ComposerSlices;
  risk: ComposerSlices;
  riskPerClass: ComposerSlices;
  difference: {
    risk: { test: Difference; realTranscripts: Difference };
    riskPerClass: { test: Difference; realTranscripts: Difference };
    reads: string;
  };
  perClass: Array<{ class: FailureClass; present: number; caught: number; recall: number | null; ci95: [number, number] | null }>;
  sweep: { split: 'dev'; variant: PriorMode; rows: SweepRow[]; argmaxUtility: number; shippedTau: number; note: string };
  cases: CaseRow[];
}

function rate(k: number, n: number): Rate {
  const w = n === 0 ? null : wilson(k, n);
  return { k, n, rate: n === 0 ? null : round4(k / n), ci95: w ? [round4(w.lo), round4(w.hi)] : null };
}

function slice(rows: CaseRow[], ship: (r: CaseRow) => boolean, prob: (r: CaseRow) => number | null): ComposerSlice {
  const labelled = rows.filter((r) => r.shouldShip !== null);
  const correct = labelled.filter((r) => ship(r) === r.shouldShip).length;
  const clean = labelled.filter((r) => r.shouldShip === true);
  const bad = labelled.filter((r) => r.shouldShip === false);
  const pairs = labelled.flatMap((r) => {
    const p = prob(r);
    return p === null ? [] : [{ p, bad: r.shouldShip === false }];
  });
  return {
    accuracy: rate(correct, labelled.length),
    falseBlock: rate(clean.filter((r) => !ship(r)).length, clean.length),
    missedBlock: rate(bad.filter((r) => ship(r)).length, bad.length),
    calibration: calibration(pairs),
  };
}

function slices(rows: CaseRow[], ship: (r: CaseRow) => boolean, prob: (r: CaseRow) => number | null): ComposerSlices {
  return {
    test: slice(rows.filter((r) => r.split === 'test'), ship, prob),
    dev: slice(rows.filter((r) => r.split === 'dev'), ship, prob),
    realTranscripts: slice(rows.filter((r) => r.provenance === 'real-transcript'), ship, prob),
  };
}

const legacyShip = (r: CaseRow): boolean => r.legacy.passed;
const legacyProb = (r: CaseRow): number => 1 - r.legacy.score;
const riskShipOf = (cell: (r: CaseRow) => RiskCell) => (r: CaseRow): boolean => cell(r).state === 'pass';
const riskProbOf = (cell: (r: CaseRow) => RiskCell) => (r: CaseRow): number | null => {
  const c = cell(r);
  return c.pBad === null ? (c.state === 'fail' ? 1 : null) : c.pBad;
};

function cellOf(v: RiskVerdict): RiskCell {
  return { state: v.state, basis: v.basis, by: v.by, pBad: v.risk?.pBad ?? null, lo: v.risk?.lo ?? null, hi: v.risk?.hi ?? null, confidence: v.confidence };
}

export async function measureComposite(root: string, engine?: EvalEngine): Promise<{ loaded: LoadedComposite; rows: CaseRow[]; results: Omit<CompositeResults, 'generatedAt' | 'commit' | 'version'> }> {
  const loaded = await loadComposite(root);
  const issues = validateComposite(loaded);
  if (issues.length > 0) throw new Error(`composite corpus validation failed:\n  ${issues.join('\n  ')}`);
  const eng = engine ?? new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);

  const rows: CaseRow[] = [];
  for (const c of loaded.cases) {
    const result: EvalResult = await eng.evaluateAll(compositeContext(loaded, c));
    /*
     * The pre-0.10.0 arithmetic, computed explicitly. `result.passed` is the
     * COMPOSED verdict from 0.10.0 onward, so reading it here would compare
     * the new composer against itself and report a difference of zero.
     */
    const legacyVerdict = deriveVerdict(result, defaultConfig.eval.defaultThreshold);
    const fired = result.rule_results.filter((r) => !r.skipped && r.passed === false);
    const caught = new Set<FailureClass>();
    for (const r of fired) for (const cls of (r.classes ?? []) as FailureClass[]) caught.add(cls);
    rows.push({
      id: c.id,
      split: splitOf(c.id),
      provenance: c.provenance,
      shouldShip: c.expected.shouldShip,
      classes: c.expected.classes,
      legacy: { passed: legacyVerdict.passed, score: round4(result.score), criticalFailures: result.critical_failures ?? [] },
      risk: cellOf(riskVerdict(result, DEFAULT_TAU, DEFAULT_PRIOR, 'per-output')),
      riskPerClass: cellOf(riskVerdict(result, DEFAULT_TAU, DEFAULT_PRIOR, 'per-class')),
      classesCaught: [...caught].filter((cls) => c.expected.classes.includes(cls)).sort(),
    });
  }

  const legacy = slices(rows, legacyShip, legacyProb);
  const risk = slices(rows, riskShipOf((r) => r.risk), riskProbOf((r) => r.risk));
  const riskPerClass = slices(rows, riskShipOf((r) => r.riskPerClass), riskProbOf((r) => r.riskPerClass));
  const diff = (a: ComposerSlice, b: ComposerSlice): Difference => newcombeDifference(a.accuracy.k, a.accuracy.n, b.accuracy.k, b.accuracy.n);

  const perClass = FAILURE_CLASS_IDS.map((cls) => {
    const present = rows.filter((r) => r.classes.includes(cls));
    const caught = present.filter((r) => r.classesCaught.includes(cls));
    const rt = rate(caught.length, present.length);
    return { class: cls, present: present.length, caught: caught.length, recall: rt.rate, ci95: rt.ci95 };
  });

  // The τ sweep on dev, for the default variant: gates and vetoes stand at
  // every τ; the risk term is re-thresholded.
  const sweepRows: SweepRow[] = [];
  const devLabelled = rows.filter((r) => r.split === 'dev' && r.shouldShip !== null);
  for (let t = 5; t <= 95; t += 5) {
    const tau = t / 100;
    let tp = 0;
    let fp = 0;
    let fn = 0;
    let tn = 0;
    for (const r of devLabelled) {
      const hard = r.risk.state === 'fail' && r.risk.basis !== 'risk_over_loss';
      const block = hard || (r.risk.pBad !== null && r.risk.pBad > tau);
      const bad = r.shouldShip === false;
      if (block && bad) tp += 1;
      else if (block && !bad) fp += 1;
      else if (!block && bad) fn += 1;
      else tn += 1;
    }
    sweepRows.push({ tau, tp, fp, fn, tn, accuracy: round4(devLabelled.length ? (tp + tn) / devLabelled.length : 0), utility: -(fp + DEFAULT_FALSE_PASS_COST * fn) });
  }
  const argmax = sweepRows.reduce((best, r) => (r.utility > best.utility ? r : best), sweepRows[0]);

  const byClass: Record<string, number> = {};
  for (const r of rows) for (const cls of r.classes) byClass[cls] = (byClass[cls] ?? 0) + 1;

  const results: Omit<CompositeResults, 'generatedAt' | 'commit' | 'version'> = {
    schemaVersion: 1,
    compositeVersion: loaded.compositeVersion,
    corpusVersion: loaded.corpusVersion,
    method: {
      split: 'fnv1a(id + "iris-composite-split-v1") % 100 < 70 → dev, else test; never stored',
      tau: DEFAULT_TAU,
      falsePassCost: DEFAULT_FALSE_PASS_COST,
      prior: DEFAULT_PRIOR,
      priorMode: DEFAULT_PRIOR_MODE,
      risk: 'class-grouped noisy-OR over the published positive predictive values at the stated prior (max within a class; residual miss rate when nothing fired); 2,000 seeded draws over the Beta posteriors for the interval; gates and vetoes before the risk; measurements and policies never enter (src/eval/risk.ts, the module the product uses)',
      priorModes: {
        'per-output': 'π is the prior that the output is bad; spread over the K examined classes as π_c = 1 − (1 − π)^(1/K)',
        'per-class': 'π is the prior that each examined class is present (plan §4.3 as written); with K classes examined the prior that nothing is wrong is (1 − π)^K',
      },
      legacy: 'the pre-0.10.0 arithmetic, computed explicitly by deriveVerdict: weighted score ≥ the default threshold and no critical failure. From 0.10.0 the engine composes passed, so this baseline is derived rather than read off the result',
      accuracyCi: 'wilson-95',
      differenceCi: 'newcombe-hybrid-score-95',
      calibration: 'Brier score and expected calibration error over ten equal-width bins; the legacy score read as P(bad) = 1 − score, the risk as p_bad',
      shouldShip: 'by construction (any tier-A class present → false) unless a human label overrides; cases with shouldShip null are excluded from accuracy',
    },
    counts: {
      cases: rows.length,
      dev: rows.filter((r) => r.split === 'dev').length,
      test: rows.filter((r) => r.split === 'test').length,
      realTranscripts: rows.filter((r) => r.provenance === 'real-transcript').length,
      composed: rows.filter((r) => r.provenance === 'composed').length,
      clean: rows.filter((r) => r.shouldShip === true).length,
      mustNotShip: rows.filter((r) => r.shouldShip === false).length,
      unlabelled: rows.filter((r) => r.shouldShip === null).length,
      byClass,
    },
    legacy,
    risk,
    riskPerClass,
    difference: {
      risk: { test: diff(risk.test, legacy.test), realTranscripts: diff(risk.realTranscripts, legacy.realTranscripts) },
      riskPerClass: { test: diff(riskPerClass.test, legacy.test), realTranscripts: diff(riskPerClass.realTranscripts, legacy.realTranscripts) },
      reads: 'accuracy(risk variant) − accuracy(legacy); an interval that excludes zero on the positive side says the variant is more accurate on this corpus; one that straddles zero says the corpus cannot tell them apart',
    },
    perClass,
    sweep: {
      split: 'dev',
      variant: DEFAULT_PRIOR_MODE,
      rows: sweepRows,
      argmaxUtility: argmax.tau,
      shippedTau: DEFAULT_TAU,
      note: 'utility = −(false blocks + c × missed blocks) at c = 1 on the dev split; the argmax is a check on the loss model, never adopted',
    },
    cases: rows,
  };
  return { loaded, rows, results };
}

const pct = (x: number | null): string => (x === null ? '—' : `${(x * 100).toFixed(1)}%`);
const ci = (i: [number, number] | null): string => (i === null ? '—' : `[${(i[0] * 100).toFixed(1)}, ${(i[1] * 100).toFixed(1)}]`);
const pts = (d: Difference): string => (d ? `${(d.delta * 100).toFixed(1)} points [${(d.lo * 100).toFixed(1)}, ${(d.hi * 100).toFixed(1)}]` : '—');

export function renderCompositeMarkdown(r: CompositeResults): string {
  const L: string[] = [];
  L.push('# The verdict, measured — the composite corpus');
  L.push('');
  L.push(`Generated ${r.generatedAt} for v${r.version} (local generating commit \`${r.commit}\` — branch commits are squashed on merge, so cite the version).`);
  L.push(`Composite version \`${r.compositeVersion}\` (sha256 over proof/composite/*.json, the real transcripts and the family corpus \`${r.corpusVersion}\`). Reproduce with \`npm run proof -- --composite\`; CI runs \`npm run proof -- --check --composite\`.`);
  L.push('');
  L.push(`${r.counts.cases} cases: ${r.counts.realTranscripts} real transcripts (the out-of-sample line) and ${r.counts.composed} composed; ${r.counts.mustNotShip} must not ship, ${r.counts.clean} may, ${r.counts.unlabelled} unlabelled. Split: ${r.counts.dev} dev / ${r.counts.test} test, ${r.method.split}. Headline numbers are the test split. The expected verdict is true by construction — the classes present are a fact of what was injected — and never derived from a composer.`);
  L.push('');
  L.push('## Three composers on the same rule results');
  L.push('');
  L.push(`**legacy** — ${r.method.legacy}. **risk** — arc 3's composer run here in the harness only: ${r.method.risk}; τ = ${r.method.tau} (a false pass costs ${r.method.falsePassCost}× a false block), prior ${r.method.prior}. Two readings of the prior are measured: *per-output* (${r.method.priorModes['per-output']}) and *per-class* (${r.method.priorModes['per-class']}).`);
  L.push('');
  L.push('| Split | Composer | Accuracy vs shouldShip (95% CI) | False blocks on clean (95% CI) | Missed blocks (95% CI) | Brier | ECE |');
  L.push('|---|---|---|---|---|--:|--:|');
  for (const [name, split] of [['test', 'test'], ['real transcripts (out-of-sample)', 'realTranscripts'], ['dev', 'dev']] as const) {
    for (const [label, comp] of [['legacy', 'legacy'], ['risk, per-output prior', 'risk'], ['risk, per-class prior', 'riskPerClass']] as const) {
      const s = r[comp][split];
      L.push(`| ${name} | ${label} | ${pct(s.accuracy.rate)} ${ci(s.accuracy.ci95)} (n=${s.accuracy.n}) | ${pct(s.falseBlock.rate)} ${ci(s.falseBlock.ci95)} (n=${s.falseBlock.n}) | ${pct(s.missedBlock.rate)} ${ci(s.missedBlock.ci95)} (n=${s.missedBlock.n}) | ${s.calibration ? s.calibration.brier.toFixed(3) : '—'} | ${s.calibration ? s.calibration.ece.toFixed(3) : '—'} |`);
    }
  }
  L.push('');
  L.push(`**Difference from legacy (Newcombe 95%).** per-output prior: test ${pts(r.difference.risk.test)}; real transcripts ${pts(r.difference.risk.realTranscripts)}. per-class prior: test ${pts(r.difference.riskPerClass.test)}; real transcripts ${pts(r.difference.riskPerClass.realTranscripts)}. ${r.difference.reads}.`);
  L.push('');
  L.push('**What the per-class row shows.** Read per class, a 0.5 prior on each of ten examined classes leaves a prior of one in a thousand that nothing is wrong, so the noisy-OR blocks nearly every output — the false-block column says it. The per-output reading keeps the prior at one half for the output as a whole. Which reading ships, and at what default, is arc 3\'s deliberation; both numbers are here so it is made on evidence.');
  L.push('');
  L.push('## Recall by failure class');
  L.push('');
  L.push('A class counts as caught when a rule mapped to it fired on a case where it is present. A class with no shipped detector has recall 0 by construction and says so.');
  L.push('');
  L.push('| Class | Present | Caught | Recall (95% CI) |');
  L.push('|---|--:|--:|---|');
  for (const c of r.perClass) L.push(`| \`${c.class}\` | ${c.present} | ${c.caught} | ${c.present === 0 ? 'no cases' : `${pct(c.recall)} ${ci(c.ci95)}`} |`);
  L.push('');
  L.push('## Calibration (test split)');
  L.push('');
  for (const [label, comp] of [['legacy', 'legacy'], ['risk, per-output prior', 'risk'], ['risk, per-class prior', 'riskPerClass']] as const) {
    const cal = r[comp].test.calibration;
    L.push(`**${label}** — ${cal ? `Brier ${cal.brier.toFixed(3)}, ECE ${cal.ece.toFixed(3)}, n=${cal.n}` : 'no probabilities'}`);
    if (cal) {
      L.push('');
      L.push('| Bin | n | Mean predicted P(bad) | Observed bad rate |');
      L.push('|---|--:|--:|--:|');
      for (const b of cal.bins) if (b.n > 0) L.push(`| ${b.from.toFixed(1)}–${b.to.toFixed(1)} | ${b.n} | ${b.meanPredicted === null ? '—' : b.meanPredicted.toFixed(3)} | ${b.observedRate === null ? '—' : b.observedRate.toFixed(3)} |`);
    }
    L.push('');
  }
  L.push(`## Threshold sweep (dev split only, ${r.sweep.variant} prior)`);
  L.push('');
  L.push(`${r.sweep.note}. Utility-optimal τ on dev: **${r.sweep.argmaxUtility.toFixed(2)}**; shipped τ (loss-derived): **${r.sweep.shippedTau.toFixed(2)}**.`);
  L.push('');
  L.push('| τ | TP | FP | FN | TN | Accuracy | Utility |');
  L.push('|--:|--:|--:|--:|--:|--:|--:|');
  for (const s of r.sweep.rows) L.push(`| ${s.tau.toFixed(2)} | ${s.tp} | ${s.fp} | ${s.fn} | ${s.tn} | ${(s.accuracy * 100).toFixed(1)}% | ${s.utility} |`);
  L.push('');
  L.push('## Every case');
  L.push('');
  L.push('| Case | Split | Should ship | Classes | legacy | risk, per-output (basis, p_bad) | Caught |');
  L.push('|---|---|---|---|---|---|---|');
  for (const c of r.cases) {
    L.push(`| \`${c.id}\` | ${c.split} | ${c.shouldShip === null ? '?' : c.shouldShip ? 'yes' : 'no'} | ${c.classes.length ? c.classes.join(', ') : 'clean'} | ${c.legacy.passed ? 'pass' : 'fail'} (${c.legacy.score.toFixed(2)}${c.legacy.criticalFailures.length ? `; veto ${c.legacy.criticalFailures.join(', ')}` : ''}) | ${c.risk.state} (${c.risk.basis}${c.risk.pBad === null ? '' : `, ${c.risk.pBad.toFixed(2)} [${(c.risk.lo ?? 0).toFixed(2)}, ${(c.risk.hi ?? 0).toFixed(2)}]`}) | ${c.classesCaught.length ? c.classesCaught.join(', ') : c.classes.length ? 'none' : '—'} |`);
  }
  L.push('');
  L.push('Read proof/README.md and docs/proof.md before quoting a number: the composed cases are built from the same synthetic, same-model-labelled families the per-rule numbers come from, so the accuracy here is corpus-conditional; the real-transcript line is the only out-of-sample one.');
  L.push('');
  return L.join('\n');
}

/** Strips the fields that legitimately change on every run/commit. */
export function normaliseCompositeForCheck(json: string, md: string): { json: string; md: string } {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  delete parsed.generatedAt;
  delete parsed.commit;
  return {
    json: JSON.stringify(parsed),
    md: md.replace(/\r\n/g, '\n').split('\n').filter((l) => !l.startsWith('Generated ')).join('\n'),
  };
}
