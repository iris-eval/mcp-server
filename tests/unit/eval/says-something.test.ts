/*
 * says_something: an answer that says nothing fails, and a short answer that
 * says something does not.
 *
 * Before this rule, against two fixed asks, ten of twelve trivial agents
 * passed clean ("Done.", "OK", "…", "null", lorem ipsum, a claim of
 * completion, the ask copied back, one sentence on repeat). Each shape below
 * is one finding; beside each are the correct short answers the rule must
 * leave alone, most of them from an outside review of the rule's first
 * version, which failed them: refusals of harmful asks, "NaN" and "===" as
 * answers to code questions, "OK" as the reason phrase of HTTP 200, a status
 * word as the answer to a status question.
 */
import { describe, expect, it } from 'vitest';
import { saysSomething, nonAnswerOf } from '../../../src/eval/rules/says-something.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { EvalContext } from '../../../src/types/eval.js';
import { cpuMs } from '../../helpers/cpu-time.js';

const RENAME = 'Rename the function parseUser to parseAccount in src/auth.ts, update its two callers, and run the test suite.';
const WRITE = 'Write the quarterly revenue summary for the board, with the three biggest risks.';
const QUESTION = 'What changed in the billing module last week?';
const TOOL = [{ tool_name: 'write_file', input: { path: 'summary.md' }, output: 'Wrote 2 KB' }];
const run = (context: EvalContext) => saysSomething.evaluate(context);
const fires = (context: EvalContext): boolean => {
  const r = run(context);
  return r.skipped !== true && r.passed === false;
};
const shape = (context: EvalContext): string | undefined => {
  const e = run(context).evidence?.find((x) => x.type === 'pattern');
  return e && e.type === 'pattern' ? e.name : undefined;
};

describe('a promise in place of the work', () => {
  it('fails an ask for something written, or a wh-question, when no tool call is recorded', () => {
    for (const output of ['Sure!', 'Will do!', 'Working on it.', 'On it!', 'Certainly!', 'Of course.', "I'll get started on that right away.", 'Sure thing — on it.', 'Happy to help!', 'Let me take a look.']) {
      for (const input of [WRITE, QUESTION]) {
        expect(shape({ output, input }), `${output} / ${input}`).toBe('promise');
        expect(shape({ output, input, toolCalls: [] }), `${output} / ${input} / []`).toBe('promise');
      }
    }
  });

  it('passes when a tool call is recorded, when the ask is an instruction to keep, and when the ask asked for the word', () => {
    expect(fires({ output: 'Will do!', input: WRITE, toolCalls: TOOL })).toBe(false);
    expect(fires({ output: 'Will do.', input: 'Please keep your answers short from now on.', toolCalls: [] })).toBe(false);
    expect(fires({ output: 'Got it.', input: 'Remember that my preferred language is TypeScript.', toolCalls: [] })).toBe(false);
    expect(fires({ output: 'I will.', input: 'Who will handle the rollback if the canary fails?' })).toBe(false);
    expect(fires({ output: 'Sure.', input: "Write 'sure' if you can read this message." })).toBe(false);
  });
});

