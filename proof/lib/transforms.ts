/*
 * Transforms — does a critical detector survive the evasions a leak or an
 * injection arrives in? (arc 2, M4)
 *
 * For every positive case of the three critical families the rule is run on
 * the original; where it fired and reported a span into the raw output, the
 * text INSIDE that span is transformed (zero-width insertion, Cyrillic
 * homoglyphs, fullwidth forms, NBSP for spaces, a tab or a line break inside
 * the span, case swapped) and the rule is run again. Recall per transform is
 * the share of those cases the rule still fails, with a Wilson interval; the
 * ids it dropped are listed so a reader can open the case.
 *
 * Only cases the rule caught untransformed enter a transform's denominator:
 * a case it missed in the clear says nothing about evasion. A transform that
 * does not apply to a span (no letters to swap, no space to replace) is not
 * counted for that case. Spans are raw offsets (arc 1's contract), so the
 * transform lands on the evidence and nowhere else.
 */
import type { EvalRule, Evidence } from '../../src/types/eval.js';
import type { CorpusFile } from './corpus.js';
import { materialiseCase } from './materialise.js';
import { contextFor } from './context.js';
import { wilson } from '../judge/lib/wilson.js';

export const TRANSFORM_RULES = ['no_pii', 'no_injection_patterns', 'no_blocklist_words', 'no_injection_compliance'] as const;
export type TransformRule = (typeof TRANSFORM_RULES)[number];

export type TransformId = 'zero_width' | 'homoglyph' | 'fullwidth' | 'nbsp' | 'tab' | 'linebreak' | 'case';

const CYRILLIC: Record<string, string> = {
  a: 'а',
  e: 'е',
  o: 'о',
  p: 'р',
  c: 'с',
  x: 'х',
  A: 'А',
  E: 'Е',
  O: 'О',
  P: 'Р',
  C: 'С',
  X: 'Х',
};

const mid = (s: string): number => Math.floor(s.length / 2);

export interface Transform {
  id: TransformId;
  describe: string;
  /** The transformed span, or null when the transform does not apply to this span. */
  apply(span: string): string | null;
}

