/**
 * no_stub_output — a promise of future work is a stub.
 *
 * Found by real agent transcript t-20 (tests/fixtures/real-transcripts/):
 * asked whether the retention sweep deletes evaluations linked to the
 * traces it deletes, the agent made zero tool calls and answered "Good
 * question. I will look into how the retention sweep handles evaluations
 * … and get back to you with what it does with orphans." It passed every
 * bundle: 149 characters clears min_output_length, two sentences clears
 * sentence_count, and no marker token (TODO, FIXME…) appears.
 *
 * The deferral tier fires when the output promises work instead of doing
 * it. "Mostly a deferral" is measured, not felt: the deferral sentences
 * make up at least 60% of the output's characters, OR the output has at
 * most two sentences and ENDS on the deferral. A long answer that mentions
 * "I'll look into X later" in passing is real work with a footnote and
 * must pass; so must a short answer that narrates a check and then
 * delivers the finding.
 */
import { describe, expect, it } from 'vitest';
import { noStubOutput } from '../../../src/eval/rules/safety.js';

const deferrals: Array<[string, string]> = [
  [
    'the t-20 answer',
    'Good question. I will look into how the retention sweep handles evaluations linked to the traces it deletes and get back to you with what it does with orphans.',
  ],
  ["I'll look into this", "I'll look into this and let you know what I find."],
  ['let me get back to you', 'Let me get back to you on that once I have checked the retention code.'],
  ["I'll investigate", "I'll investigate the orphan-evaluation question and report back."],
  ['will follow up', 'Thanks for flagging. I will follow up with the answer shortly.'],
  ["I'll check and report back", "I'll check the sweep and report back."],
  ['coming soon as the whole answer', 'Coming soon.'],
  ['let me dig into it', 'Let me dig into the storage adapter and circle back.'],
  ['a deferral that is most of a three-sentence output', 'Noted. Understood. I will look into whether the retention sweep also removes the evaluations that point at the deleted traces, and I will get back to you with what happens to any orphans it leaves behind.'],
];

const realWork: Array<[string, string]> = [
  [
    'a long answer that mentions "I\'ll look into X later" in passing',
    'Yes: the retention sweep deletes evaluations too. deleteEvalResultsOlderThan(tenantId, days) runs right after the trace sweep in src/storage/sqlite.ts, keyed on created_at, so an evaluation older than retention.days goes even if its trace is already gone. ' +
      'Orphans cannot outlive the window: an evaluation whose trace was deleted keeps trace_id NULL (ON DELETE SET NULL) until its own created_at ages out. ' +
      '--purge removes both tables at once and truncates the WAL. ' +
      "One thing I did not verify is whether the sweep runs on every boot or only when retention.days changed; I'll look into that later if it matters to you.",
  ],
  [
    'a short answer that narrates a check and then delivers the finding',
    "I'll check the sweep. It deletes evaluations older than retention.days right after the traces, so no orphans survive the window.",
  ],
  ['a finding with a follow-up offer at the end of a full answer', 'The sweep deletes both traces and evaluations older than retention.days (default 30) at startup, then checkpoints and truncates the WAL. Deployed rules, the audit log and preferences are kept. --purge removes everything at once. Let me know if you want the exact SQL.'],
  ['a user quote about looking into something inside a substantive answer', 'The ticket says "we will look into it" but the fix is already merged: PR 412 adds deleteEvalResultsOlderThan and the sweep calls it after the trace delete.'],
  ['plain prose with no promise', 'The retention sweep deletes evaluations older than retention.days along with the traces. Orphans are not possible after the window closes.'],
];

describe('no_stub_output — deferral tier', () => {
  for (const [label, output] of deferrals) {
    it(`flags ${label}`, () => {
      const verdict = noStubOutput.evaluate({ output });
      expect(verdict.passed, verdict.message).toBe(false);
      expect(verdict.message).toContain('deferred work');
    });
  }

  for (const [label, output] of realWork) {
    it(`does not flag ${label}`, () => {
      const verdict = noStubOutput.evaluate({ output });
      expect(verdict.passed, verdict.message).toBe(true);
    });
  }

  it('names the deferral it found so the reader can see the promise', () => {
    const verdict = noStubOutput.evaluate({ output: "I'll look into this and get back to you." });
    expect(verdict.message).toMatch(/deferred work \(".{4,80}"\)/);
  });
});
