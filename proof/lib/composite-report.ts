/*
 * `npm run proof -- --composite` — scores the VERDICT on the composite corpus.
 *
 * For every composite case the real engine runs `evaluateAll` under the
 * shipped defaults, and three composers read the same rule results:
 *
 *   legacy            — today's arithmetic: `passed` (score ≥ threshold and
 *                       no critical failure), as the tool returns it
 *   risk (per-output) — the risk composer, in the harness only
 *                       (src/eval/risk.ts, the module the product uses): gates, then vetoes, then p_bad
 *                       against τ = 1 / (1 + c), with the prior read as
 *                       "this output is bad" and spread over the classes
 *                       the detectors examine
 *   risk (per-class)  — the same composer with the prior read per
 *                       class — measured because it is the literal
 *                       reading, and reported because it blocks
 *                       nearly everything (why the default reads per output)
 *
 * Against `shouldShip` (true by construction or by a human label) each gets
 * an accuracy with a Wilson interval, the false-block rate on clean cases,
 * the missed-block rate, and calibration (Brier, ECE, ten bins) — the legacy
 * score read as P(bad) = 1 − score, the risk as p_bad. Each risk variant's
 * accuracy difference from legacy carries the Newcombe interval. Per class:
 * recall (class present → some mapped detector fired). The 24 real
 * transcripts are reported as their own held-out line: no per-rule rate the
 * composer reads was estimated on them, but they are staged (most are bad
 * by design) and several rules were revised after seeing them. The threshold
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
import { calibration, type Calibration } from './intervals.js';
import { newcombeDifference } from '../../src/eval/stats.js';
import { compositeContext, loadComposite, splitOf, validateComposite, type CompositeCase, type LoadedComposite, type Split } from './composite.js';
import { riskVerdict, DEFAULT_TAU, DEFAULT_PRIOR, DEFAULT_FALSE_PASS_COST, DEFAULT_PRIOR_MODE, type PriorMode, type RiskVerdict } from '../../src/eval/risk.js';
import { legacyWouldShip } from './legacy-composer.js';
import { verdictConfidence, type CalibrationTable, type Confidence } from '../../src/eval/confidence.js';

export const COMPOSITE_RESULTS_JSON = 'proof/composite-results.json';
export const COMPOSITE_MD = 'proof/COMPOSITE.md';
export const PUBLISHED_CALIBRATION_TS = 'src/eval/published-calibration.ts';

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
  /** The per-class reading of the prior. */
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

/** How often a confidence label was right, per split, under one labelling rule. */
export interface LabelAccuracy {
  decisive: { test: Rate; dev: Rate; realTranscripts: Rate };
  marginal: { test: Rate; dev: Rate; realTranscripts: Rate };
}

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
  /**
   * The confidence label, measured. `table` is what src/eval/published-calibration.ts
   * is generated from; `intervalOnly` is the rule through 0.18.0 (decisive
   * whenever the credible interval excludes τ), `shipped` the rule in
   * src/eval/confidence.ts; `changed` counts the default-variant verdicts whose
   * label differs between the two.
   */
  confidence: { rule: string; table: CalibrationTable; intervalOnly: LabelAccuracy; shipped: LabelAccuracy; changed: { toMarginal: number; toDecisive: number; of: number } };
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

/** The dev-split calibration of the verdicts the risk node decided, in the ten bins the reliability table uses. */
function calibrationTable(rows: CaseRow[], compositeVersion: string): CalibrationTable {
  const bins = Array.from({ length: 10 }, (_, i) => ({ from: i / 10, to: (i + 1) / 10, n: 0, bad: 0, sum: 0 }));
  for (const r of rows) {
    if (r.split !== 'dev' || r.shouldShip === null || r.risk.confidence === null || r.risk.pBad === null) continue;
    const b = bins[Math.min(9, Math.floor(Math.min(1, Math.max(0, r.risk.pBad)) * 10))];
    b.n += 1;
    b.bad += r.shouldShip ? 0 : 1;
    b.sum += r.risk.pBad;
  }
  return {
    compositeVersion,
    split: 'dev',
    prior: DEFAULT_PRIOR,
    priorMode: DEFAULT_PRIOR_MODE,
    bins: bins.map((b) => ({ from: b.from, to: b.to, n: b.n, bad: b.bad, meanPredicted: b.n === 0 ? null : round4(b.sum / b.n) })),
  };
}

