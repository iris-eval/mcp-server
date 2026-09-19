import type { RunResultRow } from '../storage/sqlite-adapter.js';
import {
  benjaminiHochberg,
  mcnemarExact,
  mcnemarOneSidedWorse,
  newcombeDifference,
  newcombeOneSidedWorse,
  smallestDetectableDifference,
  wilson,
  Z_90,
  type Difference,
  type McNemarResult,
} from './stats.js';

/*
 * "Did my change make it worse?"
 *
 * Every competitor answers this from a test suite you wrote, which means
 * the answer only covers what you thought to write down. Iris answers it
 * from the traces it already holds.
 *
 * THE TEMPTATION THIS MODULE EXISTS TO REFUSE. A comparison that always
 * returns a verdict is more satisfying and less true. Two runs of eight
 * cases cannot distinguish a regression from noise, and a tool that says
 * "worse" on that evidence teaches its user to distrust it inside a week —
 * after which the honest answers are worthless too, because nobody reads
 * them. So the only thing that licenses the word "worse" here is an
 * interval that excludes zero, and when it does not, the response says how
 * many cases it would have taken.
 *
 * THE SECOND TEMPTATION (arc 7, D-6b). A per-rule table ranked by raw delta
 * is a number with no test behind it, and twenty rules each tested at 5%
 * read "worse" somewhere in most comparisons of runs that did not change.
 * So each rule carries its own one-sided test, the p-values are corrected
 * together (Benjamini–Hochberg), and a rule is marked worse only when its
 * q survives. And a comparison can say a THIRD thing, distinct from "worse"
 * and from "not distinguishable": equivalent within a margin — the 90%
 * interval on the difference lies inside ±δ, two one-sided tests at 5%.
 */

/** How the two runs were compared, and why that one. */
export type ComparisonMethod = 'paired-mcnemar' | 'unpaired-newcombe' | 'none';

/** The level every per-rule test and the equivalence test are read at. */
export const RULE_ALPHA = 0.05;

export interface RunSummary {
  runId: string;
  n: number;
  passed: number;
  rate: number | null;
  interval: { lo: number; hi: number } | null;
  agentNames: string[];
  engineVersions: string[];
  rulesetHashes: string[];
  configHashes: string[];
  /** Older evaluations of the same traces that were collapsed away. */
  superseded: number;
}

export interface RuleDelta {
  rule: string;
  failedBefore: number;
  failedAfter: number;
  delta: number;
  /** After minus before on this rule's own pass rate, 95% Newcombe; null when a side is empty. */
  difference: Difference | null;
  /** The one-sided test behind p: McNemar exact on this rule's discordant pairs when the runs pair, else the z read off the Newcombe difference. */
  test: 'mcnemar-exact' | 'newcombe-z' | null;
  /** One-sided, in the regression direction: the chance of a fall this large in this rule's pass rate when nothing changed. */
  p: number | null;
  /** Benjamini–Hochberg over every rule this comparison tested. Read this, not p, when twenty rules are on the table. */
  q: number | null;
  /** True only at q ≤ 0.05 in the regression direction — a per-rule regression that survives the correction. */
  worse: boolean;
}

export interface Equivalence {
  /** δ, as a difference in pass rate: the caller's margin, or the smallest difference these sizes could have detected. */
  margin: number;
  marginSource: 'caller' | 'smallest-detectable';
  /** The 90% Newcombe interval on the difference — two one-sided tests at α = 0.05. */
  interval: { lo: number; hi: number };
  /** True when the whole 90% interval lies inside (−δ, +δ). */
  holds: boolean;
}

export interface Comparison {
  comparable: boolean;
  /** Present when comparable is false, or when force made it proceed anyway. */
  incomparableBecause: string[];
  forced: boolean;
  method: ComparisonMethod;
  before: RunSummary;
  after: RunSummary;
  /** Null when either run is empty. */
  difference: Difference | null;
  paired: (McNemarResult & { method: 'mcnemar-exact' }) | null;
  /** True only when the evidence licenses the word. */
  worse: boolean;
  better: boolean;
  /** What this much data could have seen, when it saw nothing. */
  smallestDetectable: number | null;
  /** The third answer: the runs are equivalent within a margin. Null when a run is empty. */
  equivalentWithin: Equivalence | null;
  /** How many rules the per-rule tests covered — the family the correction ran over. */
  rulesTested: number;
  /** Worst first; a rule that improved is never listed as a regression. */
  regressions: RuleDelta[];
  improvements: RuleDelta[];
  summary: string;
}

