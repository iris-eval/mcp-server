/*
 * What the relevance judge keeps from its provider: every span no_pii
 * flags, replaced by a numbered marker, with one numbering across the ask
 * and the answer. The detector is no_pii's own (scanPii), so these cases
 * are about the redaction, and the rule's own tests are about detection.
 */
import { describe, expect, it } from 'vitest';
import { redactForJudge, redactionMarker } from '../../../../src/eval/llm-judge/redact.js';
import { noPii, scanPii } from '../../../../src/eval/rules/safety.js';

describe('redactForJudge', () => {
  it('replaces what no_pii flags in both texts, one number per value, shared across them', () => {
    const r = redactForJudge(
      'Email ana@fastmail.com or bo@proton.me about SSN 219-09-9999.',
      'I wrote to ana@fastmail.com; bo@proton.me did not answer.',
    );
    expect(r.input).toBe(`Email ${redactionMarker('Email', 1)} or ${redactionMarker('Email', 2)} about SSN ${redactionMarker('SSN', 1)}.`);
    expect(r.output).toBe(`I wrote to ${redactionMarker('Email', 1)}; ${redactionMarker('Email', 2)} did not answer.`);
    expect(r.replaced).toEqual({ Email: 4, SSN: 1 });
  });

  it('leaves text with nothing flagged exactly as it was, documentation placeholders included', () => {
    const input = 'Write to support@example.com or call 555-0100 about the invoice.';
    const r = redactForJudge(input, 'Done.');
    expect(r).toEqual({ input, output: 'Done.', replaced: {} });
  });

  it('removes every match, not only the 25 the rule keeps as evidence', () => {
    const emails = Array.from({ length: 40 }, (_, i) => `user${i}@corp-mail.net`).join(', ');
    const r = redactForJudge('List the addresses.', emails);
    expect(r.output).not.toMatch(/@corp-mail\.net/);
    expect(r.replaced.Email).toBe(40);
    // The rule's evidence stays capped as before.
    expect(scanPii(emails).spans).toHaveLength(25);
  });

  it('replaces a value hidden in a base64 run, every run', () => {
    const a = Buffer.from('my ssn is 219-09-9999 ok').toString('base64');
    const b = Buffer.from('card 4111 1111 1111 1112 thanks').toString('base64');
    const r = redactForJudge('Decode these.', `first ${a} then ${b}`);
    expect(r.output).not.toContain(a);
    expect(r.output).toMatch(/^first \[REDACTED:SSN \(base64-encoded\)#1\] then /);
  });

  it('merges overlapping findings into one marker rather than corrupting the text between them', () => {
    // Secret Assignment claims `password=sk-…`, API Key claims `sk-…` inside it.
    const output = 'Set password=sk-Zq9aB3dE7fG1hJ5kL2mN8pQ4rS in the env file.';
    expect(scanPii(output, { limit: Infinity }).spans.map((s) => [s.label, s.start, s.end])).toEqual([
      ['API Key', 13, 42],
      ['Secret Assignment', 4, 42],
    ]);
    const r = redactForJudge('Where is the key?', output);
    expect(r.output).toBe('Set [REDACTED:Secret Assignment#1] in the env file.');
    expect(r.replaced).toEqual({ 'Secret Assignment': 1 });
  });

  it('no_pii still reads what it read: the same finding, the same evidence', () => {
    const output = 'Reach me at ana@fastmail.com, SSN 219-09-9999.';
    const result = noPii.evaluate({ output, input: 'Who are you?' });
    expect(result.passed).toBe(false);
    expect(result.message).toBe('Potential PII detected: SSN, Email');
    expect(result.evidence).toEqual([
      { type: 'span', source: 'output', start: 34, end: 45, label: 'SSN' },
      { type: 'span', source: 'output', start: 12, end: 28, label: 'Email' },
    ]);
  });
});
