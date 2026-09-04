/*
 * Confusion-matrix arithmetic shared by the judge and citation halves of
 * the runner. "Positive" is whatever the caller says it is — the judge
 * half uses positive = the judge FAILED the output (it flagged a problem),
 * the citation half uses positive = the verifier rated the citation
 * SUPPORTED. Each results block names its positive class so a reader never
 * has to guess which way precision points.
 */

import { wilson, type WilsonInterval } from './wilson.js';

export interface Confusion {
  tp: number;
  fp: number;
  fn: number;
  tn: number;
}

export interface Summary extends Confusion {
  n: number;
  accuracy: number | null;
  precision: number | null;
  recall: number | null;
  f1: number | null;
  ci95: {
    accuracy: WilsonInterval | null;
    precision: WilsonInterval | null;
    recall: WilsonInterval | null;
  };
}

export function emptyConfusion(): Confusion {
  return { tp: 0, fp: 0, fn: 0, tn: 0 };
}

/** Adds one observation. `actual` and `predicted` are "is positive". */
export function tally(c: Confusion, actual: boolean, predicted: boolean): void {
  if (actual && predicted) c.tp++;
  else if (!actual && predicted) c.fp++;
  else if (actual && !predicted) c.fn++;
  else c.tn++;
}

export function round4(x: number | null): number | null {
  return x === null ? null : Math.round(x * 10_000) / 10_000;
}

function roundInterval(i: WilsonInterval | null): WilsonInterval | null {
  return i === null ? null : { lo: round4(i.lo) as number, hi: round4(i.hi) as number };
}

function ratio(num: number, den: number): number | null {
  return den === 0 ? null : num / den;
}

export function summarise(c: Confusion): Summary {
  const n = c.tp + c.fp + c.fn + c.tn;
  const precision = ratio(c.tp, c.tp + c.fp);
  const recall = ratio(c.tp, c.tp + c.fn);
  const f1 =
    precision === null || recall === null || precision + recall === 0
      ? null
      : (2 * precision * recall) / (precision + recall);
  return {
    ...c,
    n,
    accuracy: round4(ratio(c.tp + c.tn, n)),
    precision: round4(precision),
    recall: round4(recall),
    f1: round4(f1),
    // No closed-form interval exists for F1; only the three proportions
    // get one. Stating "none" beats inventing a bootstrap the reader cannot
    // reproduce from the numbers on the page.
    ci95: {
      accuracy: roundInterval(n === 0 ? null : wilson(c.tp + c.tn, n)),
      precision: roundInterval(c.tp + c.fp === 0 ? null : wilson(c.tp, c.tp + c.fp)),
      recall: roundInterval(c.tp + c.fn === 0 ? null : wilson(c.tp, c.tp + c.fn)),
    },
  };
}
