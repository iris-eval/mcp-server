/*
 * ask_coverage (arc 4, A4-8).
 *
 * The family measures the rule on asks it JUDGES. This file holds the paths
 * it declines — the proof runner scores a skip as *not failed*, so a
 * skipping case in a family is a free true negative that inflates the
 * published precision, and this rule's precision is arithmetic in a verdict.
 *
 * The most important assertions here are the ones about what is NOT split.
 * The rule only judges an ask that declares its own parts, and that scope
 * was forced by measurement rather than chosen: splitting prose too meant
 * four rounds of tuning in which every constant that fixed a false positive
 * on the real transcripts destroyed recall on the corpus.
 */
import { describe, expect, it } from 'vitest';
import { askCoverage } from '../../../src/eval/rules/completeness.js';
import { MAX_ASK_CHARS, splitAsk } from '../../../src/eval/text/asks.js';
import type { EvalContext } from '../../../src/types/eval.js';

const run = (input: string, output: string) => askCoverage.evaluate({ input, output } as EvalContext);

describe('ask_coverage — what it declines to judge', () => {
  it('skips without an input: the parts of an ask cannot be counted without the ask', () => {
    const r = askCoverage.evaluate({ output: 'Something.' } as EvalContext);
    expect(r.skipped).toBe(true);
    expect(r.passed).toBe(false);
  });

  it('skips on an empty output, which non_empty_output already judges', () => {
    const r = run('Tell me (1) the port and (2) the host.', '   ');
    expect(r.skipped).toBe(true);
    // One output should not carry two failure classes, or the risk estimate
    // counts the same defect twice.
    expect(r.skipReason).toContain('non_empty_output');
  });

  it('skips on an input long enough to be source material rather than an ask', () => {
    const r = run(`Summarise this.\n${'x '.repeat(MAX_ASK_CHARS)}`, 'A summary.');
    expect(r.skipped).toBe(true);
    expect(r.skipReason).toContain('source material');
  });

  it('skips a single-part ask, which is a different question entirely', () => {
    const r = run('What port does the dashboard bind?', 'It binds 6920.');
    expect(r.skipped).toBe(true);
  });
});

describe('ask_coverage — a full stop declares nothing', () => {
  it('a prose multi-part ask is ONE part, so the rule skips rather than guessing', () => {
    // The scope decision. A writer who numbers their questions is declaring
    // separate things; a sentence boundary is not that declaration, and a
    // lexical test cannot tell a second deliverable from a restatement, a
    // manner instruction or a line of pasted material.
    expect(splitAsk('Explain the composer. Also say what it replaced.')).toHaveLength(1);
    const r = run('Explain the composer. Also say what it replaced.', 'It reads each rule by kind.');
    expect(r.skipped).toBe(true);
  });

  it('a bare "and" never splits', () => {
    expect(splitAsk('Please review and merge the pull request.')).toHaveLength(1);
    expect(splitAsk('Read src/index.ts and tell me the port.')).toHaveLength(1);
  });

  it('one lone marker is not an enumeration', () => {
    expect(splitAsk('Look at step 3) of the pipeline and tell me what it does.')).toHaveLength(1);
  });

  it('a lone bullet is prose; two are a list', () => {
    expect(splitAsk('- Just the one thing here')).toHaveLength(1);
    expect(splitAsk('- The first thing\n- The second thing')).toHaveLength(2);
  });

  it('markers out of sequence are not an enumeration', () => {
    expect(splitAsk('See (3) and then (1) for the details of the pipeline.')).toHaveLength(1);
  });
});

describe('ask_coverage — the three ways an ask declares its parts', () => {
  it('numbered, lettered and ordinal-word asks all split', () => {
    expect(splitAsk('Tell me (1) the port and (2) the host.')).toHaveLength(2);
    expect(splitAsk('Cover (a) the port and (b) the host.')).toHaveLength(2);
    expect(splitAsk('First, give me the port. Second, give me the host.')).toHaveLength(2);
  });

  it('an uncovered part is named with a span into the ask itself', () => {
    const input = 'Tell me (1) what the dashboard port is and (2) which config key changes the retention window.';
    const r = run(input, 'The dashboard port is 6920.');
    expect(r.passed).toBe(false);
    const span = (r.evidence ?? []).find((e) => e.type === 'span') as { source: string; start: number; end: number };
    expect(span.source).toBe('input');
    expect(input.slice(span.start, span.end)).toContain('retention');
  });

  it('an answer that mirrors the numbering is covered even where the words diverge', () => {
    // The mirror is a NON-LEXICAL door: an agent answering a numbered ask
    // overwhelmingly repeats the numbering, and that is evidence of
    // engagement even when it shares no vocabulary with the question.
    const r = run(
      'Explain (1) how the retention sweep is scheduled and (2) which configuration key disables it.',
      '(1) On a timer at boot and again each day. (2) Set the flag in the block that governs it.',
    );
    expect(r.passed).toBe(true);
  });

  it('a produce-verb part is covered by substantial prose, because an output that IS the reply cannot be recognised as one', () => {
    const r = run(
      'First, draft a reply to the customer. Second, say whether the ISO date form is caught.',
      'Hi there — thanks for writing in. Yes, the personal-data rule is label-anchored and matches an ISO date as well as the slash form, so an intake record carrying that shape is caught by the same pattern. Let me know if you would like the configuration snippet.',
    );
    expect(r.passed).toBe(true);
  });

  it('a manner clause is not a deliverable', () => {
    // "Answer from the source, not the docs" is a sourcing constraint, and
    // an answer that complies has no reason to repeat it.
    const r = run('First, say what eval_type "all" returns. Second, answer from the engine source, not the docs.', 'It runs every bundle in one pass and returns a per-bundle breakdown.');
    expect(r.skipped).toBe(true);
  });

  it('a part with no subject is reported as unmeasurable rather than judged', () => {
    const r = run('First, explain what the spec says about transports. Second, cite a source.', 'The specification describes stdio and Streamable HTTP as the two transports.');
    // "cite a source" is all ask-words and no subject: an answer that DOES
    // cite has no reason to say "cite", so counting it would measure
    // vocabulary luck and every bad toss would be a false positive.
    expect(r.skipped).toBe(true);
  });
});
