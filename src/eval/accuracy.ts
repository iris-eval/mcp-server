/*
 * The published accuracy, read at runtime.
 *
 * `npm run proof` measures every built-in rule on its labelled family and
 * writes the numbers to proof/results.json — and, since 0.9.0, to
 * src/eval/published-accuracy.ts, a generated module that ships inside the
 * package (the npm `files` list carries dist/ only, so a runtime read of
 * proof/ would find nothing). `npm run proof -- --check` diffs the generated
 * module too, so the numbers a verdict carries are the numbers on /proof.
 *
 * What this module adds: the arithmetic that turns a confusion matrix into
 * "how often is this fire right for YOU". The published precision is the
 * positive predictive value at the corpus prevalence, roughly one half; a
 * deployment whose traffic carries one violation in a hundred sees a very
 * different number from the same rule. Both the point and its interval are
 * computed here — the interval by seeded Monte Carlo over the Beta posteriors
 * of sensitivity and specificity (Jeffreys prior, ½ pseudo-count per cell),
 * two thousand draws. The draws depend on the rule alone, so they run once
 * per rule per process; an interval is then remembered per rule and exact
 * prevalence.
 *
 * Every number carries its provenance: the corpus version, the release it
 * was generated for, and the labelling ('same-model' until a human
 * blind label lands). A surface that drops the labelling tag is a truth
 * defect, not a formatting choice.
 */
import { PUBLISHED_ACCURACY, PUBLISHED_ACCURACY_CORPUS_VERSION, PUBLISHED_ACCURACY_LABELLING, PUBLISHED_ACCURACY_OUTSIDE_LABELLED, PUBLISHED_ACCURACY_RELEASE } from './published-accuracy.js';
import { beta, fnv1a, missRate, mulberry32, percentile95, ppv, round4, sensitivity, specificity, type Confusion } from './stats.js';

export interface Interval {
  point: number;
  lo: number;
  hi: number;
}

export interface PublishedRuleAccuracy extends Confusion {
  n: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  ci95: {
    precision: readonly [number, number] | null;
    recall: readonly [number, number] | null;
    f1: readonly [number, number] | null;
  };
}

export interface PublishedProvenance {
  corpusVersion: string;
  release: string;
  /**
   * Who labelled the cases a number was measured on: the model that wrote
   * them, a human who checked them, or somebody outside Iris, on runs Iris
   * did not write (a benchmark's environment checking the world after each
   * run).
   */
  labelling: 'same-model' | 'human-verified' | 'outside';
}

export const DEFAULT_PREVALENCE = 0.5;
export const INTERVAL_DRAWS = 2000;

/**
 * The provenance of the published numbers: the corpus's when no rule is
 * named, and one rule's when it is. The two differ only in the labelling: a
 * rule whose family was labelled outside Iris does not carry the corpus's
 * tag, and a surface that showed it "same-model" would understate it.
 */
export function publishedProvenance(ruleName?: string): PublishedProvenance {
  const labelling = ruleName !== undefined && PUBLISHED_ACCURACY_OUTSIDE_LABELLED.includes(ruleName) ? 'outside' : PUBLISHED_ACCURACY_LABELLING;
  return { corpusVersion: PUBLISHED_ACCURACY_CORPUS_VERSION, release: PUBLISHED_ACCURACY_RELEASE, labelling };
}

/** The published numbers for a built-in rule, or null for a rule with no family (a custom rule, a rule added before its proof). */
export function publishedAccuracyFor(ruleName: string): PublishedRuleAccuracy | null {
  const entry = (PUBLISHED_ACCURACY as unknown as Record<string, PublishedRuleAccuracy | undefined>)[ruleName];
  return entry ?? null;
}

/**
 * The share of a rule's proof family that is positive: the mix its numbers
 * were measured at. Null for a rule with no family, or one whose family
 * holds a single class.
 */
export function familyPrevalence(ruleName: string): number | null {
  const counts = publishedAccuracyFor(ruleName);
  if (!counts) return null;
  const positives = counts.tp + counts.fn;
  const n = positives + counts.fp + counts.tn;
  return positives > 0 && positives < n ? positives / n : null;
}

/** Every rule name with published numbers, in the order the proof emitted them. */
export function publishedRuleNames(): string[] {
  return Object.keys(PUBLISHED_ACCURACY);
}

/*
 * Keyed on the EXACT prevalence (0.20.0). Until then the key carried it to
 * three decimals while the interval was computed at the exact value, so
 * the first prevalence asked for answered for every other that rounded the
 * same: after an interval at 0.0101, one at 0.0104 came back as 0.0101's.
 * A prior estimated from a deployment's labels, which 0.14.0 through 0.21.0
 * used, is a continuous number that moved as the deployment labelled, so
 * that was reachable. The map is bounded, least recently used out.
 */