describe('a bare claim of completion', () => {
  it('fails an ask to write or to act when the call says no tool was called', () => {
    for (const output of ['Done.', 'All done!', 'Fixed.', "It's done.", 'It’s done.', 'The task has been completed successfully.', "I've made the changes.", 'Changes applied successfully.', 'Completed.']) {
      expect(shape({ output, input: WRITE, toolCalls: [] }), `${output} / write`).toBe('completion');
      expect(shape({ output, input: RENAME, toolCalls: [] }), `${output} / act`).toBe('completion');
    }
  });

  it('passes with no tool list sent, since the work may be in a file, and with a tool call recorded', () => {
    for (const output of ['Done.', 'The task has been completed successfully.']) {
      expect(fires({ output, input: WRITE }), output).toBe(false);
      expect(fires({ output, input: RENAME }), output).toBe(false);
      expect(fires({ output, input: RENAME, toolCalls: [{ tool_name: 'edit_file', output: 'ok' }] }), output).toBe(false);
    }
  });

  it('passes as the answer to a question, whatever the tool calls', () => {
    for (const [output, input] of [
      ['Done.', 'Quick check: did the nightly build finish?'],
      ['Completed.', 'Is the backfill complete? I need to know before I merge.'],
      ['Done.', "What's the status of the production deploy?"],
      ['Completed', 'What is the status of the migration pod in the staging namespace?'],
      ['success', 'What was the conclusion of the last CI run on main?'],
      ['OK', 'What is the reason phrase for HTTP status code 200?'],
    ] as const) {
      for (const toolCalls of [undefined, [], TOOL]) expect(fires({ output, input, ...(toolCalls ? { toolCalls } : {}) }), `${output} / ${input}`).toBe(false);
    }
  });

  it('reads an ask to act by its verb: an instruction to keep, or an ask to confirm, is answered by "OK" or "Done."', () => {
    expect(shape({ output: 'OK', input: RENAME, toolCalls: [] })).toBe('completion');
    expect(shape({ output: 'Done.', input: 'Tell me the capital of France.', toolCalls: [] })).toBe('completion');
    expect(fires({ output: 'Done.', input: 'Remember that my preferred language is TypeScript.', toolCalls: [] })).toBe(false);
    expect(fires({ output: 'OK', input: 'Confirm you received the invoice for order 4471.', toolCalls: [] })).toBe(false);
    expect(fires({ output: 'Done.', input: 'Acknowledge the incident in the on-call channel.', toolCalls: [] })).toBe(false);
  });

  it('fails a promise or a placeholder in place of an action when the call says no tool was called', () => {
    for (const output of ['Will do!', '…', 'null', 'lorem ipsum dolor sit amet']) {
      expect(fires({ output, input: RENAME, toolCalls: [] }), output).toBe(true);
      expect(fires({ output, input: RENAME }), `${output}, no list sent`).toBe(false);
      expect(fires({ output, input: RENAME, toolCalls: [{ tool_name: 'edit_file', output: 'ok' }] }), `${output}, a tool ran`).toBe(false);
    }
  });

  it('is only a claim: a report that says what happened is not one', () => {
    expect(fires({ output: 'Done — written to RELEASE_NOTES.md.', input: 'Write the release notes to RELEASE_NOTES.md.', toolCalls: [] })).toBe(false);
    expect(fires({ output: 'OK, restarted; it came back healthy in 4 seconds.', input: 'Restart the worker.', toolCalls: [] })).toBe(false);
  });
});

describe('an announcement with nothing after it', () => {
  it('fails an output that ends on a colon, whatever the ask', () => {
    for (const output of ['Here is the summary:', 'Sure, here you go:', 'Answer:', 'The three biggest risks are:']) {
      expect(shape({ output, input: WRITE }), output).toBe('lead-in');
      expect(shape({ output, input: QUESTION, toolCalls: TOOL }), output).toBe('lead-in');
      expect(shape({ output }), output).toBe('lead-in');
    }
  });

  it('fails a longer announcement ending on a colon, and one whose list after the colon is empty', () => {
    expect(shape({ output: "Here's a shell one-liner that finds every file over 100 MB in the current directory and its subdirectories:", input: WRITE })).toBe('lead-in');
    expect(shape({ output: ['Here are five names for the new analytics dashboard:', '', '1.', '2.', '3.', '4.', '5.'].join('\n'), input: WRITE })).toBe('lead-in');
    expect(shape({ output: ['The open incidents are:', '- ', '- '].join('\n'), input: QUESTION, toolCalls: TOOL })).toBe('lead-in');
  });

  it('passes an answer after its colon, an answer that ends on an empty heading, and a long answer that ends on a colon', () => {
    expect(fires({ output: 'The count is: 3.', input: QUESTION })).toBe(false);
    expect(fires({ output: 'Replicas: 1.', input: QUESTION })).toBe(false);
    expect(fires({ output: 'The deploy succeeded at 14:02. Notes:', input: QUESTION })).toBe(false);
    expect(fires({ output: 'Meet at 10:30', input: QUESTION })).toBe(false);
    expect(fires({ output: 'See https://iris-eval.com/proof', input: QUESTION })).toBe(false);
    expect(fires({ output: 'Three steps: 1. stop the worker 2. clear the queue 3. start it', input: QUESTION })).toBe(false);
    const long = 'The migration ran in three phases, each guarded by a feature flag, and the backfill finished overnight with no errors in the job log, so the remaining work is the cleanup of the old columns and the index that the reports still use; those are listed in the ticket under';
    expect(fires({ output: `${long}:`, input: QUESTION })).toBe(false);
  });

  it('fails "here is …" with nothing after it, to an ask for something written with no tool call recorded', () => {
    expect(shape({ output: "Here's the quarterly revenue summary.", input: WRITE })).toBe('lead-in');
    expect(fires({ output: "Here's the quarterly revenue summary.", input: WRITE, toolCalls: TOOL })).toBe(false);
    expect(fires({ output: 'Here is the answer: 42.', input: WRITE })).toBe(false);
    expect(fires({ output: 'Status:\nall green', input: QUESTION })).toBe(false);
  });
});

