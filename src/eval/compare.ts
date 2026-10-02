import type { RunResultRow } from '../storage/sqlite-adapter.js';
import {
  benjaminiHochberg,
  clopperPearson,
  DETECTABLE_POWER,
  mcnemarDifference,
  mcnemarExact,
  mcnemarOneSidedWorse,
  newcombeDifference,
  newcombeOneSidedWorse,
  newcombePairedDifference,
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
 * THE SECOND TEMPTATION. A per-rule table ranked by raw delta
 * is a number with no test behind it, and twenty rules each tested at 5%
 * read "worse" somewhere in most comparisons of runs that did not change.
 * So each rule carries its own one-sided test, the p-values are corrected
 * together (Benjamini–Hochberg), and a rule is marked worse only when its
 * q survives. And a comparison can say a THIRD thing, distinct from "worse"
 * and from "not distinguishable": equivalent within a margin the caller
 * chose — the 90% interval on the difference lies inside ±δ, two one-sided
 * tests at 5%.
 *
 * THE THIRD TEMPTATION: counting what was not checked as a pass. A rule
 * that skipped on a case said nothing about it. A run row once held only
 * the rules that FIRED, so a skip and a pass were the same row, and an
 * after-run that stopped sending its tool calls had every trajectory rule
 * "recover": 12 of 12 passed, "This is an improvement". A rule is now
 * compared only over the cases it ran on, a rule that ran before and not
 * after is reported as lost coverage, and an improvement is not declared
 * while coverage was lost, because fewer checks cannot be told from fewer
 * failures.
 *
 * AND EVERY WORD MATCHES ITS NUMBER. The tests are one-sided at 5%, so the
 * interval printed beside "regression" is the 90% one, which excludes zero
 * exactly when the test says so (stats.ts). It used to be the 95% one, and
 * the summary read "This is a regression" beside an interval through zero.
 * When the runs pair, the test reads which way the changed cases went, and
 * the number printed beside its word is that: the share of changed cases
 * that fell, with its exact interval. One interval per sentence, and each
 * is the one the sentence is about.
 */

/** How the two runs were compared, and why that one. */
export type ComparisonMethod = 'paired-mcnemar' | 'unpaired-newcombe' | 'none';

/** The level every per-rule test and the equivalence test are read at. */
export const RULE_ALPHA = 0.05;

/** The level of every interval a comparison prints: the two-sided interval that matches a one-sided test at RULE_ALPHA. */
export const INTERVAL_LEVEL = 0.9;

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
  /** How many cases the rule ran on in each run. Its rates, its difference and its test are over these, never over cases it skipped. */
  judgedBefore: number;
  judgedAfter: number;
  /** After minus before on this rule's own pass rate where it ran, 90% Newcombe; null when it ran on no case in one of the runs. */
  difference: Difference | null;
  /** The one-sided test behind p: McNemar exact on this rule's discordant pairs when the runs pair, else the Newcombe interval inverted. */
  test: 'mcnemar-exact' | 'newcombe-z' | null;
  /** One-sided, in the regression direction: the chance of a fall this large in this rule's pass rate when nothing changed. Null when the rule ran in only one of the runs. */
  p: number | null;
  /** Benjamini–Hochberg over every rule this comparison tested. Read this, not p, when twenty rules are on the table. */
  q: number | null;
  /** True only at q ≤ 0.05 in the regression direction — a per-rule regression that survives the correction. */
  worse: boolean;
}

/** A rule that ran on more or fewer cases in one run than in the other. */
export interface CoverageChange {
  rule: string;
  /** Cases the rule ran on, of the cases in the run. */
  judgedBefore: number;
  ofBefore: number;
  judgedAfter: number;
  ofAfter: number;
  /** On the cases both runs share: how many it ran on in the first of the two and not in the second. Null when the runs do not pair. */
  onShared: number | null;
}

/** What each run was judged on, where it differs. */
export interface Coverage {
  /** Rules that ran before and ran on fewer cases after: the after-run was judged on less. */
  lost: CoverageChange[];
  /** Rules that ran on more cases after than before. */
  gained: CoverageChange[];
}

/** A critical rule that fires on more cases after than before. Counted, never tested: one new must-not-ship output is the finding. */
export interface CriticalRise {
  rule: string;
  before: number;
  after: number;
  /** The shared cases where it fires after and did not before; empty when the runs do not pair. */
  newOn: string[];
}