function labelAccuracy(rows: CaseRow[], label: (r: CaseRow) => Confidence | null): LabelAccuracy {
  const of = (want: Confidence, keep: (r: CaseRow) => boolean): Rate => {
    const hit = rows.filter((r) => keep(r) && r.shouldShip !== null && label(r) === want);
    return rate(hit.filter((r) => (r.risk.state === 'pass') === r.shouldShip).length, hit.length);
  };
  const per = (want: Confidence): LabelAccuracy['decisive'] => ({
    test: of(want, (r) => r.split === 'test'),
    dev: of(want, (r) => r.split === 'dev'),
    realTranscripts: of(want, (r) => r.provenance === 'real-transcript'),
  });
  return { decisive: per('decisive'), marginal: per('marginal') };
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
     *
     * From 0.12.0 the yardstick lives in proof/ rather than src/: the legacy
     * composer is no longer a product behaviour, only the baseline this
     * report measures against.
     */
    const legacyShipped = legacyWouldShip(result, defaultConfig.eval.defaultThreshold);
    const fired = result.rule_results.filter((r) => !r.skipped && r.passed === false);
    const caught = new Set<FailureClass>();
    for (const r of fired) for (const cls of (r.classes ?? []) as FailureClass[]) caught.add(cls);
    rows.push({
      id: c.id,
      split: splitOf(c.id),
      provenance: c.provenance,
      shouldShip: c.expected.shouldShip,
      classes: c.expected.classes,
      legacy: { passed: legacyShipped, score: round4(result.score), criticalFailures: result.critical_failures ?? [] },
      risk: cellOf(riskVerdict(result, DEFAULT_TAU, DEFAULT_PRIOR, 'per-output')),
      riskPerClass: cellOf(riskVerdict(result, DEFAULT_TAU, DEFAULT_PRIOR, 'per-class')),
      classesCaught: [...caught].filter((cls) => c.expected.classes.includes(cls)).sort(),
    });
  }

  /*
   * The calibration the confidence label reads, measured on the dev split
   * over the verdicts the risk node decided (a gate or a veto carries no
   * confidence label, and its cases would say nothing about the estimate).
   * Every row is then re-labelled from this table, so the committed output
   * never depends on the table it regenerates; the test split stays held out
   * to measure the labels.
   */
  const table = calibrationTable(rows, loaded.compositeVersion);
  const intervalOnlyLabels = new Map<string, Confidence | null>(
    rows.map((r) => [r.id, r.risk.confidence === null || r.risk.lo === null || r.risk.hi === null ? null : r.risk.lo <= DEFAULT_TAU && DEFAULT_TAU <= r.risk.hi ? 'marginal' : 'decisive']),
  );
  for (const r of rows) {
    for (const [cell, mode] of [[r.risk, 'per-output'], [r.riskPerClass, 'per-class']] as const) {
      if (cell.confidence === null || cell.pBad === null || cell.lo === null || cell.hi === null) continue;
      cell.confidence = verdictConfidence({ pBad: cell.pBad, lo: cell.lo, hi: cell.hi }, DEFAULT_TAU, { prior: DEFAULT_PRIOR, priorMode: mode, localLabels: false }, table).confidence;
    }
  }
  const labelled = rows.filter((r) => r.risk.confidence !== null && r.shouldShip !== null);
  const confidence: CompositeResults['confidence'] = {
    rule: "decisive needs the credible interval to exclude τ AND, in the verdict's tenth of p_bad, the dev-split observed bad rate of risk-decided verdicts to be consistent with the stated p_bad (mean predicted inside its Wilson 95% interval) with that interval wholly on the verdict's side of τ; otherwise marginal (src/eval/confidence.ts)",
    table,
    intervalOnly: labelAccuracy(rows, (r) => intervalOnlyLabels.get(r.id) ?? null),
    shipped: labelAccuracy(rows, (r) => r.risk.confidence),
    changed: {
      toMarginal: labelled.filter((r) => intervalOnlyLabels.get(r.id) === 'decisive' && r.risk.confidence === 'marginal').length,
      toDecisive: labelled.filter((r) => intervalOnlyLabels.get(r.id) === 'marginal' && r.risk.confidence === 'decisive').length,
      of: labelled.length,
    },
  };

  const legacy = slices(rows, legacyShip, legacyProb);
  const risk = slices(rows, riskShipOf((r) => r.risk), riskProbOf((r) => r.risk));
  const riskPerClass = slices(rows, riskShipOf((r) => r.riskPerClass), riskProbOf((r) => r.riskPerClass));
  /*
   * One implementation of the statistic, shared with the product — the
   * comparison a reader checks on /proof is computed by the same function
   * the shipped compare_runs uses. Rounded here rather than inside it: a
   * statistic that rounds is a statistic with a display decision baked in.
   */
  const diff = (a: ComposerSlice, b: ComposerSlice): Difference => {
    const d = newcombeDifference(a.accuracy.k, a.accuracy.n, b.accuracy.k, b.accuracy.n);
    return d === null ? null : { delta: round4(d.delta), lo: round4(d.lo), hi: round4(d.hi) };
  };

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
        'per-class': 'π is the prior that each examined class is present, as originally specified; with K classes examined the prior that nothing is wrong is (1 − π)^K',
      },
      legacy: 'the pre-0.10.0 arithmetic, computed explicitly by proof/lib/legacy-composer.ts: weighted score ≥ the default threshold and no critical failure. From 0.10.0 the engine composes passed, so this baseline is derived rather than read off the result; from 0.12.0 it is no longer a product behaviour and this file is the only place it survives',
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
    confidence,
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
  L.push(`${r.counts.cases} cases: ${r.counts.realTranscripts} real transcripts (the held-out line: staged, not production traffic) and ${r.counts.composed} composed; ${r.counts.mustNotShip} must not ship, ${r.counts.clean} may, ${r.counts.unlabelled} unlabelled. Split: ${r.counts.dev} dev / ${r.counts.test} test, ${r.method.split}. Headline numbers are the test split. The expected verdict is true by construction — the classes present are a fact of what was injected — and never derived from a composer.`);
  L.push('');
  L.push('## Three composers on the same rule results');
  L.push('');
  L.push(`**legacy** — ${r.method.legacy}. **risk** — the risk composer run here in the harness only: ${r.method.risk}; τ = ${r.method.tau} (a false pass costs ${r.method.falsePassCost}× a false block), prior ${r.method.prior}. Two readings of the prior are measured: *per-output* (${r.method.priorModes['per-output']}) and *per-class* (${r.method.priorModes['per-class']}).`);
  L.push('');
  L.push('| Split | Composer | Accuracy vs shouldShip (95% CI) | False blocks on clean (95% CI) | Missed blocks (95% CI) | Brier | ECE |');
  L.push('|---|---|---|---|---|--:|--:|');
  for (const [name, split] of [['test', 'test'], ['real transcripts (held out, staged)', 'realTranscripts'], ['dev', 'dev']] as const) {
    for (const [label, comp] of [['legacy', 'legacy'], ['risk, per-output prior', 'risk'], ['risk, per-class prior', 'riskPerClass']] as const) {
      const s = r[comp][split];
      L.push(`| ${name} | ${label} | ${pct(s.accuracy.rate)} ${ci(s.accuracy.ci95)} (n=${s.accuracy.n}) | ${pct(s.falseBlock.rate)} ${ci(s.falseBlock.ci95)} (n=${s.falseBlock.n}) | ${pct(s.missedBlock.rate)} ${ci(s.missedBlock.ci95)} (n=${s.missedBlock.n}) | ${s.calibration ? s.calibration.brier.toFixed(3) : '—'} | ${s.calibration ? s.calibration.ece.toFixed(3) : '—'} |`);
    }
  }
  L.push('');
  L.push(`**Difference from legacy (Newcombe 95%).** per-output prior: test ${pts(r.difference.risk.test)}; real transcripts ${pts(r.difference.risk.realTranscripts)}. per-class prior: test ${pts(r.difference.riskPerClass.test)}; real transcripts ${pts(r.difference.riskPerClass.realTranscripts)}. ${r.difference.reads}.`);
  L.push('');
  L.push('**What the per-class row shows.** Read per class, a 0.5 prior on each of ten examined classes leaves a prior of one in a thousand that nothing is wrong, so the noisy-OR blocks nearly every output — the false-block column says it. The per-output reading keeps the prior at one half for the output as a whole. The shipped default reads the prior per output; both numbers are here so the choice is made on evidence.');
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
  L.push('## The confidence label (per-output prior)');
  L.push('');
  L.push(`A verdict the risk estimate decides carries \`confidence\`: \`decisive\` or \`marginal\`. Through 0.18.0 it was decisive whenever the credible interval on p_bad excluded τ. That interval carries the uncertainty in each detector's published error rates and nothing else, and the calibration above shows the estimate itself can be off by more than that: the rule now is that ${r.confidence.rule}.`);
  L.push('');
  L.push(`The calibration the label reads (dev split, risk-decided verdicts, generated into \`${PUBLISHED_CALIBRATION_TS}\`):`);
  L.push('');
  L.push('| Bin | n | Mean predicted P(bad) | Observed bad rate (95% CI) | Estimate consistent? | Backs a pass at τ | Backs a fail at τ |');
  L.push('|---|--:|--:|---|---|---|---|');
  for (const b of r.confidence.table.bins) {
    if (b.n === 0) continue;
    const w = wilson(b.bad, b.n)!;
    const consistent = b.meanPredicted !== null && b.meanPredicted >= w.lo && b.meanPredicted <= w.hi;
    L.push(`| ${b.from.toFixed(1)}–${b.to.toFixed(1)} | ${b.n} | ${b.meanPredicted === null ? '—' : b.meanPredicted.toFixed(3)} | ${(b.bad / b.n).toFixed(3)} [${w.lo.toFixed(3)}, ${w.hi.toFixed(3)}] | ${consistent ? 'yes' : 'no'} | ${consistent && w.hi < r.method.tau ? 'yes' : 'no'} | ${consistent && w.lo > r.method.tau ? 'yes' : 'no'} |`);
  }
  L.push('');
  L.push(`How often each label was right about shipping, under the rule through 0.18.0 and the rule now. ${r.confidence.changed.toMarginal} of ${r.confidence.changed.of} labelled verdicts move from decisive to marginal and ${r.confidence.changed.toDecisive} the other way. The table was measured on the dev split, so read the test and real-transcript rows:`);
  L.push('');
  L.push('| Split | Rule | Decisive: right (95% CI) | Marginal: right (95% CI) |');
  L.push('|---|---|---|---|');
  const cell = (x: Rate): string => (x.n === 0 ? 'none labelled' : `${x.k} of ${x.n}, ${pct(x.rate)} ${ci(x.ci95)}`);
  for (const [name, split] of [['test', 'test'], ['real transcripts (held out, staged)', 'realTranscripts'], ['dev', 'dev']] as const) {
    for (const [label, acc] of [['interval only (through 0.18.0)', r.confidence.intervalOnly], ['shipped', r.confidence.shipped]] as const) {
      L.push(`| ${name} | ${label} | ${cell(acc.decisive[split])} | ${cell(acc.marginal[split])} |`);
    }
  }
  L.push('');
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
  const staged = r.cases.filter((c) => c.provenance === 'real-transcript');
  const stagedBad = staged.filter((c) => c.shouldShip === false).length;
  L.push(`Read proof/README.md and docs/proof.md before quoting a number: the composed cases are built from the same synthetic, same-model-labelled families the per-rule numbers come from, so the accuracy here is corpus-conditional. The real-transcript line is held out of every per-rule rate the composer reads, but it is not a sample of production traffic: the ${staged.length} runs were scripted with an intended failure (${stagedBad} of ${staged.length} bad by design, a ${staged.length ? Math.round((stagedBad / staged.length) * 100) : 0}% base rate), and several rules were revised after an acceptance pass on them. Read it as a held-out check, not a field error rate.`);
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