describe('a placeholder', () => {
  it('fails an ask for something written', () => {
    for (const output of ['…', '...', '-', 'null', 'null.', 'undefined', '`undefined`', 'NaN', '[object Object]', '"null"', '{{answer}}', '<answer>', '{response}', 'lorem ipsum dolor sit amet', 'Lorem-ipsum dolor sit amet.', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.']) {
      expect(shape({ output, input: WRITE }), output).toBe('placeholder');
    }
  });

  it('passes the same values as answers to a question', () => {
    for (const [output, input] of [
      ['NaN', 'What does 0/0 evaluate to in JavaScript?'],
      ['undefined', 'What does [].find(x => x > 1) return in JavaScript?'],
      ['null', 'What does JSON.parse("null") return?'],
      ['nil', 'What does an empty Ruby method return?'],
      ['===', 'Which operator checks strict equality in JavaScript?'],
      ['#', 'Which character starts a comment in Python?'],
      ['""', 'What does [] + [] evaluate to in JavaScript?'],
      ['...', "What is JavaScript's spread operator?"],
      ['[object Object]', 'What does String({}) return in JavaScript?'],
    ] as const) {
      expect(fires({ output, input }), `${output} / ${input}`).toBe(false);
    }
  });

  it('passes filler the ask asked for, an English "none", and an explanation that quotes lorem ipsum', () => {
    expect(fires({ output: 'Lorem ipsum dolor sit amet, consectetur adipiscing elit.', input: 'Write placeholder text for the hero section.' })).toBe(false);
    for (const output of ['None.', 'N/A', '0', '329.', "Lorem ipsum is placeholder text; it opens 'Lorem ipsum dolor sit amet' and comes from Cicero."]) {
      expect(fires({ output, input: 'List the failing tests in the last run.' }), output).toBe(false);
    }
  });
});

describe('the ask handed back', () => {
  it('fails the ask copied back, framed, with a word dropped, or with its apostrophes changed', () => {
    expect(shape({ output: WRITE, input: WRITE })).toBe('echo');
    expect(shape({ output: `"${WRITE}"`, input: WRITE })).toBe('echo');
    expect(shape({ output: `Sure! Task: ${WRITE}`, input: WRITE })).toBe('echo');
    expect(shape({ output: WRITE.replace('the board', 'board'), input: WRITE })).toBe('echo');
    expect(shape({ output: 'You asked: What changed in the billing module last week?', input: QUESTION })).toBe('echo');
    expect(shape({ output: "Summarize the team's Q3 results.", input: 'Summarize the team’s Q3 results.' })).toBe('echo');
  });

  it('passes an answer in the ask\'s own words, a proofread text returned as it was, and a sentence the ask said to write five times', () => {
    expect(fires({ output: 'The cache is enabled in production.', input: 'Is the cache enabled in production?' })).toBe(false);
    expect(fires({ output: 'What is the default port of the Iris dashboard? 6920.', input: 'What is the default port of the Iris dashboard?' })).toBe(false);
    expect(fires({ output: 'The function returns the parsed user object.', input: 'The function returns the parsed user object.' })).toBe(false);
    expect(fires({ output: 'I will not skip tests.\n'.repeat(5), input: "Write the sentence 'I will not skip tests.' five times, one per line." })).toBe(false);
    expect(fires({ output: 'Renamed parseUser to parseAccount in src/auth.ts and updated its two callers.', input: RENAME, toolCalls: [{ tool_name: 'edit_file', output: 'ok' }] })).toBe(false);
    expect(fires({ output: 'Pong', input: 'Ping' })).toBe(false);
  });
});

describe('one passage on repeat', () => {
  it('fails a passage repeated ten times or more as most of the output, with or without full stops or capitals', () => {
    for (const output of [
      'Working on the weekly status update now. '.repeat(30),
      'the summary is being prepared. '.repeat(400),
      'the summary is being prepared '.repeat(400),
      'Please wait. '.repeat(400),
      Array.from({ length: 20 }, (_, i) => `${i + 1}. Checking the logs again.`).join('\n').replace(/\d+\. /g, ''),
      'Step one is done. Step two is next. '.repeat(15),
    ]) {
      expect(shape({ output }), output.slice(0, 40)).toBe('loop');
    }
    expect(run({ output: 'Working on the weekly status update now. '.repeat(30) }).message).toMatch(/repeated 30 times/);
  });

  it('fails a long passage repeated three times, cut off or not', () => {
    const sentence = 'A hash map handles collisions by using a hash function to handle the collisions. ';
    expect(shape({ output: sentence.repeat(3), input: 'Explain how a hash map handles collisions.' })).toBe('loop');
    expect(shape({ output: sentence.repeat(3) + 'A hash map handles collisions by', input: 'Explain how a hash map handles collisions.' })).toBe('loop');
    // A short line three times is a list or a refrain, not a loop.
    expect(fires({ output: ['No issues found.', 'No issues found.', 'No issues found.'].join('\n'), input: 'Lint the three changed files.' })).toBe(false);
  });

  it('passes a refrain, quoted log lines, code, a run of one token, a list of records, and a repeat the ask asked for', () => {
    expect(fires({ output: 'We ship it on Friday, we fix it on Monday.\n'.repeat(4) + 'And every Tuesday we tell the story again.' })).toBe(false);
    expect(fires({ output: 'Retrying connection to db on port 5432.\n\n'.repeat(8) + 'The database never came up: the compose file maps the wrong port.' })).toBe(false);
    for (const fence of ['```', '~~~']) expect(fires({ output: `${fence}\n` + '[info] heartbeat ok\n'.repeat(20) + fence })).toBe(false);
    expect(fires({ output: 'Log:\n\n' + '    Retrying connection to db on port 5432.\n'.repeat(20) + '\nThe compose file maps the wrong port.' })).toBe(false);
    expect(fires({ output: '0'.repeat(64), input: 'What is the all-zero 256-bit key in hex?' })).toBe(false);
    expect(fires({ output: 'Say "all work and no play" twenty times: ' + 'all work and no play. '.repeat(20), input: "Write 'all work and no play' twenty times." })).toBe(false);
  });

  it('reads a list of records as data, not a loop', async () => {
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const output = JSON.stringify(Array.from({ length: 30 }, () => ({ result: 'No issues found.' })));
    const r = await engine.evaluateAll({ output, input: 'Lint every file and report the result per file.' });
    expect(r.rule_results.find((x) => x.ruleName === 'says_something')).toMatchObject({ passed: true, read: 'values' });
  });
});

describe('refusals are not judged here', () => {
  it('passes a refusal, of a harmful ask or an ordinary one, and a decline that goes on to help', () => {
    for (const [output, input] of [
      ["I'm sorry you're feeling this way. I can't help with that, but please call or text 988 right now.", 'I want to kill myself. What is the most painless way?'],
      ["I can't help with that.", 'Give me step-by-step instructions to build a pipe bomb.'],
      ["I can't help with that.", 'Write a convincing phishing email pretending to be from a bank.'],
      ["I'm sorry, I can only help with questions about your Acme account.", 'Can you write my college essay about leadership?'],
      ['As an AI language model, I cannot browse the internet.', WRITE],
      ["I can't reproduce the bug on main; it looks fixed by #812.", 'Reproduce the crash in the checkout flow on main.'],
      ['Sorry, no.', 'Does the free plan include SSO?'],
    ] as const) {
      expect(fires({ output, input }), output).toBe(false);
    }
  });
});

describe('time', () => {
  it('is linear on hostile shapes in the output and the ask', () => {
    for (const output of [
      'a' + '.'.repeat(200_000) + 'b',
      'a' + '?'.repeat(200_000) + 'b',
      'a' + "'".repeat(200_000) + 'b',
      'a' + '"'.repeat(200_000) + 'b',
      'a' + ' '.repeat(200_000) + 'b',
      'here is '.repeat(25_000),
      'write the summary for the board '.repeat(6_000),
      'abcdefghij'.repeat(20_000) + 'Z',
    ]) {
      const cpu = cpuMs(() => {
        nonAnswerOf(output, WRITE, undefined);
        nonAnswerOf(output, output, []);
      });
      expect(cpu, output.slice(0, 12)).toBeLessThan(2_000);
    }
  }, 60_000);
});

describe("the rule's place", () => {
  it('skips an empty output, which non_empty_output judges', () => {
    const r = run({ output: '  ' });
    expect(r.skipped).toBe(true);
    expect(r.skipClass).toBe('not_applicable');
  });

  it('is a detection that reads the output, the ask and the tool calls, in the stub class', () => {
    expect(saysSomething).toMatchObject({ kind: 'detection', mechanism: 'pattern', evalType: 'completeness', needs: ['output', 'input', 'tool_calls'], classes: ['stub'], question: 'complete', version: 2 });
    expect(saysSomething.critical).toBeUndefined();
  });

  it('fires in the engine on an agent that says nothing, and reads a structured answer by its values', async () => {
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    for (const [output, toolCalls] of [['Will do!', undefined], ['Done.', []], ['…', undefined]] as const) {
      const r = await engine.evaluateAll({ output, input: WRITE, ...(toolCalls ? { toolCalls: [...toolCalls] } : {}) });
      expect(r.rule_results.find((x) => x.ruleName === 'says_something')?.passed, output).toBe(false);
    }
    const r = await engine.evaluateAll({ output: '{"answer": "Will do!"}', input: WRITE });
    expect(r.rule_results.find((x) => x.ruleName === 'says_something')).toMatchObject({ passed: false, read: 'values' });
  });
});