export interface Equivalence {
  /** δ, as a difference in pass rate: the margin the caller chose. */
  margin: number;
  marginSource: 'caller';
  /**
   * The 90% interval on the difference — two one-sided tests at α = 0.05.
   * Newcombe's, for paired data when the runs pair: over every pair, the
   * unchanged ones included, which is what "how far apart" has to read.
   */
  interval: { lo: number; hi: number };
  /** True when the whole 90% interval lies inside (−δ, +δ). */
  holds: boolean;
}

/**
 * A shared case whose verdict flipped between the runs — one of the b + c
 * McNemar counts, named: the two evaluations, which way it
 * went, and the rules whose own pass/fail differ between them. The ids are
 * what a reader needs to open the moment.
 */
export interface DiscordantCase {
  caseKey: string;
  before: { evalId: string; traceId: string | null; passed: boolean };
  after: { evalId: string; traceId: string | null; passed: boolean };
  /** regressed = passed before and failed after; recovered = the other way. */
  direction: 'regressed' | 'recovered';
  rules: Array<{ rule: string; before: boolean; after: boolean }>;
  /** Rules that judged this case before and did not after. On a recovered case, the recovery may be these checks not running. */
  notJudgedAfter: string[];
}

/** Discordant cases listed per comparison; the total is always reported. */
export const MAX_DISCORDANT = 200;

/** McNemar's exact test on the matched pairs, with what it read. */
export interface PairedTest extends McNemarResult {
  method: 'mcnemar-exact';
  /** Pairs that passed in both runs, and in neither: the concordant pairs, split. */
  bothPass: number;
  bothFail: number;
  /**
   * Of the pairs that changed, the share that fell (passed before, failed
   * after), with its exact 90% interval. Above one half is a regression,
   * below is an improvement, and the interval excludes one half exactly
   * when the one-sided test says so. Null when no pair changed.
   */
  fell: { share: number; lo: number; hi: number } | null;
}

/** The one word a caller branches on. */
export type ComparisonCall = 'worse' | 'better' | 'equivalent' | 'undetermined';

