/*
 * Significance color + glyph mapping.
 *
 * The same palette + glyphs are used on the timeline dots and the detail
 * surface header so the visual signal is consistent across pages. Color +
 * glyph together (not color alone) so the encoding is colorblind-safe.
 */
import type { MomentSignificanceKind, MomentVerdict } from '../../api/types';

export interface SignificanceVisual {
  /** OKLCH color token (one of the --accent-* tokens). */
  color: string;
  /** Background tint for cards/badges. */
  bg: string;
  /** Single-character glyph that conveys the category in monochrome. */
  glyph: string;
  /** Human-readable category name. */
  name: string;
  /** One-line description of when this kind fires. */
  description: string;
}

const VISUALS: Record<MomentSignificanceKind, SignificanceVisual> = {
  'safety-violation': {
    color: 'var(--accent-error)',
    bg: 'oklch(28% 0.10 25 / 0.20)',
    glyph: '!',
    name: 'Safety violation',
    description:
      'A safety rule failed (PII, prompt injection, blocklist, stub-output). Highest priority — review before this pattern becomes load-bearing.',
  },
  'cost-spike': {
    color: 'var(--accent-warning)',
    bg: 'oklch(28% 0.10 80 / 0.20)',
    glyph: '$',
    name: 'Cost spike',
    description:
      'Trace cost crossed the per-trace threshold. Investigate prompt size, token efficiency, or model-tier choice.',
  },
  'first-failure': {
    color: 'var(--accent-llm)',
    bg: 'oklch(28% 0.12 295 / 0.20)',
    glyph: '◇',
    name: 'First failure',
    description: 'First time this rule has failed for this agent recently.',
  },
  'novel-pattern': {
    color: 'var(--accent-llm)',
    bg: 'oklch(28% 0.12 295 / 0.20)',
    glyph: '◈',
    name: 'Novel pattern',
    description:
      'Failure-rule combination has not been seen for this agent before.',
  },
  'rule-collision': {
    color: 'var(--accent-warning)',
    bg: 'oklch(28% 0.10 80 / 0.20)',
    glyph: '×',
    name: 'Multi-category fail',
    description:
      'Failures span multiple eval categories — output failed in more than one dimension.',
  },
  'normal-fail': {
    color: 'var(--accent-error)',
    bg: 'oklch(28% 0.10 25 / 0.12)',
    glyph: '×',
    name: 'Fail',
    description: 'A rule failed; the failure does not elevate to a higher category.',
  },
  'normal-pass': {
    color: 'var(--accent-success)',
    bg: 'oklch(28% 0.10 145 / 0.12)',
    glyph: '✓',
    name: 'Pass',
    description: 'All fired rules passed.',
  },
};

export function getSignificanceVisual(kind: MomentSignificanceKind): SignificanceVisual {
  return VISUALS[kind] ?? VISUALS['normal-pass'];
}

export function getVerdictVisual(verdict: MomentVerdict): {
  label: string;
  color: string;
} {
  switch (verdict) {
    case 'pass':
      return { label: 'PASS', color: 'var(--accent-success)' };
    case 'fail':
      return { label: 'FAIL', color: 'var(--accent-error)' };
    case 'partial':
      return { label: 'PARTIAL', color: 'var(--accent-warning)' };
    case 'unevaluated':
      return { label: 'UNEVALUATED', color: 'var(--text-muted)' };
  }
}

export const SIGNIFICANCE_KIND_OPTIONS: Array<{
  value: MomentSignificanceKind | '';
  label: string;
}> = [
  { value: '', label: 'All significance' },
  { value: 'safety-violation', label: 'Safety violations' },
  { value: 'cost-spike', label: 'Cost spikes' },
  { value: 'rule-collision', label: 'Multi-category fails' },
  { value: 'normal-fail', label: 'Other fails' },
  { value: 'normal-pass', label: 'Passes' },
];

export const VERDICT_OPTIONS: Array<{ value: MomentVerdict | ''; label: string }> = [
  { value: '', label: 'All verdicts' },
  { value: 'pass', label: 'Pass' },
  { value: 'partial', label: 'Partial' },
  { value: 'fail', label: 'Fail' },
  { value: 'unevaluated', label: 'Unevaluated' },
];
