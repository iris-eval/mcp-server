/*
 * says_something: an answer that says nothing fails, and a short answer that
 * says something does not.
 *
 * Before this rule, against two fixed asks, ten of twelve trivial agents
 * passed clean ("Done.", "OK", a refusal, "…", "null", lorem ipsum, a claim
 * of completion, an AI disclaimer, the ask copied back, one sentence on
 * repeat). Each shape below is one finding; each boundary beside it is a
 * short answer the rule must leave alone.
 */
import { describe, expect, it } from 'vitest';
import { saysSomething } from '../../../src/eval/rules/says-something.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { EvalContext } from '../../../src/types/eval.js';

const RENAME = 'Rename the function parseUser to parseAccount in src/auth.ts, update its two callers, and run the test suite.';
const WRITE = 'Write the quarterly revenue summary for the board, with the three biggest risks.';
const run = (context: EvalContext) => saysSomething.evaluate(context);
const fires = (context: EvalContext): boolean => {
  const r = run(context);
  return r.skipped !== true && r.passed === false;
};
const shape = (context: EvalContext): string | undefined => {
  const e = run(context).evidence?.find((x) => x.type === 'pattern');
  return e && e.type === 'pattern' ? e.name : undefined;
};

describe('placeholders fail whatever the ask', () => {
  it('punctuation, a program\'s empty value, lorem ipsum', () => {
    for (const output of ['…', '...', '-', '. . .', '?', 'null', 'undefined', 'NaN', '[object Object]', '"null"', 'lorem ipsum dolor sit amet', 'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor.']) {
      expect(shape({ output }), output).toBe('placeholder');
      expect(shape({ output, input: WRITE, toolCalls: [{ tool_name: 'read_file', output: 'x' }] }), output).toBe('placeholder');
    }
  });

  it('an English "none", a number, and an explanation that quotes lorem ipsum are answers', () => {
    for (const output of ['None.', 'N/A', '0', '329.', "Lorem ipsum is placeholder text; it opens 'Lorem ipsum dolor sit amet' and comes from Cicero."]) {
      expect(fires({ output, input: 'Are there any failing tests in the last run?' }), output).toBe(false);
    }
  });
});

describe('a bare acknowledgement', () => {
  it('fails a question or a request for information, with or without tool calls', () => {
    for (const ask of ['List the three biggest risks in the Q3 plan.', 'Explain why the build failed on Windows.', 'What changed in the billing module?', 'How do I rotate the key?']) {
      for (const toolCalls of [undefined, [], [{ tool_name: 'read_file', output: 'x' }]]) {
        expect(fires({ output: 'Done.', input: ask, ...(toolCalls ? { toolCalls } : {}) }), `${ask} ${JSON.stringify(toolCalls)}`).toBe(true);
      }
    }
  });

  it('fails a request to write something unless the call records a tool call that could have written it', () => {
    expect(fires({ output: 'Done.', input: WRITE })).toBe(true);
    expect(fires({ output: 'Done.', input: WRITE, toolCalls: [] })).toBe(true);
    expect(fires({ output: 'Done.', input: WRITE, toolCalls: [{ tool_name: 'write_file', input: { path: 'summary.md' }, output: 'Wrote 2 KB' }] })).toBe(false);
  });

  it('fails an action only when the call records that no tool was called', () => {
    for (const output of ['Done.', 'OK', 'All done!', 'The task has been completed successfully.', "I've completed the task.", 'Completed.']) {
      expect(fires({ output, input: RENAME, toolCalls: [] }), output).toBe(true);
      expect(fires({ output, input: RENAME }), output).toBe(false);
      expect(fires({ output, input: RENAME, toolCalls: [{ tool_name: 'edit_file', output: 'ok' }] }), output).toBe(false);
    }
  });

  it('answers a yes/no question, and is the whole answer to a request to remember something', () => {
    expect(fires({ output: 'Done.', input: 'Is the nightly build done?', toolCalls: [] })).toBe(false);
    expect(fires({ output: 'Got it.', input: 'Remember that my preferred language is TypeScript.' })).toBe(false);
  });

  it('is only an acknowledgement: a report that says what happened is not one', () => {
    expect(fires({ output: 'Done — written to RELEASE_NOTES.md.', input: 'Write the release notes to RELEASE_NOTES.md.' })).toBe(false);
    expect(fires({ output: 'OK, restarted; it came back healthy in 4 seconds.', input: 'Can you restart the worker?', toolCalls: [] })).toBe(false);
  });
});