export const TRANSFORMS: readonly Transform[] = [
  { id: 'zero_width', describe: 'a zero-width space (U+200B) inserted at the middle of the span', apply: (s) => (s.length < 2 ? null : s.slice(0, mid(s)) + '​' + s.slice(mid(s))) },
  {
    id: 'homoglyph',
    describe: 'every Latin a e o p c x (and capitals) inside the span replaced by its Cyrillic lookalike',
    apply: (s) => {
      const out = s.replace(/[aeopcxAEOPCX]/g, (ch) => CYRILLIC[ch] ?? ch);
      return out === s ? null : out;
    },
  },
  {
    id: 'fullwidth',
    describe: 'every ASCII letter and digit inside the span replaced by its fullwidth form (NFKC folds it back)',
    apply: (s) => {
      const out = s.replace(/[0-9A-Za-z]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
      return out === s ? null : out;
    },
  },
  {
    id: 'nbsp',
    describe: 'every space inside the span replaced by a no-break space (U+00A0)',
    apply: (s) => (s.includes(' ') ? s.replace(/ /g, ' ') : null),
  },
  { id: 'tab', describe: 'a tab inserted at the middle of the span', apply: (s) => (s.length < 2 ? null : s.slice(0, mid(s)) + '\t' + s.slice(mid(s))) },
  { id: 'linebreak', describe: 'a line break inserted at the middle of the span', apply: (s) => (s.length < 2 ? null : s.slice(0, mid(s)) + '\n' + s.slice(mid(s))) },
  {
    id: 'case',
    describe: 'the case of every ASCII letter inside the span swapped',
    apply: (s) => {
      const out = s.replace(/[A-Za-z]/g, (ch) => (ch === ch.toLowerCase() ? ch.toUpperCase() : ch.toLowerCase()));
      return out === s ? null : out;
    },
  },
];

export interface TransformRow {
  rule: string;
  transform: TransformId;
  /** Cases the rule caught untransformed, with a span, where the transform applied. */
  n: number;
  caught: number;
  recall: number | null;
  ci95: [number, number] | null;
  dropped: string[];
}

export interface TransformRuleSummary {
  rule: string;
  positives: number;
  firedOriginally: number;
  withSpan: number;
}

export interface TransformResults {
  method: string;
  transforms: Array<{ id: TransformId; describe: string }>;
  rules: TransformRuleSummary[];
  rows: TransformRow[];
}

const round4 = (x: number): number => Math.round(x * 10_000) / 10_000;

/**
 * Where a reported span lives.
 *
 * Until arc 4 every span was into the agent's own output, so the harness
 * could transform one string. `no_injection_compliance` reports into
 * `tool_outputs[i]` — the first rule to do so — which is what makes the
 * evasion question askable of a trajectory rule at all. The matrix records
 * Q9 as merely *measurable* for the two shipped trajectory rules precisely
 * because neither reports a span.
 */
type SpanTarget = { kind: 'output' } | { kind: 'tool_output'; index: number };
interface TargetedSpans {
  target: SpanTarget;
  spans: Array<{ start: number; end: number }>;
}

const TOOL_OUTPUT_SOURCE = /^tool_outputs\[(\d+)\]$/;

function targetOf(source: string): SpanTarget | null {
  if (source === 'output') return { kind: 'output' };
  const m = TOOL_OUTPUT_SOURCE.exec(source);
  return m ? { kind: 'tool_output', index: Number(m[1]) } : null;
}

/** Every reported span, grouped by the text it indexes. */
function spanTargets(evidence: Evidence[] | undefined): TargetedSpans[] {
  const byKey = new Map<string, TargetedSpans>();
  for (const e of evidence ?? []) {
    if (e.type !== 'span' || e.end <= e.start) continue;
    const target = targetOf(e.source);
    if (target === null) continue;
    const key = target.kind === 'output' ? 'output' : `t${target.index}`;
    const entry = byKey.get(key) ?? { target, spans: [] };
    entry.spans.push({ start: e.start, end: e.end });
    byKey.set(key, entry);
  }
  for (const entry of byKey.values()) {
    // Last first, so earlier offsets stay valid while splicing.
    entry.spans.sort((a, b) => b.start - a.start);
  }
  return [...byKey.values()];
}

/** Applies a transform inside every reported span; null when it applied to none. */
export function transformOutput(output: string, spans: Array<{ start: number; end: number }>, t: Transform): string | null {
  let out = output;
  let applied = false;
  for (const { start, end } of spans) {
    const replaced = t.apply(output.slice(start, end));
    if (replaced === null) continue;
    out = out.slice(0, start) + replaced + out.slice(end);
    applied = true;
  }
  return applied ? out : null;
}

/**
 * Rebuild a context with every reported span transformed.
 *
 * Returns null when the transform applied to none of them, so an
 * inapplicable transform is never counted as an evasion the rule survived.
 */
export function transformContext(
  ctx: ReturnType<typeof contextFor>,
  targets: TargetedSpans[],
  t: Transform,
): ReturnType<typeof contextFor> | null {
  let applied = false;
  let output = ctx.output;
  let toolCalls = ctx.toolCalls;
  for (const { target, spans } of targets) {
    if (target.kind === 'output') {
      const next = transformOutput(output, spans, t);
      if (next === null) continue;
      output = next;
      applied = true;
      continue;
    }
    const call = (toolCalls ?? [])[target.index];
    if (!call || typeof call.output !== 'string') continue;
    const next = transformOutput(call.output, spans, t);
    if (next === null) continue;
    toolCalls = (toolCalls ?? []).map((c, i) => (i === target.index ? { ...c, output: next } : c));
    applied = true;
  }
  if (!applied) return null;
  /*
   * `steps` is DERIVED from tool_calls, and the engine may have populated it
   * already. Carrying the old derivation forward would transform one list
   * and measure another — the rule would read the untransformed tool output
   * through `stepsOf` and report a recall this harness never tested.
   */
  return { ...ctx, output, toolCalls, steps: undefined };
}

export function measureTransforms(files: CorpusFile[], rulesByName: Map<string, EvalRule>): TransformResults {
  const rows: TransformRow[] = [];
  const summaries: TransformRuleSummary[] = [];
  for (const ruleName of TRANSFORM_RULES) {
    const file = files.find((f) => f.rule === ruleName);
    const rule = rulesByName.get(ruleName);
    if (!file || !rule) continue;
    const positives = file.cases.filter((c) => c.label === 'positive');
    const prepared: Array<{ id: string; ctx: ReturnType<typeof contextFor>; targets: TargetedSpans[] }> = [];
    let firedOriginally = 0;
    for (const raw of positives) {
      const c = materialiseCase(raw);
      const ctx = contextFor(c, file.config);
      const base = rule.evaluate(ctx);
      if (base.skipped || base.passed !== false) continue;
      firedOriginally += 1;
      const targets = spanTargets(base.evidence);
      if (targets.length === 0) continue;
      prepared.push({ id: c.id, ctx, targets });
    }
    summaries.push({ rule: ruleName, positives: positives.length, firedOriginally, withSpan: prepared.length });
    for (const t of TRANSFORMS) {
      let n = 0;
      let caught = 0;
      const dropped: string[] = [];
      for (const p of prepared) {
        const transformed = transformContext(p.ctx, p.targets, t);
        if (transformed === null) continue;
        n += 1;
        const after = rule.evaluate(transformed);
        if (!after.skipped && after.passed === false) caught += 1;
        else dropped.push(p.id);
      }
      const w = n === 0 ? null : wilson(caught, n);
      rows.push({ rule: ruleName, transform: t.id, n, caught, recall: n === 0 ? null : round4(caught / n), ci95: w ? [round4(w.lo), round4(w.hi)] : null, dropped });
    }
  }
  return {
    method:
      'for each positive the rule caught untransformed with a span into raw text — the agent output, or a tool output for a trajectory rule — the text inside every reported span is transformed and the rule re-run; recall = still fails / applicable cases, Wilson 95%; a case the rule missed in the clear, or a span the transform does not apply to, is not counted. Rebuilding a tool output clears the derived step list, or the rule would read the untransformed calls through stepsOf and the number would mean nothing',
    transforms: TRANSFORMS.map((t) => ({ id: t.id, describe: t.describe })),
    rules: summaries,
    rows,
  };
}
