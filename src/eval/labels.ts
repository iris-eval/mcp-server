/*
 * Labels on the user's own traffic (arc 7, D-8; plan §4.13) — the arithmetic.
 *
 * A published precision is agreement with one labeller on one corpus. A
 * deployment's own labels on its own fires are the number a reader can
 * actually trust for their traffic: per rule, local precision =
 * right / (right + wrong) over labelled fires, with a Wilson interval, and
 * at LOCAL_LABEL_MIN labels that rule's rows carry `uncertainty.basis:
 * 'local_labels'` and its positive predictive value in the risk estimate
 * is the deployment's own — the one place the risk model learns from the
 * deployment. Labels on fires measure precision only; the surface says
 * "local precision", never "local accuracy".
 *
 * The prior estimate: a rule that fires on a fraction f of traffic with
 * local precision p̂ sees f·p̂ true fires, and f·p̂ ≈ π·sens, so
 * π̂ = f·p̂ / sens — labelled `estimated`, with the interval that follows
 * from p̂'s. The sampling suggestion names the rule whose next label
 * narrows the most traffic-weighted uncertainty: gain_r = f_r ·
 * (halfwidth(n_r) − halfwidth(n_r + 1)) at p̂_r. Issues are fires grouped
 * by rule and evidence signature, so ten fires of one pattern read as one
 * issue with a count.
 */
import { createHash } from 'node:crypto';
import type { Evidence, EvalRuleResult } from '../types/eval.js';
import { wilson, type WilsonInterval } from './stats.js';

/** Labels on a rule's fires before its local precision replaces the published number. */
export const LOCAL_LABEL_MIN = 20;

/** How many recent evaluations the fire rate and the issues are read over. */
export const LOCAL_LABEL_WINDOW = 2000;

export interface LabelTally {
  ruleName: string;
  right: number;
  wrong: number;
}

export interface LocalPrecision {
  ruleName: string;
  n: number;
  right: number;
  wrong: number;
  /** Wilson interval on right / (right + wrong); null below one label. */
  precision: (WilsonInterval & { point: number }) | null;
  /** True at LOCAL_LABEL_MIN labels: the rule's number on this deployment is its own. */
  local: boolean;
}

export function localPrecision(t: LabelTally): LocalPrecision {
  const n = t.right + t.wrong;
  const w = n > 0 ? wilson(t.right, n) : null;
  return { ruleName: t.ruleName, n, right: t.right, wrong: t.wrong, precision: w ? { ...w, point: t.right / n } : null, local: n >= LOCAL_LABEL_MIN };
}

/** The Wilson half-width at n labels for a precision p̂, in probability points. */
export function halfwidthAt(p: number, n: number): number {
  if (n <= 0) return 0.5;
  const w = wilson(Math.round(p * n), n);
  return w ? (w.hi - w.lo) / 2 : 0.5;
}

export interface EstimatedPrior {
  /** π̂ = f · p̂ / sens, clamped to (0.01, 0.99). */
  pi: number;
  lo: number;
  hi: number;
  /** The rule the estimate came from. */
  ruleName: string;
  fireRate: number;
  sensitivity: number;
}

/**
 * The prior a rule's own fires imply: f · p̂ / sens, with the interval that
 * follows from p̂'s Wilson interval. Null when the rule has not reached
 * LOCAL_LABEL_MIN labels, fires on nothing, or has no published sensitivity.
 */
export function estimatedPrior(rule: LocalPrecision, fireRate: number, sensitivity: number): EstimatedPrior | null {
  if (!rule.local || rule.precision === null || !(fireRate > 0) || !(sensitivity > 0)) return null;
  const clamp = (x: number): number => Math.min(0.99, Math.max(0.01, x));
  return {
    pi: clamp((fireRate * rule.precision.point) / sensitivity),
    lo: clamp((fireRate * rule.precision.lo) / sensitivity),
    hi: clamp((fireRate * rule.precision.hi) / sensitivity),
    ruleName: rule.ruleName,
    fireRate,
    sensitivity,
  };
}

export interface SamplingSuggestion {
  ruleName: string;
  n: number;
  /** The half-width of the rule's local precision at n labels, in points. */
  halfwidthPoints: number;
  fireRate: number;
  /** In words, for the panel: "label a `rule` fire next: 4 labelled, ±38 points, fires on 12% of your traffic". */
  sentence: string;
}

/**
 * Which rule's next label buys the most: the traffic-weighted narrowing of
 * the interval, gain_r = f_r · (halfwidth(n_r) − halfwidth(n_r + 1)) at
 * p̂_r (0.5 before any label — the widest case). Null when no rule fires.
 */
export function samplingSuggestion(rules: ReadonlyArray<{ precision: LocalPrecision; fireRate: number }>): SamplingSuggestion | null {
  let best: { gain: number; s: SamplingSuggestion } | null = null;
  for (const { precision, fireRate } of rules) {
    if (!(fireRate > 0)) continue;
    const p = precision.precision?.point ?? 0.5;
    const n = precision.n;
    const gain = fireRate * (halfwidthAt(p, n) - halfwidthAt(p, n + 1));
    if (best === null || gain > best.gain) {
      const hw = Math.round(halfwidthAt(p, n) * 100);
      best = {
        gain,
        s: {
          ruleName: precision.ruleName,
          n,
          halfwidthPoints: hw,
          fireRate,
          sentence: `label a ${precision.ruleName} fire next: ${n} labelled, ±${hw} points, fires on ${(fireRate * 100).toFixed(0)}% of your traffic`,
        },
      };
    }
  }
  return best?.s ?? null;
}

/**
 * The evidence signature of a fire — what the rule found, named the way the
 * rule names it: a pattern or signal, a tool name with its failure reason
 * for a trajectory rule, a measured stat, else the message's head. Two
 * fires with one signature are one issue.
 */
export function evidenceSignature(r: Pick<EvalRuleResult, 'evidence' | 'message'>): string {
  const first = (r.evidence ?? [])[0] as (Evidence & Record<string, unknown>) | undefined;
  if (first) {
    const s = (v: unknown): string | null => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);
    switch (first.type) {
      case 'pattern':
        return `pattern:${s(first.name) ?? s(first.pattern) ?? 'unnamed'}`;
      case 'toolCall':
        return `tool:${s(first.toolName) ?? 'unknown'}:${s(first.label) ?? 'call'}`;
      case 'count':
        return `count:${s(first.stat) ?? 'value'}`;
      case 'span':
        return `span:${s(first.label) ?? s(first.kind) ?? 'span'}`;
      case 'citation':
        return `citation:${s(first.status) ?? 'unresolved'}`;
      default:
        return `${first.type}:${s(first.label) ?? s(first.name) ?? ''}`;
    }
  }
  return `message:${(r.message ?? '').replace(/\d+(\.\d+)?/g, '#').slice(0, 40)}`;
}

/** The issue key: (rule, sha256(signature)) to twelve hex characters. */
export function issueKey(ruleName: string, signature: string): string {
  return createHash('sha256').update(`${ruleName}|${signature}`).digest('hex').slice(0, 12);
}