const distinct = (values: Array<string | null>): string[] => [...new Set(values.filter((v): v is string => v !== null))].sort();

function summarise(runId: string, rows: RunResultRow[]): RunSummary {
  const n = rows.length;
  const passed = rows.filter((r) => r.passed).length;
  const w = n > 0 ? wilson(passed, n) : null;
  return {
    runId,
    n,
    passed,
    rate: n === 0 ? null : passed / n,
    interval: w ? { lo: w.lo, hi: w.hi } : null,
    agentNames: distinct(rows.map((r) => r.agentName)),
    engineVersions: distinct(rows.map((r) => r.engineVersion)),
    rulesetHashes: distinct(rows.map((r) => r.rulesetHash)),
    configHashes: distinct(rows.map((r) => r.configHash)),
    superseded: rows[0]?.supersededInRun ?? 0,
  };
}

/**
 * Whether these two runs are measuring the same thing.
 *
 * A pass rate that moved because the RULES changed is not a regression in
 * the agent, and reporting it as one is the single most damaging thing this
 * tool could do — it would send someone to debug an agent that never
 * changed. The engine's MINOR version is compared, not the patch: a patch
 * by this project's own versioning rule carries no behaviour change, and
 * refusing to compare across one would make the tool useless in a codebase
 * that ships fixes.
 *
 * A run containing more than one ruleset is itself incomparable, and that
 * is worth saying out loud rather than silently picking the first.
 */
function incomparabilityReasons(a: RunSummary, b: RunSummary): string[] {
  const why: string[] = [];
  const minor = (v: string): string => v.split('.').slice(0, 2).join('.');
  const mixed = (s: RunSummary, field: 'engineVersions' | 'rulesetHashes' | 'configHashes', label: string): void => {
    if (s[field].length > 1) why.push(`run "${s.runId}" contains more than one ${label} (${s[field].join(', ')}), so it is not one measurement`);
  };
  mixed(a, 'rulesetHashes', 'ruleset');
  mixed(b, 'rulesetHashes', 'ruleset');
  mixed(a, 'configHashes', 'configuration');
  mixed(b, 'configHashes', 'configuration');

  const va = a.engineVersions[0];
  const vb = b.engineVersions[0];
  if (va && vb && minor(va) !== minor(vb)) why.push(`the engine version differs (${va} against ${vb}); a rule change between minors moves a pass rate for reasons the agent had nothing to do with`);
  const ra = a.rulesetHashes[0];
  const rb = b.rulesetHashes[0];
  if (ra && rb && ra !== rb) why.push(`the ruleset differs (${ra} against ${rb}); different rules were asked, so a difference in the answers is not a difference in the agent`);
  const ca = a.configHashes[0];
  const cb = b.configHashes[0];
  if (ca && cb && ca !== cb) why.push(`the configuration differs (${ca} against ${cb}); thresholds and criticality decide verdicts, so the same outputs could score differently`);
  if (a.agentNames.length === 1 && b.agentNames.length === 1 && a.agentNames[0] !== b.agentNames[0]) {
    why.push(`these are different agents ("${a.agentNames[0]}" and "${b.agentNames[0]}"); two agents differ in ways a pass rate cannot express`);
  }
  return why;
}

/** The rows of each run keyed by case, and the keys both runs share. */
interface Pairing {
  before: Map<string, RunResultRow>;
  after: Map<string, RunResultRow>;
  shared: string[];
}

