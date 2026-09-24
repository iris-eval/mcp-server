/*
 * answers_the_ask: the composer question, answered with a
 * measurement. The pair of relevance measurements acts as a detection when
 * both fail; one alone never fires it; every skip of either is a skip here;
 * and it is a policy that gates where the measurements only scored.
 */
import { describe, expect, it } from 'vitest';
import { answersTheAsk, keywordOverlap, topicConsistency } from '../../../src/eval/rules/relevance.js';
import { EvalEngine } from '../../../src/eval/engine.js';
import { defaultConfig } from '../../../src/config/defaults.js';
import type { EvalContext } from '../../../src/types/eval.js';

const run = (ctx: Partial<EvalContext>) => answersTheAsk.evaluate({ output: '', ...ctx } as EvalContext);
const ask = 'Summarize the latest quarterly report for the board meeting';
const onTopic = 'The Q4 report shows revenue growth of 18% year over year, reaching $47.3M. Operating margins improved to 23%. The board should note the enterprise segment grew 31%.';
const offTopic = 'The weather in San Francisco is currently 62 degrees Fahrenheit with partly cloudy skies. Traffic on the Bay Bridge is moderate with a 25-minute estimated crossing time.';

describe('answers_the_ask — the pair as a detection', () => {
  it('fires only when both measurements fail: an off-topic answer fails, an on-topic one passes', () => {
    const off = run({ input: ask, output: offTopic });
    expect(keywordOverlap.evaluate({ input: ask, output: offTopic } as EvalContext).passed).toBe(false);
    expect(topicConsistency.evaluate({ input: ask, output: offTopic } as EvalContext).passed).toBe(false);
    expect(off.passed).toBe(false);
    expect(off.score).toBe(0);
    expect(off.message).toMatch(/answers something else/);
    expect(off.evidence).toEqual([{ type: 'count', stat: 'relevance_measurements_failed', unit: 'measurements', value: 2, threshold: 2, thresholdSource: 'default' }]);
    expect(run({ input: ask, output: onTopic }).passed).toBe(true);
  });
  it('one measurement alone never fires it: an answer that reuses the ask\'s words while wandering passes here (topic fails, overlap holds)', () => {
    const wandering = `${'The quarterly report and the board meeting are noted. '}${'Meanwhile the cafeteria menu changes on Monday with new pasta options. The parking garage closes early on Friday for maintenance. The lobby plants were replaced last week.'}`;
    const ko = keywordOverlap.evaluate({ input: ask, output: wandering } as EvalContext);
    const tc = topicConsistency.evaluate({ input: ask, output: wandering } as EvalContext);
    expect(ko.passed).not.toBe(tc.passed);
    expect(run({ input: ask, output: wandering }).passed).toBe(true);
  });
  it('skips whenever either measurement skips: no input, an ask with no content terms, an output too brief to measure', () => {
    expect(run({ output: offTopic }).skipped).toBe(true);
    const shortAnswer = run({ input: 'What is the capital of France?', output: 'Paris.' });
    expect(shortAnswer.skipped).toBe(true);
    expect(shortAnswer.passed).toBe(false);
    expect(run({ input: 'Please help me now', output: offTopic }).skipped).toBe(true);
  });
  it('is a policy with no number of its own, formula-backed and classed off_task — the composer gates on it where the measurements only scored', async () => {
    expect(answersTheAsk.kind).toBe('policy');
    expect(answersTheAsk.mechanism).toBe('formula');
    expect(answersTheAsk.critical).toBeUndefined();
    expect(answersTheAsk.classes).toEqual(['off_task']);
    const engine = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, defaultConfig.eval);
    const off = await engine.evaluateAll({ input: ask, output: offTopic });
    expect(off.passed).toBe(false);
    expect(off.verdict?.basis).toBe('policy_gate');
    expect(off.verdict?.by).toEqual(['answers_the_ask']);
    const on = await engine.evaluateAll({ input: ask, output: onTopic });
    expect(on.passed).toBe(true);
  });
});