export interface Comparison {
  comparable: boolean;
  /** Present when comparable is false, or when force made it proceed anyway. */
  incomparableBecause: string[];
  forced: boolean;
  method: ComparisonMethod;
  before: RunSummary;
  after: RunSummary;
  /**
   * After minus before on the pass rate, with the 90% interval that matches
   * the test that decided: Newcombe's on two independent samples, or, when
   * the runs pair, the interval McNemar's exact test implies, which is
   * conditional on how many pairs changed. `significant` is true exactly
   * when the one-sided test in either direction is. Null when either run
   * is empty.
   */
  difference: Difference | null;
  /** The level of `difference` and of every per-rule interval. */
  intervalLevel: number;
  paired: PairedTest | null;
  /** True only when the evidence licenses the word. */
  worse: boolean;
  /** True only when the evidence licenses the word AND the after-run was judged on no less than the before-run. */
  better: boolean;
  /** True when the pass rate rose by more than chance and `better` was not declared because coverage was lost. */
  improvementWithheld: boolean;
  /** worse, better, equivalent (only against a margin the caller chose), or undetermined. */
  call: ComparisonCall;
  /** What this much data would have detected four times in five, when it called nothing. */
  smallestDetectable: number | null;
  /** The power `smallestDetectable` is stated at. */
  detectablePower: number;
  /** Equivalence within the caller's margin. Null without a margin: a comparison does not choose one for you. */
  equivalentWithin: Equivalence | null;
  /** Where the two runs were judged on different things. */
  coverage: Coverage;
  /** Critical rules that fire on more cases after than before. */
  criticalRises: CriticalRise[];
  /** How many rules the per-rule tests covered — the family the correction ran over. */
  rulesTested: number;
  /** Worst first; a rule that improved is never listed as a regression. */
  regressions: RuleDelta[];
  improvements: RuleDelta[];
  /** The cases that disagreed, regressions first — empty when the runs do not pair. */
  discordant: DiscordantCase[];
  /** How many disagreed in all, when the list is capped. */
  discordantTotal: number;
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

/** Per rule, how many rows it ran on and how many it fired on. */
function tally(rows: RunResultRow[]): Map<string, { judged: number; failed: number }> {
  const m = new Map<string, { judged: number; failed: number }>();
  const at = (rule: string): { judged: number; failed: number } => {
    let t = m.get(rule);
    if (!t) m.set(rule, (t = { judged: 0, failed: 0 }));
    return t;
  };
  for (const r of rows) {
    for (const rule of r.judgedRules) at(rule).judged += 1;
    for (const rule of r.failedRules) at(rule).failed += 1;
  }
  return m;
}

/**
 * Per-rule movement with a test behind every row.
 *
 * A rule is compared only where it RAN. Its pass rate in a run is over the
 * cases it judged there, and when the runs pair, its test reads only the
 * shared cases it judged in both. A rule that ran in one run and on no case
 * in the other has no difference and no test: that is a change in what was
 * checked, and it is reported as coverage, not as a recovery.
 *
 * Each rule that fired in either run is tested ONE-SIDED in the regression
 * direction — the question is "worse", not "different". When the runs
 * pair, McNemar exact on that rule's own discordant pairs; otherwise the
 * Newcombe interval on its pass rate, inverted. Then the p-values are
 * corrected together: a rule is marked worse only at q ≤ RULE_ALPHA. The
 * lists keep their shape — worst first, an improved rule never a
 * regression — and the rows that survived the correction lead.
 */
function ruleDeltas(
  beforeRows: RunResultRow[],
  afterRows: RunResultRow[],
  pairing: Pairing,
): { regressions: RuleDelta[]; improvements: RuleDelta[]; tested: number } {
  const b = tally(beforeRows);
  const a = tally(afterRows);
  const fired = [...new Set([...b.entries(), ...a.entries()].filter(([, t]) => t.failed > 0).map(([rule]) => rule))].sort();

  const rows: RuleDelta[] = fired.map((rule) => {
    const failedBefore = b.get(rule)?.failed ?? 0;
    const failedAfter = a.get(rule)?.failed ?? 0;
    const judgedBefore = b.get(rule)?.judged ?? 0;
    const judgedAfter = a.get(rule)?.judged ?? 0;
    const row: RuleDelta = { rule, failedBefore, failedAfter, delta: failedAfter - failedBefore, judgedBefore, judgedAfter, difference: null, test: null, p: null, q: null, worse: false };
    if (judgedBefore === 0 || judgedAfter === 0) return row;
    row.difference = newcombeDifference(judgedAfter - failedAfter, judgedAfter, judgedBefore - failedBefore, judgedBefore, Z_90);
    if (pairing.shared.length > 0) {
      let passThenFail = 0;
      let failThenPass = 0;
      let both = 0;
      for (const key of pairing.shared) {
        const was = pairing.before.get(key)!;
        const now = pairing.after.get(key)!;
        if (!was.judgedRules.includes(rule) || !now.judgedRules.includes(rule)) continue;
        both += 1;
        const passedBefore = !was.failedRules.includes(rule);
        const passedAfter = !now.failedRules.includes(rule);
        if (passedBefore && !passedAfter) passThenFail += 1;
        else if (!passedBefore && passedAfter) failThenPass += 1;
      }
      // It ran in both runs, and on no shared case in both: nothing pairs, so nothing is tested.
      if (both === 0) return row;
      row.p = mcnemarOneSidedWorse(passThenFail, failThenPass);
      row.test = 'mcnemar-exact';
    } else {
      row.p = newcombeOneSidedWorse(judgedBefore - failedBefore, judgedBefore, judgedAfter - failedAfter, judgedAfter);
      row.test = row.p === null ? null : 'newcombe-z';
    }
    return row;
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
 * Where the two runs were judged on different things.
 *
 * When the runs pair, the question is exact: on the cases both ran, which
 * rules judged a case in one run and not in the other. When they do not,
 * a rule's share of cases judged is compared as two proportions, and a
 * change is reported only when the 90% interval on it excludes zero, so two
 * samples of a different mix of cases are not called a change in coverage.
 */
function coverageChanges(beforeRows: RunResultRow[], afterRows: RunResultRow[], pairing: Pairing): Coverage {
  const b = tally(beforeRows);
  const a = tally(afterRows);
  const rules = [...new Set([...b.keys(), ...a.keys()])].sort();
  const lost: CoverageChange[] = [];
  const gained: CoverageChange[] = [];
  for (const rule of rules) {
    const judgedBefore = b.get(rule)?.judged ?? 0;
    const judgedAfter = a.get(rule)?.judged ?? 0;
    const base = { rule, judgedBefore, ofBefore: beforeRows.length, judgedAfter, ofAfter: afterRows.length };
    if (pairing.shared.length > 0) {
      let onlyBefore = 0;
      let onlyAfter = 0;
      for (const key of pairing.shared) {
        const was = pairing.before.get(key)!.judgedRules.includes(rule);
        const now = pairing.after.get(key)!.judgedRules.includes(rule);
        if (was && !now) onlyBefore += 1;
        else if (!was && now) onlyAfter += 1;
      }
      if (onlyBefore > 0) lost.push({ ...base, onShared: onlyBefore });
      if (onlyAfter > 0) gained.push({ ...base, onShared: onlyAfter });
      continue;
    }
    const share = newcombeDifference(judgedAfter, afterRows.length, judgedBefore, beforeRows.length, Z_90);
    if (share === null) continue;
    if (share.hi < 0) lost.push({ ...base, onShared: null });
    else if (share.lo > 0) gained.push({ ...base, onShared: null });
  }
  const mostFirst = (x: CoverageChange, y: CoverageChange): number => (y.onShared ?? 0) - (x.onShared ?? 0) || x.rule.localeCompare(y.rule);
  return { lost: lost.sort(mostFirst), gained: gained.sort(mostFirst) };
}

/** Critical rules that fire on more cases after than before, most new cases first. */
function criticalRises(beforeRows: RunResultRow[], afterRows: RunResultRow[], pairing: Pairing): CriticalRise[] {
  const count = (rows: RunResultRow[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows) for (const rule of r.criticalFailed) m.set(rule, (m.get(rule) ?? 0) + 1);
    return m;
  };
  const b = count(beforeRows);
  const a = count(afterRows);
  const out: CriticalRise[] = [];
  for (const [rule, after] of a) {
    const before = b.get(rule) ?? 0;
    const newOn = pairing.shared.filter((key) => pairing.after.get(key)!.criticalFailed.includes(rule) && !pairing.before.get(key)!.criticalFailed.includes(rule)).sort();
    // Paired: any shared case where it newly fires. Unpaired: more fires than before.
    if (pairing.shared.length > 0 ? newOn.length > 0 : after > before) out.push({ rule, before, after, newOn });
  }
  return out.sort((x, y) => y.newOn.length - x.newOn.length || y.after - y.before - (x.after - x.before) || x.rule.localeCompare(y.rule));
}

/**
 * Equivalence within δ by two one-sided tests at α = 0.05, which is the
 * 90% interval on the difference lying inside (−δ, +δ).
 *
 * Only against a margin the caller chose. Without one this used to take δ
 * to be the smallest difference the sizes could detect, and two runs of
 * eight cases read "Equivalent within 40.3 points": a margin nobody chose,
 * wide enough to hold a fivefold rise in leaked personal data. How far
 * apart two runs may be and still count as the same is a decision about
 * the product, and a comparison that makes it for the reader has not
 * tested anything.
 */
function equivalence(spread: Difference | null, margin: number | undefined): Equivalence | null {
  if (spread === null || margin === undefined || !(margin > 0)) return null;
  return {
    margin,
    marginSource: 'caller',
    interval: { lo: spread.lo, hi: spread.hi },
    holds: spread.lo > -margin && spread.hi < margin,
  };
}

export interface CompareOptions {
  /** Compare across a version, ruleset or configuration boundary anyway. */
  force?: boolean;
  /** δ for the equivalence test, as a difference in pass rate in (0, 1]. Absent: equivalence is not tested. */
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
    intervalLevel: INTERVAL_LEVEL,
    paired: null,
    worse: false,
    better: false,
    improvementWithheld: false,
    call: 'undetermined',
    smallestDetectable: null,
    detectablePower: DETECTABLE_POWER,
    equivalentWithin: null,
    coverage: { lost: [], gained: [] },
    criticalRises: [],
    rulesTested: 0,
    regressions: [],
    improvements: [],
    discordant: [],
    discordantTotal: 0,
    summary: '',
  };

  if (!comparable && !forced) {
    return { ...blank, summary: `Not compared: ${incomparableBecause[0]}. Pass force to compare anyway; the response will still say what changed.` };
  }
  if (before.n === 0 || after.n === 0) {
    const empty = before.n === 0 ? beforeId : afterId;
    // Not comparable, and said so in the field a caller branches on: this
    // used to answer comparable: true beside a summary saying there was
    // nothing to compare (2026-09-23 review).
    const why = `run "${empty}" has no evaluations`;
    return { ...blank, comparable: false, incomparableBecause: [...incomparableBecause, why], summary: `Nothing to compare: ${why}.` };
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
  const coverage = coverageChanges(beforeRows, afterRows, pairing);
  const rises = criticalRises(beforeRows, afterRows, pairing);

  let paired: PairedTest | null = null;
  const discordants: DiscordantCase[] = [];
  if (pairing.shared.length > 0) {
    let b = 0;
    let c = 0;
    let bothPass = 0;
    let bothFail = 0;
    for (const key of pairing.shared) {
      const wasRow = pairing.before.get(key)!;
      const nowRow = pairing.after.get(key)!;
      const was = wasRow.passed;
      const now = nowRow.passed;
      if (was === now) {
        if (was) bothPass += 1;
        else bothFail += 1;
        continue;
      }
      if (was && !now) b += 1;
      else c += 1;
      // The pair, named: which rules answered differently on the two evaluations.
      const failedBefore = new Set(wasRow.failedRules);
      const failedAfter = new Set(nowRow.failedRules);
      const judgedAfter = new Set(nowRow.judgedRules);
      const rules = [...new Set([...failedBefore, ...failedAfter])]
        .filter((rule) => failedBefore.has(rule) !== failedAfter.has(rule))
        .sort((x, y) => Number(failedBefore.has(x)) - Number(failedBefore.has(y)) || x.localeCompare(y))
        .map((rule) => ({ rule, before: !failedBefore.has(rule), after: !failedAfter.has(rule) }));
      discordants.push({
        caseKey: key,
        before: { evalId: wasRow.evalId, traceId: wasRow.traceId, passed: was },
        after: { evalId: nowRow.evalId, traceId: nowRow.traceId, passed: now },
        direction: was && !now ? 'regressed' : 'recovered',
        rules,
        notJudgedAfter: wasRow.judgedRules.filter((rule) => !judgedAfter.has(rule)).sort(),
      });
    }
    const share = b + c > 0 ? clopperPearson(b, b + c, INTERVAL_LEVEL)! : null;
    paired = { ...mcnemarExact(b, c, bothPass + bothFail), method: 'mcnemar-exact', bothPass, bothFail, fell: share ? { share: b / (b + c), lo: share.lo, hi: share.hi } : null };
    discordants.sort((x, y) => Number(y.direction === 'regressed') - Number(x.direction === 'regressed') || x.caseKey.localeCompare(y.caseKey));
  }

  const method: ComparisonMethod = paired ? 'paired-mcnemar' : 'unpaired-newcombe';

  // The paired test decides when there is pairing, because it is the one
  // with the power, and the interval reported is the one that test implies.
  //
  // ONE-SIDED, like every per-rule row: the question is "did it get worse?"
  // (or better), not "is it different?". The top line used the two-sided
  // McNemar, whose exact p cannot fall below 0.0625 on five discordant
  // pairs, so 12/12 -> 7/12 read "not enough evidence" while the per-rule
  // row for the same data read worse at q = 0.031 (2026-09-23 review).
  const pWorse = paired ? mcnemarOneSidedWorse(paired.b, paired.c) : newcombeOneSidedWorse(before.passed, before.n, after.passed, after.n);
  const pBetter = paired ? mcnemarOneSidedWorse(paired.c, paired.b) : newcombeOneSidedWorse(after.passed, after.n, before.passed, before.n);
  const worse = pWorse !== null && pWorse <= RULE_ALPHA;
  const rose = !worse && pBetter !== null && pBetter <= RULE_ALPHA;
  /*
   * An improvement is declared only when the after-run was judged on no
   * less. A rule that stopped running cannot fire, so a run that sends
   * less evidence passes more cases, and "better" on that evidence would
   * reward withholding it. A regression is declared either way: failing
   * more under fewer checks is still failing more.
   */
  const improvementWithheld = rose && coverage.lost.length > 0;
  const better = rose && !improvementWithheld;
  const difference = paired ? mcnemarDifference(paired.b, paired.c, paired.concordant, INTERVAL_LEVEL) : newcombeDifference(after.passed, after.n, before.passed, before.n, Z_90);
  const smallestDetectable = worse || better ? null : smallestDetectableDifference(before.n, after.n);
  // How far apart the runs are, over every case: the interval an equivalence claim reads.
  const spread = paired ? newcombePairedDifference(paired.bothPass, paired.b, paired.c, paired.bothFail, Z_90) : difference;
  const equivalentWithin = equivalence(spread, options.equivalenceMargin);
  // Equivalent is a claim that nothing a reader cares about moved: not while a critical rule fires on new cases, and not while coverage was lost.
  const call: ComparisonCall = worse ? 'worse' : better ? 'better' : equivalentWithin?.holds === true && rises.length === 0 && coverage.lost.length === 0 ? 'equivalent' : 'undetermined';

  return {
    ...blank,
    method,
    difference,
    paired,
    worse,
    better,
    improvementWithheld,
    call,
    smallestDetectable,
    equivalentWithin,
    coverage,
    criticalRises: rises,
    rulesTested: tested,
    regressions,
    improvements,
    discordant: discordants.slice(0, MAX_DISCORDANT),
    discordantTotal: discordants.length,
    summary: renderSummary({
      before,
      after,
      paired,
      difference,
      worse,
      better,
      improvementWithheld,
      call,
      pDirectional: worse ? pWorse : rose ? pBetter : pWorse,
      smallestDetectable,
      equivalentWithin,
      coverage,
      rises,
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
  paired: PairedTest | null;
  difference: Difference | null;
  worse: boolean;
  better: boolean;
  improvementWithheld: boolean;
  call: ComparisonCall;
  /** The one-sided p behind the verdict: for the direction it reports, or for "worse" when it reports neither. */
  pDirectional: number | null;
  smallestDetectable: number | null;
  equivalentWithin: Equivalence | null;
  coverage: Coverage;
  rises: CriticalRise[];
  shared: number;
  regressions: RuleDelta[];
  rulesTested: number;
  forced: boolean;
  incomparableBecause: string[];
}): string {
  const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
  const pts = (v: number): string => `${(v * 100).toFixed(1)} points`;
  const signed = (v: number): string => `${v > 0 ? '+' : ''}${(v * 100).toFixed(1)}`;
  const cases = (n: number): string => `${n} case${n === 1 ? '' : 's'}`;
  const level = `${Math.round(INTERVAL_LEVEL * 100)}%`;
  const parts: string[] = [];
  parts.push(`"${x.before.runId}" passed ${x.before.passed} of ${x.before.n} (${pct(x.before.rate)}); "${x.after.runId}" passed ${x.after.passed} of ${x.after.n} (${pct(x.after.rate)}).`);

  /*
   * What the runs were judged on comes before what they scored: a reader
   * who sees "12 of 12" first has already read an improvement.
   */
  if (x.coverage.lost.length > 0) {
    const top = x.coverage.lost
      .slice(0, 3)
      .map((l) => `${l.rule} (ran on ${l.judgedBefore} of ${l.ofBefore} before, ${l.judgedAfter} of ${l.ofAfter} after)`)
      .join(', ');
    const more = x.coverage.lost.length > 3 ? `, and ${x.coverage.lost.length - 3} more` : '';
    parts.push(`The second run was judged on less: ${x.coverage.lost.length} rule${x.coverage.lost.length === 1 ? '' : 's'} ran on fewer cases than before: ${top}${more}. A rule that did not run cannot fail, and is counted as neither a pass nor a failure.`);
  }

  if (x.paired) {
    const side = x.better || x.improvementWithheld ? 'better' : 'worse';
    const p = x.pDirectional === null ? '' : `, one-sided p (${side}) = ${x.pDirectional.toFixed(4)}`;
    parts.push(`Compared as ${x.shared} matched pairs by case key, McNemar exact: ${cases(x.paired.b)} passed before and failed after, ${x.paired.c} the other way, ${x.paired.concordant} unchanged${p}.`);
  } else {
    parts.push('No case keys are shared, so the runs are compared as two independent samples. Supplying a case key on ingest pairs them, and a paired comparison sees a change an unpaired one cannot.');
  }

  if (x.worse) parts.push(`This is a regression: a one-sided test at α = ${RULE_ALPHA} excludes no change.`);
  else if (x.better) parts.push(`This is an improvement: a one-sided test at α = ${RULE_ALPHA} excludes no change.`);
  else if (x.improvementWithheld) {
    parts.push('More cases passed than chance explains, and this is not called an improvement: the second run was judged on less, and passing more under fewer checks cannot be told from failing less. Send the same evidence in both runs to compare them.');
  } else {
    const floor = x.smallestDetectable === null ? null : `${(x.smallestDetectable * 100).toFixed(0)} points`;
    parts.push(
      `Not enough evidence to call it either way. That is a statement about the data, not about the agent: ${x.before.n} against ${x.after.n} cases would have missed, more often than one time in five, a change smaller than about ${floor ?? 'any size'}. ${x.paired ? 'Run more cases.' : 'Run more cases, or pair them with case keys.'}`,
    );
  }

  if (x.difference && x.paired) {
    const f = x.paired.fell;
    parts.push(
      `Difference in pass rate on the matched cases: ${signed(x.difference.delta)} points.` +
        (f ? ` Of the ${cases(x.paired.b + x.paired.c)} that changed, ${pct(f.share)} fell, ${level} exact interval [${pct(f.lo)}, ${pct(f.hi)}]: a share above one half is a regression, below it an improvement, and the interval excludes one half exactly when the test does.` : ' No case changed.'),
    );
  } else if (x.difference) {
    parts.push(`Difference in pass rate: ${signed(x.difference.delta)} points, ${level} interval [${signed(x.difference.lo)}, ${signed(x.difference.hi)}] on two independent samples. It is the interval that matches the one-sided test: it excludes zero exactly when the test does.`);
  }

  for (const r of x.rises.slice(0, 3)) {
    const where = r.newOn.length > 0 ? `, newly on ${cases(r.newOn.length)}: ${r.newOn.slice(0, 5).join(', ')}${r.newOn.length > 5 ? ', …' : ''}` : '';
    parts.push(`Critical: ${r.rule} fires on ${cases(r.after)} in the second run and ${r.before} in the first${where}. A critical failure is counted, not tested: each one is an output that must not ship.`);
  }

  // Equivalence is a question only when neither direction was found.
  if (x.equivalentWithin && !x.worse && !x.better && !x.improvementWithheld) {
    const e = x.equivalentWithin;
    const span = `[${signed(e.interval.lo)}, ${signed(e.interval.hi)}]`;
    const over = x.paired ? `over all ${x.shared} pairs ` : '';
    if (x.call === 'equivalent') parts.push(`Equivalent within ${pts(e.margin)}, the margin you supplied: the ${level} interval on the difference ${over}${span} lies inside ±${pts(e.margin)}.`);
    else if (e.holds) {
      const why = x.rises.length > 0 ? 'a critical rule fires on cases it did not before' : 'the second run was judged on less';
      parts.push(`The ${level} interval on the difference ${over}${span} lies inside the ±${pts(e.margin)} you supplied, and the runs are not called equivalent: ${why}.`);
    } else parts.push(`Not equivalent within ${pts(e.margin)}, the margin you supplied: the ${level} interval on the difference ${over}${span} reaches outside ±${pts(e.margin)}. That is a different statement from "not distinguishable".`);
  }

  if (x.regressions.length > 0) {
    const top = x.regressions.slice(0, 3).map((r) => `${r.rule} (${r.failedBefore} of ${r.judgedBefore} → ${r.failedAfter} of ${r.judgedAfter})`).join(', ');
    parts.push(`Rules failing more often, worst first, as failures of the cases each ran on: ${top}.`);
  }
  if (x.rulesTested > 0) {
    const survived = x.regressions.filter((r) => r.worse);
    const list = survived.map((r) => `${r.rule} (q = ${r.q!.toFixed(3)})`).join(', ');
    parts.push(
      `Per rule: ${x.rulesTested} rule${x.rulesTested === 1 ? '' : 's'} tested one-sided for a fall in pass rate, each over the cases it ran on in both runs, and corrected together (Benjamini–Hochberg); ` +
        (survived.length > 0 ? `worse at q ≤ ${RULE_ALPHA}: ${list}.` : `none reads worse at q ≤ ${RULE_ALPHA} after the correction.`),
    );
  }
  if (x.forced) parts.push(`Compared under force, and these runs are not strictly comparable: ${x.incomparableBecause.join('; ')}.`);
  return parts.join(' ');
}