function pairByCaseKey(beforeRows: RunResultRow[], afterRows: RunResultRow[]): Pairing {
  const byKey = (rows: RunResultRow[]): Map<string, RunResultRow> => {
    const m = new Map<string, RunResultRow>();
    for (const r of rows) if (r.caseKey !== null && !m.has(r.caseKey)) m.set(r.caseKey, r);
    return m;
  };
  const before = byKey(beforeRows);
  const after = byKey(afterRows);
  return { before, after, shared: [...before.keys()].filter((k) => after.has(k)) };
}

/**
 * Per-rule movement with a test behind every row (plan §4.14).
 *
 * Each rule that fired in either run is tested ONE-SIDED in the regression
 * direction — the question is "worse", not "different". When the runs
 * pair, McNemar exact on that rule's own discordant pairs; otherwise the z
 * read off the rule's Newcombe difference. Then the p-values are corrected
 * together: a rule is marked worse only at q ≤ RULE_ALPHA. The lists keep
 * their shape — worst first, an improved rule never a regression — and the
 * rows that survived the correction lead.
 */
function ruleDeltas(
  beforeRows: RunResultRow[],
  afterRows: RunResultRow[],
  pairing: Pairing,
): { regressions: RuleDelta[]; improvements: RuleDelta[]; tested: number } {
  const count = (rows: RunResultRow[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows) for (const rule of r.failedRules) m.set(rule, (m.get(rule) ?? 0) + 1);
    return m;
  };
  const b = count(beforeRows);
  const a = count(afterRows);
  const rules = [...new Set([...b.keys(), ...a.keys()])].sort();
  const nBefore = beforeRows.length;
  const nAfter = afterRows.length;

  const rows: RuleDelta[] = rules.map((rule) => {
    const failedBefore = b.get(rule) ?? 0;
    const failedAfter = a.get(rule) ?? 0;
    const passesBefore = nBefore - failedBefore;
    const passesAfter = nAfter - failedAfter;
    const difference = newcombeDifference(passesAfter, nAfter, passesBefore, nBefore);
    let p: number | null = null;
    let test: RuleDelta['test'] = null;
    if (pairing.shared.length > 0) {
      let passThenFail = 0;
      let failThenPass = 0;
      for (const key of pairing.shared) {
        const was = !pairing.before.get(key)!.failedRules.includes(rule);
        const now = !pairing.after.get(key)!.failedRules.includes(rule);
        if (was && !now) passThenFail += 1;
        else if (!was && now) failThenPass += 1;
      }
      p = mcnemarOneSidedWorse(passThenFail, failThenPass);
      test = 'mcnemar-exact';
    } else {
      p = newcombeOneSidedWorse(passesBefore, nBefore, passesAfter, nAfter);
      test = p === null ? null : 'newcombe-z';
    }
    return { rule, failedBefore, failedAfter, delta: failedAfter - failedBefore, difference, test, p, q: null, worse: false };
  });

  const tested = rows.filter((r) => r.p !== null);
  const q = benjaminiHochberg(tested.map((r) => r.p!));
  tested.forEach((r, i) => {
    r.q = q[i];
    r.worse = q[i] <= RULE_ALPHA && r.delta > 0;
  });

  const worstFirst = (x: RuleDelta, y: RuleDelta): number => Number(y.worse) - Number(x.worse) || y.delta - x.delta || x.rule.localeCompare(y.rule);
  return {
    regressions: rows.filter((r) => r.delta > 0).sort(worstFirst),
    improvements: rows.filter((r) => r.delta < 0).sort((x, y) => x.delta - y.delta || x.rule.localeCompare(y.rule)),
    tested: tested.length,
  };
}

/**
 * Equivalence within δ by two one-sided tests at α = 0.05, which is the
 * 90% interval on the difference lying inside (−δ, +δ). Without a margin
 * from the caller, δ is the smallest difference these sizes could have
 * detected, and the response says so — "equivalent within what this data
 * could see" is the honest default, not a margin nobody chose.
 */
