import type { RunResultRow } from '../storage/sqlite-adapter.js';
import { mcnemarExact, newcombeDifference, smallestDetectableDifference, wilson, type Difference, type McNemarResult } from './stats.js';

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
 */

/** How the two runs were compared, and why that one. */
export type ComparisonMethod = 'paired-mcnemar' | 'unpaired-newcombe' | 'none';

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

/** Per-rule movement, worst first. A rule that improved is never a regression. */
function ruleDeltas(before: RunResultRow[], after: RunResultRow[]): { regressions: RuleDelta[]; improvements: RuleDelta[] } {
  const count = (rows: RunResultRow[]): Map<string, number> => {
    const m = new Map<string, number>();
    for (const r of rows) for (const rule of r.failedRules) m.set(rule, (m.get(rule) ?? 0) + 1);
    return m;
  };
  const b = count(before);
  const a = count(after);
  const rules = [...new Set([...b.keys(), ...a.keys()])];
  const all = rules.map((rule) => {
    const failedBefore = b.get(rule) ?? 0;
    const failedAfter = a.get(rule) ?? 0;
    return { rule, failedBefore, failedAfter, delta: failedAfter - failedBefore };
  });
  return {
    regressions: all.filter((r) => r.delta > 0).sort((x, y) => y.delta - x.delta || x.rule.localeCompare(y.rule)),
    improvements: all.filter((r) => r.delta < 0).sort((x, y) => x.delta - y.delta || x.rule.localeCompare(y.rule)),
  };
}

export interface CompareOptions {
  /** Compare across a version, ruleset or configuration boundary anyway. */
  force?: boolean;
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

  const { regressions, improvements } = ruleDeltas(beforeRows, afterRows);

  /*
   * PAIR WHEN WE CAN. Two runs sharing case keys are not two independent
   * samples; they are one sample measured twice, and treating them as
   * independent throws the pairing away. McNemar looks only at the cases
   * that DISAGREED, which removes the variance between cases and leaves
   * only the variance from the change — so it can see a regression an
   * unpaired test of identical data cannot.
   */
  const byKey = (rows: RunResultRow[]): Map<string, RunResultRow> => {
    const m = new Map<string, RunResultRow>();
    for (const r of rows) if (r.caseKey !== null && !m.has(r.caseKey)) m.set(r.caseKey, r);
    return m;
  };
  const mb = byKey(beforeRows);
  const ma = byKey(afterRows);
  const shared = [...mb.keys()].filter((k) => ma.has(k));

  let paired: (McNemarResult & { method: 'mcnemar-exact' }) | null = null;
  if (shared.length > 0) {
    let b = 0;
    let c = 0;
    let concordant = 0;
    for (const key of shared) {
      const was = mb.get(key)!.passed;
      const now = ma.get(key)!.passed;
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

  return {
    ...blank,
    method,
    difference,
    paired,
    worse,
    better,
    smallestDetectable,
    regressions,
    improvements,
    summary: renderSummary({ before, after, paired, difference, worse, better, smallestDetectable, shared: shared.length, regressions, forced, incomparableBecause }),
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
  shared: number;
  regressions: RuleDelta[];
  forced: boolean;
  incomparableBecause: string[];
}): string {
  const pct = (v: number | null): string => (v === null ? '—' : `${(v * 100).toFixed(1)}%`);
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
  if (x.regressions.length > 0) {
    const top = x.regressions.slice(0, 3).map((r) => `${r.rule} (${r.failedBefore} → ${r.failedAfter})`).join(', ');
    parts.push(`Rules failing more often, worst first: ${top}.`);
  }
  if (x.forced) parts.push(`Compared under force, and these runs are not strictly comparable: ${x.incomparableBecause.join('; ')}.`);
  return parts.join(' ');
}
