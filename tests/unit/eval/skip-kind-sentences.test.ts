/*
 * The sentences that say what a skip's kind does to the verdict, as each
 * place a reader meets them gives them: the relevance judge's start-up
 * warning, the self-test's judge step, the judge's documentation, the plugin
 * documentation and the changelog. Each is held word for word, so a change
 * to what the verdict does is a change to these.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createRelevanceJudge, relevanceJudgeStartupWarnings } from '../../../src/eval/llm-judge/relevance-judge.js';

const root = resolve(__dirname, '..', '..', '..');
// Each document read with every run of white space as one space, so a sentence is found however its lines wrap.
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8').replace(/\s+/g, ' ');

describe('what a reader is told a skip of each kind does to the verdict', () => {
  it("the relevance judge's start-up warning, for a judge that cannot run", () => {
    const warnings = relevanceJudgeStartupWarnings(createRelevanceJudge({ model: 'claude-haiku-4-5' }));
    expect(warnings.join(' ')).toContain(
      'answers_the_ask falls back to its lexical reading, which only advises, so an off-topic answer passes, and where the words alone cannot judge the verdict is unknown wherever the rule has to answer (as shipped; eval.onCriticalSkipped can make that a failure, or accept it), until this is fixed.',
    );
  });

  it("the self-test's judge step, where the judge cannot run", () => {
    expect(read('src/self-test.ts')).toContain(
      'answers_the_ask falls back to its lexical reading, which only advises, so an off-topic answer passes (and where the words alone cannot judge, the verdict is unknown wherever the rule has to answer, as shipped): fix the variable named above, or unset IRIS_RELEVANCE_JUDGE_MODEL',
    );
  });

  it("the judge's documentation, where the judge cannot answer", () => {
    const doc = read('docs/llm-as-judge.md');
    expect(doc).toContain(
      'where the words alone cannot judge either, the rule could not judge (`skipClass: "defeated"`), and the verdict is `unknown` wherever the rule had to answer (as shipped; `eval.onCriticalSkipped` can make that a failure, or accept it).',
    );
    expect(doc).toContain(
      '`--self-test` fails its judge step instead of printing PASS, because every evaluation would otherwise fall back to the lexical reading, which only advises where the words can judge and cannot judge where they cannot.',
    );
  });

  it("the plugin documentation, of a plugin's skip", () => {
    const doc = read('docs/plugins.md');
    expect(doc).toContain(
      'A skipped result says which kind of skip it is in `skipClass`: `"not_applicable"` where there was nothing to judge (what the rule reads was not sent, or its question does not apply to what was: an ask too short to read, an output too brief to measure), `"defeated"` where there was something to judge and the rule could not judge it, or `"config_invalid"` where the rule\'s own configuration is broken.',
    );
    expect(doc).toContain(
      'A skip that says neither is read as a rule that could not judge what it was sent (`skipClass: "defeated"` on its row), which the verdict counts where the rule had to answer: a critical rule, one somebody asked for, a gate',
    );
  });

  it('the changelog, of what a caller sees', () => {
    const log = read('CHANGELOG.md');
    expect(log).toContain(
      'when one of the five checks above had to answer and could not (as shipped; under `eval.onCriticalSkipped: "fail"` it is `fail`)',
    );
    expect(log).toContain('under `eval.onCriticalSkipped: "fail"` such a verdict is `fail`, since a failure outranks an unknown.');
    expect(log).toContain('reads `role: "advisory"` and `advisory: true`, with its reason (`advisoryWhy`)');
  });
});
