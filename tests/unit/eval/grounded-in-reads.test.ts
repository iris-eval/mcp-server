/*
 * grounded_in_reads (arc 4, A4-7).
 *
 * The proof family measures the rule on trajectories it JUDGES. This file
 * holds the paths a family must not contain — `proof/run.ts` scores a
 * skipped case as *not failed*, so a skipping negative is a free true
 * negative that inflates the published precision, and this rule's precision
 * is arithmetic inside the verdict.
 *
 * The truncation behaviour is the most important thing here, and it is not
 * a nicety. The rule's claim is a negative existential over the read set —
 * "this location appears in nothing you read" — so an incomplete read set
 * makes the claim unsound rather than merely uncertain. A rule that cannot
 * make its claim must not make it.
 */
import { describe, expect, it } from 'vitest';
import { groundedInReads } from '../../../src/eval/rules/safety.js';
import { GROUND_SCAN_CHARS_PER_CALL } from '../../../src/eval/rules/safety.js';
import type { EvalContext } from '../../../src/types/eval.js';

const run = (context: Partial<EvalContext>) => groundedInReads.evaluate({ output: '', ...context } as EvalContext);

describe('grounded_in_reads — when it declines to answer', () => {
  it('skips without a trajectory: an agent that read nothing has nothing to be ungrounded against', () => {
    const r = run({ output: 'The config is in src/config/invented.ts.', input: 'where is it' });
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(false);
    expect(r.skipReason).toContain('not provided');
  });

  it('skips on an empty trajectory rather than firing on every text-only answer', () => {
    const r = run({ output: 'The config is in src/config/invented.ts.', toolCalls: [] });
    expect(r.skipped).toBe(true);
  });

  it('declines when the producer says a read was truncated, and says why in those words', () => {
    const r = run({
      output: 'The exporter is in src/otel/invented.ts.',
      toolCalls: [{ tool_name: 'read_file', input: { path: 'src/otel/index.ts' }, output: 'export {}', truncated: true }],
    });
    expect(r.skipped).toBe(true);
    expect(r.evidenceIncomplete).toBe(true);
    expect(r.skipReason).toContain('not evidence it was invented');
  });

  it('declines on an elision marker, because Iris truncates nothing itself', () => {
    const r = run({
      output: 'The exporter is in src/otel/invented.ts.',
      toolCalls: [{ tool_name: 'bash', input: { command: 'ls src/otel' }, output: 'index.ts\nmapper.ts\n[truncated]' }],
    });
    expect(r.skipped).toBe(true);
    expect(r.evidenceIncomplete).toBe(true);
  });

  it('declines when its own scan budget would have made the read partial', () => {
    // Self-inflicted incompleteness counts, which makes the budget and the
    // soundness argument the same argument: the rule can never quietly
    // reason over a slice it chose for itself.
    const r = run({
      output: 'The exporter is in src/otel/invented.ts.',
      toolCalls: [{ tool_name: 'read_file', input: { path: 'big.txt' }, output: 'x'.repeat(GROUND_SCAN_CHARS_PER_CALL + 1) }],
    });
    expect(r.skipped).toBe(true);
    expect(r.evidenceIncomplete).toBe(true);
  });

  it('an evidence-incomplete skip is `defeated`, not merely not-applicable', () => {
    // The distinction decides what a deployment that promotes this rule to
    // critical gets: unknown, or a clean bill of health it did not earn.
    const r = run({
      output: 'x',
      toolCalls: [{ tool_name: 'read_file', input: { path: 'a.ts' }, output: 'a', truncated: true }],
    });
    expect(r.evidenceIncomplete).toBe(true);
    expect(r.skipped).toBe(true);
  });
});

describe('grounded_in_reads — what it will not call a fabrication', () => {
  const listing = [{ tool_name: 'bash', input: { command: 'ls docs' }, output: 'architecture.md\notel-integration.md' }];

  it('a code identifier, a version and a number are not locations', () => {
    const r = run({
      output: 'Call EvalEngine.evaluateAll at version 0.11.0; it examined 4318 rows and set IRIS_OTEL_ENDPOINT.',
      input: 'what does it do',
      toolCalls: listing,
    });
    expect(r.passed).toBe(true);
  });

  it('a URL template built from an environment variable is not a location', () => {
    const r = run({ output: 'It posts to $IRIS_OTEL_ENDPOINT/v1/traces on every flush.', input: 'where does it post', toolCalls: listing });
    expect(r.passed).toBe(true);
  });

  it('evidence points with offsets and names the class, never the token', () => {
    const r = run({ output: 'It is documented in docs/invented-page.md.', input: 'where', toolCalls: listing });
    expect(r.passed).toBe(false);
    const spans = (r.evidence ?? []).filter((e) => e.type === 'span');
    expect(spans.length).toBeGreaterThan(0);
    for (const s of spans) {
      expect((s as { label: string }).label).not.toContain('invented-page');
      expect((s as { source: string }).source).toBe('output');
    }
  });

  it('the span offsets index the raw output, so a reader can slice it', () => {
    const output = 'It is documented in docs/invented-page.md.';
    const r = run({ output, input: 'where', toolCalls: listing });
    const span = (r.evidence ?? []).find((e) => e.type === 'span') as { start: number; end: number };
    expect(output.slice(span.start, span.end)).toContain('invented-page.md');
  });
});
