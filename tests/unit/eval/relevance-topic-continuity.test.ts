/**
 * topic_consistency — redesigned after real agent transcripts.
 *
 * Found by real agent transcripts t-03, t-05 and t-24 (tests/fixtures/
 * real-transcripts/): grounded, correct technical answers about `--purge`,
 * `eval_type: "all"` and a one-paragraph product description failed the
 * rule at 6.7% / 3.6% / 2.0%. The old measure was the fraction of OUTPUT
 * words that appear in the INPUT — which punishes exactly what a good
 * technical answer does: bring the source's vocabulary (identifiers, file
 * names, exact values) to a short question that did not contain it. No
 * threshold fixes a measure that reads new correct vocabulary as drift.
 *
 * The rule now measures CONTINUITY: the share of the output's
 * content-bearing sentences that connect to the ask's topic — a sentence
 * connects when it shares a content term (stopwords dropped, identifiers
 * split, light stemming) with the input or with an earlier connected
 * sentence, and list items are read under the sentence that introduces
 * them. Grounded answers chain their vocabulary back to the ask; a wrong
 * product, a refusal, filler, or a ramble does not. keyword_overlap keeps
 * the other, distinct signal (RECALL of the ask's terms in the output) on
 * the same tokenizer, so the two rules no longer double-count one
 * measurement.
 */
import { describe, expect, it } from 'vitest';
import { keywordOverlap, topicConsistency } from '../../../src/eval/rules/relevance.js';

const purgeAsk = 'What does the --purge flag do? Read src/index.ts, not the docs.';

const groundedAnswers: Array<[string, string, string]> = [
  [
    'the t-03 answer (bullets, code identifiers, exact values)',
    purgeAsk,
    '--purge is a one-shot maintenance mode, not a server option. From src/index.ts:\n\n' +
      '- What it does (help text, line 145): deletes EVERY stored trace, span and evaluation from the configured database, compacts the file and truncates the write-ahead log so the deleted text does not linger on disk, then exits. Deployed rules, the audit log and preferences are kept. Not reversible.\n' +
      '- How (runPurge, line 269): opens the configured storage, calls storage.purge(LOCAL_TENANT), prints a summary to stderr, closes storage and exits 0. Any error prints "purge failed: …" and exits 1.\n' +
      '- Constraints: it is one of four mutually exclusive mode flags (demo, demo-clear, self-test, purge), so combining it with another mode is refused, and --purge --dashboard is refused with an explicit message.\n' +
      '- Why it exists (comment for #372): the retention sweep only ever trimmed by age, and deleting iris.db by hand left every row readable in iris.db-wal.',
  ],
  [
    'the t-05 answer (engine internals for a four-word question)',
    'What does eval_type: "all" return? Answer from the engine source, not the docs.',
    'eval_type "all" is handled by EvalEngine.evaluateAll() in src/eval/engine.ts, not by the single-bundle evaluate().\n\n' +
      'What runs: for every type in ALL_EVAL_TYPES (completeness, relevance, safety, cost, custom) it collects the built-in bundle plus any rules deployed under that type, tags each with its category, then appends the call\'s inline custom_rules tagged "custom". Everything runs in ONE pass through this.run("all", rules, categories, context), sharing a single regex budget.\n\n' +
      'What comes back: an ordinary EvalResult whose eval_type is "all" — id, score, passed, rule_results, suggestions, rules_evaluated, rules_skipped, insufficient_data. Because categories were passed, the result also carries a categories map with the same arithmetic computed per bundle.',
  ],
  [
    'the t-24 answer body (a product description whose later sentences use "it")',
    'Give me a one-paragraph description of Iris for our internal wiki.',
    'Iris is an open-source (MIT) MCP server that scores every agent run for quality, safety and cost on your own machine, with no SDK and no account. ' +
      'Runs land in a local SQLite database, where 13 deterministic built-in rules check for PII and credential leaks, prompt injection, hallucination markers, stub output and cost thresholds without any LLM calls; an optional bring-your-own-key LLM judge handles the semantic questions. ' +
      'It exposes nine MCP tools and a dashboard on port 6920, ingests traces over plain HTTP, and never sends traces anywhere. ' +
      'Every rule is inspectable and editable. Requires Node.js 20 or later.',
  ],
  [
    'a three-sentence answer where only the first sentence echoes the ask',
    'What is the weather today?',
    'It is sunny today. Expect a high of 75°F this afternoon. Bring sunglasses if you go out.',
  ],
  [
    'a summary delivered as bullets under an on-topic lead-in',
    'Summarise release-notes-draft.md in a few bullets and include the reviewer note verbatim.',
    'Summary of release-notes-draft.md (internal draft, not yet reviewed):\n\n' +
      '- --purge now truncates the write-ahead log after VACUUM.\n' +
      '- The HTTP ingest endpoint accepts eval_type "all".\n' +
      '- Reviewer note, verbatim as requested: the docker image has not been rebuilt.\n',
  ],
];