function equivalence(before: RunSummary, after: RunSummary, margin: number | undefined): Equivalence | null {
  if (before.n === 0 || after.n === 0) return null;
  const d90 = newcombeDifference(after.passed, after.n, before.passed, before.n, Z_90);
  if (d90 === null) return null;
  const delta = margin ?? smallestDetectableDifference(before.n, after.n);
  if (delta === null || !(delta > 0)) return null;
  return {
    margin: delta,
    marginSource: margin === undefined ? 'smallest-detectable' : 'caller',
    interval: { lo: d90.lo, hi: d90.hi },
    holds: d90.lo > -delta && d90.hi < delta,
  };
}

export interface CompareOptions {
  /** Compare across a version, ruleset or configuration boundary anyway. */
  force?: boolean;
  /** δ for the equivalence test, as a difference in pass rate in (0, 1]. Absent: the smallest detectable difference at these sizes. */
  equivalenceMargin?: number;
}

export function compareRuns(
  beforeId: string,
  beforeRows: RunResultRow[],
  afterId: string,
  afterRows: RunResultRow[],
  options: CompareOptions = {},
): Comparison {
  const before = summarise(beforeId, beforeRows);
  const after = summarise(afterId, afterRows);
  const incomparableBecause = incomparabilityReasons(before, after);
  const forced = incomparableBecause.length > 0 && options.force === true;
  const comparable = incomparableBecause.length === 0;

  const blank: Comparison = {
    comparable,
    incomparableBecause,
    forced,
    method: 'none',
    before,
    after,
    difference: null,
    paired: null,
    worse: false,
    better: false,
    smallestDetectable: null,
    equivalentWithin: null,
    rulesTested: 0,
    regressions: [],
    improvements: [],
    summary: '',
  };

  if (!comparable && !forced) {
    return { ...blank, summary: `Not compared: ${incomparableBecause[0]}. Pass force to compare anyway; the response will still say what changed.` };
  }
  if (before.n === 0 || after.n === 0) {
    const empty = before.n === 0 ? beforeId : afterId;
    return { ...blank, summary: `Nothing to compare: run "${empty}" has no evaluations.` };
  }

  /*
   * PAIR WHEN WE CAN. Two runs sharing case keys are not two independent
   * samples; they are one sample measured twice, and treating them as
   * independent throws the pairing away. McNemar looks only at the cases
   * that DISAGREED, which removes the variance between cases and leaves
   * only the variance from the change — so it can see a regression an
   * unpaired test of identical data cannot.
   */
  const pairing = pairByCaseKey(beforeRows, afterRows);
  const { regressions, improvements, tested } = ruleDeltas(beforeRows, afterRows, pairing);

  let paired: (McNemarResult & { method: 'mcnemar-exact' }) | null = null;
  if (pairing.shared.length > 0) {
    let b = 0;
    let c = 0;
    let concordant = 0;
    for (const key of pairing.shared) {
      const was = pairing.before.get(key)!.passed;
      const now = pairing.after.get(key)!.passed;
      if (was === now) concordant += 1;
      else if (was && !now) b += 1;
      else c += 1;
    }
    paired = { ...mcnemarExact(b, c, concordant), method: 'mcnemar-exact' };
  }

  const difference = newcombeDifference(after.passed, after.n, before.passed, before.n);
  const method: ComparisonMethod = paired ? 'paired-mcnemar' : 'unpaired-newcombe';

  // The paired test decides when there is pairing, because it is the one
  // with the power. The unpaired interval is still reported, so a reader
  // can see the size of the move as well as its significance.
  const declaresChange = paired ? paired.significant : (difference?.significant ?? false);
  const direction = paired ? (paired.b > paired.c ? -1 : 1) : Math.sign(difference?.delta ?? 0);
  const worse = declaresChange && direction < 0;
  const better = declaresChange && direction > 0;
  const smallestDetectable = declaresChange ? null : smallestDetectableDifference(before.n, after.n);
  const equivalentWithin = equivalence(before, after, options.equivalenceMargin);

  return {
    ...blank,
    method,
    difference,
    paired,
    worse,
    better,
    smallestDetectable,
    equivalentWithin,
    rulesTested: tested,
    regressions,
    improvements,
    summary: renderSummary({
      before,
      after,
      paired,
      difference,
      worse,
      better,
      smallestDetectable,
      equivalentWithin,
      shared: pairing.shared.length,
      regressions,
      rulesTested: tested,
      forced,
      incomparableBecause,
    }),
  };
}

