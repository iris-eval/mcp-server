/*
 * The vocabulary one rule result is read in (arc 7, D-3): what a kind is,
 * what the composer did with it (role), what its error bar means, and how
 * each piece of evidence is said. Pure functions and constants; the row
 * renders them and the tests hold the table.
 */
import type { EvalRuleResult, Evidence, Uncertainty } from '../../api/types';

export type RuleState = 'passed' | 'failed' | 'skipped';

export function ruleState(r: Pick<EvalRuleResult, 'passed' | 'skipped'>): RuleState {
  return r.skipped ? 'skipped' : r.passed ? 'passed' : 'failed';
}

export const KIND_TEXT: Record<NonNullable<EvalRuleResult['kind']>, string> = {
  measurement:
    'Measurement: a number about the output (length, ratio, cost). It is reported and never decides the verdict on its own.',
  detection:
    'Detection: a pattern that fires on something in the output. It has a published error rate and feeds the risk estimate.',
  inference:
    'Inference: a judgement the rule makes from what it can read, with a published error rate. It feeds the risk estimate.',
  judgment: 'Judgment: the LLM judge answered a question about the output. It gates the verdict.',
  policy:
    'Policy: a threshold. It gates the verdict when you set the number, and only advises when the shipped default applies.',
  verification: 'Verification: something checked against a source — a citation resolved, a schema conformed.',
};

export const ROLE_TEXT: Record<NonNullable<EvalRuleResult['role']>, string> = {
  gate: 'Gate: this rule decided the verdict directly.',
  veto: 'Veto: a critical rule. A fail here fails the evaluation regardless of anything else.',
  risk: 'Risk: this rule fed the risk estimate; the verdict came from that estimate against your loss setting.',
  advisory: 'Advisory: reported, never decisive. A fail here does not change the verdict.',
};

export const SKIP_CLASS_TEXT: Record<NonNullable<EvalRuleResult['skipClass']>, string> = {
  not_applicable: 'Not applicable: the rule had nothing to judge on this input.',
  defeated: 'Defeated: the input was there but the rule could not read it — truncated, malformed, or over its time budget.',
  config_invalid: 'Configuration invalid: the rule was configured with a value it cannot use.',
};

export const CRITICAL_SOURCE_TEXT: Record<'default' | 'config', string> = {
  default: 'Critical by the shipped default: a fail here vetoes the evaluation. Change it under eval.criticalRules.',
  config: 'Critical by your configuration (eval.criticalRules): a fail here vetoes the evaluation.',
};

/** A row stamped before 0.9.0 carries none of the fields the composer now emits. */
export const PRE_STAMP_TEXT =
  'Evaluated before 0.9.0: no kind, role, evidence or error bar was recorded for this rule. Re-evaluate the trace to see them.';

export interface Interval {
  point: number;
  lo: number;
  hi: number;
}

export function fmtInterval(i: Interval): string {
  return `${i.point.toFixed(2)} [${i.lo.toFixed(2)}, ${i.hi.toFixed(2)}]`;
}

const pct = (x: number): string => `${Math.round(x * 100)}%`;

export interface UncertaintyText {
  /** Short, for the row: "PPV 0.71 [0.58, 0.82]". */
  label: string;
  /** One or two sentences, for the tooltip. */
  sentence: string;
}