const MEMO_MAX = 4096;
const memo = new Map<string, Interval | null>();
const key = (ruleName: string, prevalence: number, which: 'ppv' | 'miss'): string => `${which}:${ruleName}:${String(prevalence)}`;

function remember(k: string, value: Interval | null): Interval | null {
  memo.set(k, value);
  if (memo.size > MEMO_MAX) memo.delete(memo.keys().next().value!);
  return value;
}

function recall(k: string): Interval | null | undefined {
  if (!memo.has(k)) return undefined;
  const value = memo.get(k) ?? null;
  memo.delete(k);
  memo.set(k, value);
  return value;
}

/*
 * The posterior draws of sensitivity and specificity. The seed names the
 * rule and never the prevalence, so the same 2,000 pairs serve every
 * prevalence: they are drawn once per seed and each interval only applies
 * its formula to them.
 */
const posteriorDraws = new Map<string, { sens: Float64Array; spec: Float64Array }>();

function drawsFor(counts: Confusion, seed: string): { sens: Float64Array; spec: Float64Array } {
  const cached = posteriorDraws.get(seed);
  if (cached) return cached;
  const rng = mulberry32(fnv1a(seed));
  const sens = new Float64Array(INTERVAL_DRAWS);
  const spec = new Float64Array(INTERVAL_DRAWS);
  for (let i = 0; i < INTERVAL_DRAWS; i++) {
    sens[i] = beta(counts.tp + 0.5, counts.fn + 0.5, rng);
    spec[i] = beta(counts.tn + 0.5, counts.fp + 0.5, rng);
  }
  const drawn = { sens, spec };
  posteriorDraws.set(seed, drawn);
  return drawn;
}

function sampleInterval(
  counts: Confusion,
  prevalence: number,
  seed: string,
  fn: (sens: number, spec: number, prevalence: number) => number,
): Interval | null {
  const sens = sensitivity(counts);
  const spec = specificity(counts);
  if (sens === null || spec === null) return null;
  const drawn = drawsFor(counts, seed);
  const draws: number[] = [];
  for (let i = 0; i < INTERVAL_DRAWS; i++) draws.push(fn(drawn.sens[i], drawn.spec[i], prevalence));
  const [lo, hi] = percentile95(draws);
  return { point: round4(fn(sens, spec, prevalence)), lo: round4(lo), hi: round4(hi) };
}

/**
 * PPV at a prevalence with a 95% credible interval, for a rule that FIRED.
 * Null when the rule has no published family or its family has no positives
 * or no negatives (nothing to estimate from).
 */
export function ppvInterval(ruleName: string, prevalence: number = DEFAULT_PREVALENCE): Interval | null {
  const k = key(ruleName, prevalence, 'ppv');
  const known = recall(k);
  if (known !== undefined) return known;
  const counts = publishedAccuracyFor(ruleName);
  return remember(k, counts ? sampleInterval(counts, prevalence, `ppv:${ruleName}:${PUBLISHED_ACCURACY_CORPUS_VERSION}`, ppv) : null);
}

/** P(violation | the rule did not fire) at a prevalence with a 95% credible interval, for a rule that did NOT fire. */
export function missRateInterval(ruleName: string, prevalence: number = DEFAULT_PREVALENCE): Interval | null {
  const k = key(ruleName, prevalence, 'miss');
  const known = recall(k);
  if (known !== undefined) return known;
  const counts = publishedAccuracyFor(ruleName);
  return remember(k, counts ? sampleInterval(counts, prevalence, `miss:${ruleName}:${PUBLISHED_ACCURACY_CORPUS_VERSION}`, missRate) : null);
}

/** PPV at several prevalences — the field-prevalence table a reader needs beside a published precision. */
export function ppvAt(ruleName: string, prevalences: readonly number[] = [0.01, 0.05, 0.2, 0.5]): Record<string, number | null> {
  const counts = publishedAccuracyFor(ruleName);
  const out: Record<string, number | null> = {};
  for (const p of prevalences) {
    const sens = counts ? sensitivity(counts) : null;
    const spec = counts ? specificity(counts) : null;
    out[p.toFixed(2)] = sens === null || spec === null ? null : round4(ppv(sens, spec, p));
  }
  return out;
}

/** Test hook: clear the memo so a seeded interval can be recomputed. */
export function resetAccuracyMemo(): void {
  memo.clear();
  posteriorDraws.clear();
}