function renderSummary(x: {
  before: RunSummary;
  after: RunSummary;
  paired: McNemarResult | null;
  difference: Difference | null;
  worse: boolean;
  better: boolean;
  smallestDetectable: number | null;
  equivalentWithin: Equivalence | null;
  shared: number;
  regressions: RuleDelta[];
  rulesTested: number;
  forced: boolean;
  incomparableBecause: string[];
}): string {
  const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  const pts = (v: number): string => `${(v * 100).toFixed(1)} points`;
  const parts: string[] = [];
  parts.push(`"${x.before.runId}" passed ${x.before.passed} of ${x.before.n} (${pct(x.before.rate)}); "${x.after.runId}" passed ${x.after.passed} of ${x.after.n} (${pct(x.after.rate)}).`);

  if (x.paired) {
    parts.push(`Compared as ${x.shared} matched pairs by case key, McNemar exact: ${x.paired.b} case${x.paired.b === 1 ? '' : 's'} passed before and failed after, ${x.paired.c} the other way, ${x.paired.concordant} unchanged, p = ${x.paired.pValue.toFixed(4)}.`);
  } else {
    parts.push('No case keys are shared, so the runs are compared as two independent samples. Supplying a case key on ingest pairs them, and a paired comparison sees a change an unpaired one cannot.');
  }

  if (x.worse) parts.push('**This is a regression**: the evidence excludes no change.');
  else if (x.better) parts.push('**This is an improvement**: the evidence excludes no change.');
  else {
    const floor = x.smallestDetectable === null ? null : `${(x.smallestDetectable * 100).toFixed(0)} points`;
    parts.push(
      `**Not enough evidence to call it either way.** That is a statement about the data, not about the agent: ${x.before.n} against ${x.after.n} cases could not have detected a change smaller than about ${floor ?? 'any size'}. Run more cases, or pair them with case keys.`,
    );
  }

  if (x.difference) parts.push(`Difference in pass rate: ${(x.difference.delta * 100).toFixed(1)} points, 95% interval [${(x.difference.lo * 100).toFixed(1)}, ${(x.difference.hi * 100).toFixed(1)}].`);

  if (x.equivalentWithin) {
    const e = x.equivalentWithin;
    const span = `[${(e.interval.lo * 100).toFixed(1)}, ${(e.interval.hi * 100).toFixed(1)}]`;
    const source = e.marginSource === 'caller' ? 'the margin you supplied' : 'the smallest difference these sizes could detect';
    parts.push(
      e.holds
        ? `**Equivalent within ${pts(e.margin)}**: the 90% interval ${span} lies inside ±${pts(e.margin)} (δ is ${source}).`
        : `Not equivalent within ${pts(e.margin)}: the 90% interval ${span} reaches outside ±${pts(e.margin)} (δ is ${source}); that is a different statement from "not distinguishable".`,
    );
  }

  if (x.regressions.length > 0) {
    const top = x.regressions.slice(0, 3).map((r) => `${r.rule} (${r.failedBefore} → ${r.failedAfter})`).join(', ');
    parts.push(`Rules failing more often, worst first: ${top}.`);
  }
  if (x.rulesTested > 0) {
    const survived = x.regressions.filter((r) => r.worse);
    const list = survived.map((r) => `${r.rule} (q = ${r.q!.toFixed(3)})`).join(', ');
    parts.push(
      `Per rule: ${x.rulesTested} rule${x.rulesTested === 1 ? '' : 's'} tested one-sided for a fall in pass rate and corrected together (Benjamini–Hochberg); ` +
        (survived.length > 0 ? `worse at q ≤ ${RULE_ALPHA}: ${list}.` : `none reads worse at q ≤ ${RULE_ALPHA} after the correction.`),
    );
  }
  if (x.forced) parts.push(`Compared under force, and these runs are not strictly comparable: ${x.incomparableBecause.join('; ')}.`);
  return parts.join(' ');
}