export function describeUncertainty(u: Uncertainty | undefined): UncertaintyText | null {
  if (!u) return null;
  switch (u.basis) {
    case 'published_accuracy': {
      const corpus = `Measured on ${u.corpus.n} labelled cases (corpus ${u.corpus.version}, release ${u.corpus.release}, ${u.corpus.labelling === 'human-verified' ? 'human-verified labels' : 'same-model labels'}).`;
      const prior = `at a prior of ${u.prior.pi.toFixed(2)} (${u.prior.source})`;
      if (u.fired) {
        return {
          label: `PPV ${fmtInterval(u.ppv)}`,
          sentence: `When this rule fires, the output is bad ${pct(u.ppv.point)} of the time (95% interval ${pct(u.ppv.lo)}–${pct(u.ppv.hi)}) ${prior}. ${corpus}`,
        };
      }
      return {
        label: `miss rate ${fmtInterval(u.missRate)}`,
        sentence: `When this rule stays quiet, a bad output of its class slips past ${pct(u.missRate.point)} of the time (95% interval ${pct(u.missRate.lo)}–${pct(u.missRate.hi)}) ${prior}. ${corpus}`,
      };
    }
    case 'definition':
      return {
        label: `conformance ${u.conformance.matched}/${u.conformance.n}`,
        sentence: `This rule is right by definition — a schema or a pattern — and ${u.conformance.matched} of ${u.conformance.n} conformance cases matched it.`,
      };
    case 'self_consistency':
      return {
        label: `${u.samples} samples · ${pct(u.voteFraction)} agree`,
        sentence: `The judge was sampled ${u.samples} times; ${pct(u.voteFraction)} of the samples agreed, with a score spread of ${u.scoreSd.toFixed(2)}.`,
      };
    case 'local_labels':
      return {
        label: `local precision ${fmtInterval(u.precision)}`,
        sentence: `From ${u.n} of your own labels on this deployment, this rule's fires were right ${pct(u.precision.point)} of the time (95% interval ${pct(u.precision.lo)}–${pct(u.precision.hi)}).`,
      };
    case 'policy':
      return {
        label: 'policy',
        sentence: 'A threshold, not a detector: it has no error rate. It is right by the number you set.',
      };
    case 'unmeasured':
      return { label: 'unmeasured', sentence: `No published error rate: ${u.why}` };
    default:
      return null;
  }
}

export interface EvidenceTexts {
  output?: string;
  input?: string;
  toolOutputs?: string[];
}

export interface EvidenceText {
  type: string;
  /** The short form: "output[12–40] · secret" or "pattern api_key ×2". */
  text: string;
  /** The quoted excerpt when the page had the text the span points into. */
  quote?: string;
  /** For toolCall evidence: the call's index, so the row can link to it. */
  callIndex?: number;
}

const QUOTE_MAX = 140;

function excerpt(text: string | undefined, start: number, end: number): string | undefined {
  if (typeof text !== 'string') return undefined;
  const raw = text.slice(Math.max(0, start), Math.max(start, end));
  if (!raw) return undefined;
  const oneLine = raw.replace(/\s+/g, ' ').trim();
  return oneLine.length > QUOTE_MAX ? `${oneLine.slice(0, QUOTE_MAX - 1)}…` : oneLine;
}

function sourceText(source: string, texts?: EvidenceTexts): string | undefined {
  if (!texts) return undefined;
  if (source === 'output') return texts.output;
  if (source === 'input') return texts.input;
  const m = /^tool_outputs\[(\d+)\]$/.exec(source);
  if (m) return texts.toolOutputs?.[Number(m[1])];
  return undefined;
}

// The dashboard's Evidence union keeps a catch-all member for types a newer
// server may send, so `e.type === 'span'` does not narrow on its own.
type Of<T extends string> = Extract<Evidence, { type: T }>;

export function describeEvidence(e: Evidence, texts?: EvidenceTexts): EvidenceText {
  switch (e.type) {
    case 'span': {
      const s = e as Of<'span'>;
      return {
        type: 'span',
        text: `${s.source}[${s.start}–${s.end}] · ${s.label}`,
        quote: excerpt(sourceText(s.source, texts), s.start, s.end),
      };
    }
    case 'pattern': {
      const s = e as Of<'pattern'>;
      return { type: 'pattern', text: `pattern ${s.name} ×${s.count}` };
    }
    case 'toolCall': {
      const s = e as Of<'toolCall'>;
      return { type: 'toolCall', text: `call #${s.index} ${s.toolName} · ${s.label}`, callIndex: s.index };
    }
    case 'citation': {
      const s = e as Of<'citation'>;
      return { type: 'citation', text: `${s.url} · ${s.status}` };
    }
    case 'count': {
      const s = e as Of<'count'>;
      return {
        type: 'count',
        text:
          `${s.stat} ${s.value} ${s.unit}` +
          (s.threshold !== undefined ? ` (threshold ${s.threshold}${s.thresholdSource ? `, ${s.thresholdSource}` : ''})` : ''),
      };
    }
    default: {
      const rest = Object.entries(e)
        .filter(([k]) => k !== 'type')
        .map(([k, v]) => `${k} ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
        .join(' · ');
      return { type: e.type, text: rest ? `${e.type} · ${rest}` : e.type };
    }
  }
}

/** True when the row predates the stamp: none of the composer's fields is present. */
export function isPreStamp(r: EvalRuleResult): boolean {
  return r.kind === undefined && r.role === undefined && r.evidence === undefined && r.uncertainty === undefined;
}