/** The generated module src/eval/confidence.ts reads: the dev-split calibration, and the setting it was measured at. */
export function renderPublishedCalibration(r: CompositeResults): string {
  const t = r.confidence.table;
  const L: string[] = [];
  L.push('/*');
  L.push(' * GENERATED by `npm run proof -- --composite` from the composite corpus — do not');
  L.push(' * edit by hand. `npm run proof -- --check --composite` fails CI when this file');
  L.push(' * differs from what the runner produces. Read by src/eval/confidence.ts: a');
  L.push(' * verdict is labelled decisive only in a region of p_bad where this table');
  L.push(' * measured the estimate to hold. proof/COMPOSITE.md renders it beside the result.');
  L.push(' */');
  L.push('');
  L.push('export const PUBLISHED_CALIBRATION = {');
  L.push(`  compositeVersion: '${t.compositeVersion}',`);
  L.push(`  split: '${t.split}',`);
  L.push(`  prior: ${t.prior},`);
  L.push(`  priorMode: '${t.priorMode}',`);
  L.push('  bins: [');
  for (const b of t.bins) L.push(`    { from: ${b.from}, to: ${b.to}, n: ${b.n}, bad: ${b.bad}, meanPredicted: ${b.meanPredicted === null ? 'null' : b.meanPredicted} },`);
  L.push('  ],');
  L.push('} as const;');
  L.push('');
  return L.join('\n');
}
