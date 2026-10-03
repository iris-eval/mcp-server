/*
 * What the relevance judge keeps from its provider.
 *
 * The judge sends an evaluation's input and output to Anthropic or OpenAI.
 * Iris's own no_pii detector exists to say "this text leaks a secret", so
 * sending that secret to a third party in the same breath would be the leak
 * the product warns about. Before a judge call, every span no_pii would flag
 * in either text — PII and credentials, including values hidden in a base64
 * run — is replaced by a marker. The detector is scanPii from
 * rules/safety.ts, the one no_pii itself reads: no second list of patterns
 * to drift from the first.
 *
 * Markers are numbered per distinct value, and the numbering is shared by
 * the input and the output: an answer that repeats the email address the
 * ask gave carries the same marker the ask does, so the judge can still see
 * that the answer is about what was asked. Relevance is a question about
 * subject, not about the digits of a card number, which is why redaction is
 * the default rather than an option (docs/llm-as-judge.md has the reasoning
 * and the opt-out).
 *
 * The email exemption no_pii applies (an address the input supplied is not
 * a leak when the output repeats it) is deliberately NOT applied here: that
 * exemption is about the agent's verdict, while this is about what leaves
 * the machine, and an address is personal data either way.
 */
import { scanPii, type PiiSpan } from '../rules/safety.js';
import { readStructured, spanInOutput } from '../text/structured.js';

export interface RedactedPair {
  input: string;
  output: string;
  /** Values replaced, counted per detector label across both texts; empty when nothing was. */
  replaced: Record<string, number>;
}

/** The marker text for one redacted value. Exported so the judge's prompt and the tests name it once. */
export function redactionMarker(label: string, n: number): string {
  return `[REDACTED:${label}#${n}]`;
}

/**
 * Overlapping findings merged into one span, earliest start first. Two
 * patterns can claim one value (a key inside a `password=` assignment), and
 * splicing both would corrupt the text between their ends.
 */
function mergeSpans(spans: readonly PiiSpan[]): PiiSpan[] {
  const sorted = [...spans].filter((s) => s.end > s.start).sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: PiiSpan[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start < last.end) {
      if (s.end > last.end) last.end = s.end;
      continue;
    }
    merged.push({ ...s });
  }
  return merged;
}

/** Redact both texts with one numbering, so a value that appears in both carries one marker. */
export function redactForJudge(input: string, output: string): RedactedPair {
  const numbering = new Map<string, number>();
  const nextByLabel = new Map<string, number>();
  const replaced: Record<string, number> = {};

  const redact = (text: string): string => {
    /*
     * What no_pii flags is what is kept from the provider, so a structured
     * text is scanned the way no_pii reads it too: its labelled reading,
     * where a date of birth is recognised by its label and a secret by the
     * name it is assigned to, mapped back onto the text as sent.
     */
    const found = [...scanPii(text, { limit: Infinity, everyEncodedRun: true }).spans];
    const structured = readStructured(text);
    if (structured !== null) {
      for (const s of scanPii(structured.labelled.text, { limit: Infinity, everyEncodedRun: true }).spans) found.push({ ...s, ...spanInOutput(structured.labelled, s.start, s.end) });
    }
    const spans = mergeSpans(found);
    if (spans.length === 0) return text;
    let out = '';
    let at = 0;
    for (const { start, end, label } of spans) {
      const value = text.slice(start, end);
      const key = `${label}\u0000${value}`;
      let n = numbering.get(key);
      if (n === undefined) {
        n = (nextByLabel.get(label) ?? 0) + 1;
        nextByLabel.set(label, n);
        numbering.set(key, n);
      }
      replaced[label] = (replaced[label] ?? 0) + 1;
      out += text.slice(at, start) + redactionMarker(label, n);
      at = end;
    }
    return out + text.slice(at);
  };

  return { input: redact(input), output: redact(output), replaced };
}