const offTopic: Array<[string, string, string]> = [
  [
    'an answer about a different product',
    purgeAsk,
    "Docker's prune command removes all stopped containers, dangling images and unused networks. Run docker system prune -a to reclaim disk space, and add --volumes to remove unused volumes as well. Kubernetes has no direct equivalent, but kubectl delete pods --field-selector=status.phase=Failed clears failed pods from a namespace.",
  ],
  [
    'a generic refusal',
    purgeAsk,
    "I'm sorry, but I can't help with that request. If you have any other questions or need assistance with something else, feel free to ask and I'll do my best to help you out.",
  ],
  [
    'lorem-like filler',
    purgeAsk,
    'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur.',
  ],
  [
    'an answer that starts on topic and then rambles',
    'How do I reset my password for the account on iris-eval.com?',
    'To reset your password, use the link on the sign-in page. By the way, the weather in Lisbon this week has been glorious: long sunny afternoons, a light breeze off the Tagus, and evenings warm enough to eat outside. The seafood markets are busy, the trams are crowded with tourists, and the jacaranda trees are still in bloom along the avenues. If you visit, take the ferry to Cacilhas for the view back across the river at sunset.',
  ],
];

describe('topic_consistency — continuity with the ask', () => {
  for (const [label, input, output] of groundedAnswers) {
    it(`passes ${label}`, () => {
      const verdict = topicConsistency.evaluate({ input, output });
      expect(verdict.skipped ?? false).toBe(false);
      expect(verdict.passed, verdict.message).toBe(true);
    });
  }

  for (const [label, input, output] of offTopic) {
    it(`fails ${label}`, () => {
      const verdict = topicConsistency.evaluate({ input, output });
      expect(verdict.skipped ?? false).toBe(false);
      expect(verdict.passed, verdict.message).toBe(false);
    });
  }

  it('the message says how many sentences connected, not a word ratio', () => {
    const verdict = topicConsistency.evaluate({ input: purgeAsk, output: groundedAnswers[0][2] });
    expect(verdict.message).toMatch(/\d+\/\d+ content sentences connect/);
  });

  it('the description states the measure and the threshold', () => {
    expect(topicConsistency.description).toMatch(/third/i);
    expect(topicConsistency.description).toMatch(/connect/i);
  });

  it('reads the configured threshold as a fraction of connected sentences', () => {
    const rambling = offTopic[3];
    // 1 of 4 sentences connect (25%): fails at the default third, passes at 0.2.
    expect(topicConsistency.evaluate({ input: rambling[1], output: rambling[2] }).passed).toBe(false);
    expect(
      topicConsistency.evaluate({ input: rambling[1], output: rambling[2], customConfig: { topic_consistency: 0.2 } }).passed,
    ).toBe(true);
  });
});

describe('keyword_overlap — recall of the ask\'s content terms', () => {
  it('counts content terms only: request words and the deliverable\'s form are not keywords', () => {
    // "give me a", "for our", "one-paragraph description" describe the
    // deliverable, not the subject. What remains is iris + internal + wiki;
    // the paragraph engages the subject and not the destination, and the
    // message says so honestly (this is where topic_consistency, not
    // recall, carries the relevance verdict for a description-shaped ask).
    const verdict = keywordOverlap.evaluate({
      input: 'Give me a one-paragraph description of Iris for our internal wiki.',
      output: groundedAnswers[2][2],
    });
    expect(verdict.message).toMatch(/^1\/3 input keywords/);
  });

  it('passes a grounded answer to a subject-shaped ask', () => {
    const verdict = keywordOverlap.evaluate({
      input: 'Does the retention sweep also delete the evaluations linked to the traces it deletes?',
      output:
        'Yes. The sweep deletes evaluations older than retention.days right after the trace delete, so an evaluation whose trace is gone still ages out on its own created_at.',
    });
    expect(verdict.passed, verdict.message).toBe(true);
  });

  it('splits code identifiers so "engine.ts" satisfies an ask about the engine', () => {
    const verdict = keywordOverlap.evaluate({
      input: 'What does eval_type: "all" return? Answer from the engine source, not the docs.',
      output: groundedAnswers[1][2],
    });
    expect(verdict.passed, verdict.message).toBe(true);
  });

  it('matches inflections: "purged" and "purging" satisfy an ask about "purge"', () => {
    const verdict = keywordOverlap.evaluate({
      input: 'Does purge truncate the log?',
      output: 'Purging truncates the write-ahead log after the rows are purged, and truncation is logged.',
    });
    expect(verdict.passed, verdict.message).toBe(true);
    expect(verdict.message).toMatch(/^3\/3 input keywords/);
  });

  it('still fails an answer that engages none of the ask\'s terms', () => {
    const verdict = keywordOverlap.evaluate({ input: purgeAsk, output: offTopic[0][2] });
    expect(verdict.passed).toBe(false);
  });
});