describe('a bare refusal', () => {
  it('fails a refusal of an ordinary ask, with an AI disclaimer or without', () => {
    for (const output of ["I can't help with that.", "I'm sorry, but I can't assist with that request.", 'As an AI language model, I cannot browse the internet.', 'I am unable to write poetry.']) {
      expect(shape({ output, input: WRITE }), output).toBe('refusal');
    }
  });

  it('passes the refusal of an ask the blocklist names, the shipped one or the deployment\'s', () => {
    expect(fires({ output: "I can't help with that.", input: 'Explain how to make a bomb at home.' })).toBe(false);
    expect(fires({ output: "I can't help with that.", input: 'Draft the acme-internal pricing memo.', customConfig: { blocklist: ['acme-internal'] } })).toBe(false);
  });

  it('is bare: a decline that goes on to help is an answer, and "No." answers a question', () => {
    expect(fires({ output: "I can't book flights from here, but here is how to compare fares: open Google Flights, set BOS to DEN for Friday, and sort by price; Southwest is usually cheapest on that route.", input: 'Find the cheapest flight from Boston to Denver next Friday.' })).toBe(false);
    expect(fires({ output: 'No.', input: 'Did the migration change any table names?' })).toBe(false);
  });
});

describe('the ask handed back', () => {
  it('fails the ask copied back, with or without quotes', () => {
    expect(shape({ output: WRITE, input: WRITE })).toBe('echo');
    expect(shape({ output: `"${WRITE}"`, input: WRITE })).toBe('echo');
  });

  it('passes a completion report that restates the ask in the past tense', () => {
    expect(fires({ output: 'Renamed parseUser to parseAccount in src/auth.ts and updated its two callers.', input: RENAME, toolCalls: [{ tool_name: 'edit_file', output: 'ok' }] })).toBe(false);
  });
});

describe('one sentence on repeat', () => {
  it('fails a sentence repeated until it is most of the output', () => {
    const output = 'Working on the weekly status update now. '.repeat(30);
    expect(shape({ output })).toBe('repetition');
    expect(run({ output }).message).toMatch(/repeated 30 times makes up 100%/);
  });

  it('passes a chorus, identical log lines in a code block, and a key sentence said twice', () => {
    expect(fires({ output: 'We ship it on Friday, we fix it on Monday.\n'.repeat(4) + 'And every Tuesday we tell the story again.' })).toBe(false);
    expect(fires({ output: '```\n' + '[info] heartbeat ok\n'.repeat(20) + '```' })).toBe(false);
    expect(fires({ output: 'The sweep deletes old traces. It runs in short steps. The sweep deletes old traces. It keeps the pinned baseline.' })).toBe(false);
  });

  it('reads a very long loop in linear time', () => {
    const output = 'The quarterly summary is being prepared and will be ready soon. '.repeat(15_000); // ~960 KB
    const started = performance.now();
    expect(shape({ output })).toBe('repetition');
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});

describe('the rule\'s place', () => {
  it('skips an empty output, which non_empty_output judges', () => {
    const r = run({ output: '  ' });
    expect(r.skipped).toBe(true);
    expect(r.skipClass).toBe('not_applicable');
  });

  it('is a detection that reads the output, the ask and the tool calls, in the stub class', () => {
    expect(saysSomething).toMatchObject({ kind: 'detection', mechanism: 'pattern', evalType: 'completeness', needs: ['output', 'input', 'tool_calls'], classes: ['stub'], question: 'complete', version: 1 });
    expect(saysSomething.critical).toBeUndefined();
  });

  it('fails the verdict of an agent that says nothing, at the shipped configuration', async () => {
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    for (const output of ['Done.', '…', "I can't help with that."]) {
      const r = await engine.evaluateAll({ output, input: RENAME, toolCalls: [] });
      expect(r.verdict!.state, output).toBe('fail');
      expect(r.rule_results.find((x) => x.ruleName === 'says_something')?.passed, output).toBe(false);
    }
  });

  it('reads a structured answer by its values', async () => {
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const r = await engine.evaluateAll({ output: '{"answer": "Done."}', input: WRITE });
    expect(r.rule_results.find((x) => x.ruleName === 'says_something')).toMatchObject({ passed: false, read: 'values' });
  });
});
