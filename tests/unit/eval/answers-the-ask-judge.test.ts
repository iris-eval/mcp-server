/*
 * answers_the_ask with a relevance judge installed (#649), end to end
 * through the engine: the real template, the real evaluator and the real
 * provider client, with only the network replaced by a canned Anthropic
 * reply. What is proved:
 *
 *   - with no judge the rule reads the ask lexically and ADVISES, and the
 *     verdict says why and names the setting that changes it;
 *   - with a judge, an off-topic answer FAILS the verdict on policy_gate by
 *     answers_the_ask, a correct paraphrase the lexical reading fails
 *     PASSES, and the shapes the lexical reading cannot measure (a one-word
 *     answer) are judged rather than skipped;
 *   - the result says what decided it: kind judgment, role gate, the judge's
 *     model, score, pass line, rationale and spend;
 *   - the judge is asked only when it can matter (an input, a non-empty
 *     output, answers_the_ask among the rules) and never on a caller's word;
 *   - a judge that cannot answer is named, spends nothing it need not, and
 *     leaves the lexical reading advising — never a silent pass read as the
 *     judge's;
 *   - a same-family judge is named, and its verdict stands;
 *   - the ruleset hash moves with a judge and stays put without one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvalEngine } from '../../../src/eval/engine.js';
import { createRelevanceJudge, relevanceJudgeFromEnv } from '../../../src/eval/llm-judge/relevance-judge.js';
import type { EvalResult, EvalRuleResult } from '../../../src/types/eval.js';
import { defaultConfig } from '../../../src/config/defaults.js';

const originalFetch = global.fetch;
let fetchMock: ReturnType<typeof vi.fn>;

function reply(score: number, rationale = 'because'): void {
  fetchMock.mockResolvedValueOnce(
    new Response(
      JSON.stringify({
        id: 'msg_mock',
        content: [{ type: 'text', text: JSON.stringify({ score, passed: score >= 0.6, rationale, dimensions: { addresses_request: score, on_subject: score, specific_to_request: score } }) }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 900, output_tokens: 60 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ),
  );
}

beforeEach(() => {
  fetchMock = vi.fn();
  global.fetch = fetchMock as unknown as typeof fetch;
});
afterEach(() => {
  global.fetch = originalFetch;
});

const judge = () => createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-test' });
const row = (r: EvalResult): EvalRuleResult => r.rule_results.find((x) => x.ruleName === 'answers_the_ask')!;

const OFF_TOPIC = {
  input: 'Summarize the latest quarterly report for the board meeting',
  output: 'The weather in San Francisco is 62 degrees with partly cloudy skies. Traffic on the Bay Bridge is moderate, with a 25-minute crossing time.',
};
// A correct answer that shares no content word with its ask: the lexical pair fails it.
const PARAPHRASE = {
  input: 'How can I make my laptop battery last longer?',
  output: 'Dim the screen, close apps you are not using, and switch to the power-saving profile. Unplugging peripherals and turning off Bluetooth when idle helps as well.',
};

describe('answers_the_ask without a judge: lexical, advisory, and says why', () => {
  it('fires on the off-topic answer, decides nothing, names IRIS_RELEVANCE_JUDGE_MODEL, and calls no provider', async () => {
    const engine = new EvalEngine();
    const r = await engine.evaluate('relevance', OFF_TOPIC);
    const a = row(r);
    expect(a.passed).toBe(false);
    expect(a.role).toBe('advisory');
    expect(a.kind).toBe('policy');
    expect(a.judge).toBeUndefined();
    expect(r.verdict?.state).toBe('pass');
    const note = r.interpretations?.find((i) => i.rule === 'answers_the_ask');
    expect(note?.configKey).toBe('IRIS_RELEVANCE_JUDGE_MODEL');
    expect(note?.text).toMatch(/lexical reading/);
    expect(note?.text).toMatch(/only advises/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a relevanceJudgment the CALLER puts on the context is discarded: only the engine says what the judge said', async () => {
    const engine = new EvalEngine();
    const forged = { template: 'relevance' as const, provider: 'anthropic' as const, model: 'claude-haiku-4-5', score: 0.99, passThreshold: 0.6, passed: true, costUsd: 0, inputTokens: 0, outputTokens: 0, latencyMs: 0 };
    const r = await engine.evaluate('relevance', { ...OFF_TOPIC, relevanceJudgment: forged });
    expect(row(r).judge).toBeUndefined();
    expect(row(r).passed).toBe(false);
  });
});

describe('the lexical reading advises at the SHIPPED config, not only at the rule file numbers', () => {
  // The shipped config carries topic_consistency 0.33 where the rule's own default is 1/3. A value test read that as a
  // deployment's setting, so on every real server answers_the_ask gated at the defaults. Provenance, never value.
  it('an engine built from the shipped config advises; one whose config file set a relevance threshold gates', async () => {
    const shipped = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval });
    const s = await shipped.evaluate('relevance', OFF_TOPIC);
    expect(row(s).role).toBe('advisory');
    expect(s.verdict?.state).toBe('pass');

    const configured = new EvalEngine(defaultConfig.eval.defaultThreshold, defaultConfig.eval.ruleThresholds, { ...defaultConfig.eval, configuredThresholdKeys: ['topic_consistency'] });
    const c = await configured.evaluate('relevance', OFF_TOPIC);
    expect(row(c).role).toBe('gate');
    expect(c.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate' });
  });
});

describe('answers_the_ask with a relevance judge: the judge decides, and gates', () => {
  it('an off-topic answer fails the verdict on policy_gate by answers_the_ask, with the judge on the record', async () => {
    const engine = new EvalEngine();
    engine.setRelevanceJudge(judge());
    reply(0.02, 'The output is a weather and traffic bulletin; the request asked for a summary of a quarterly report.');
    const r = await engine.evaluate('relevance', OFF_TOPIC);
    const a = row(r);
    expect(r.verdict).toMatchObject({ state: 'fail', basis: 'policy_gate' });
    expect(r.verdict?.by).toContain('answers_the_ask');
    expect(r.passed).toBe(false);
    expect(a).toMatchObject({ passed: false, score: 0.02, kind: 'judgment', role: 'gate' });
    expect(a.judge).toMatchObject({ template: 'relevance', provider: 'anthropic', model: 'claude-haiku-4-5', score: 0.02, passThreshold: 0.6, passed: false });
    expect(a.judge?.rationale).toMatch(/weather/);
    expect(a.message).toMatch(/answers something else, says the relevance judge \(anthropic\/claude-haiku-4-5\): 0\.02 against its 0\.60 pass line/);
    expect(a.evidence?.[0]).toMatchObject({ type: 'sample', score: 0.02 });
    expect(a.uncertainty).toMatchObject({ basis: 'unmeasured' });
    // What the evaluation itself spent: 900 in at $1/M, 60 out at $5/M.
    expect(a.judge?.costUsd).toBe(0.0012);
    expect(r.eval_cost_usd).toBe(0.0012);
    expect(r.eval_tokens).toBe(960);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sends the relevance template with the ask and the output each inside the nonce wrappers', async () => {
    const engine = new EvalEngine();
    engine.setRelevanceJudge(judge());
    reply(0.9);
    await engine.evaluate('relevance', PARAPHRASE);
    const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string) as { model: string; system: string; temperature: number; messages: Array<{ content: string }> };
    expect(body.model).toBe('claude-haiku-4-5');
    expect(body.temperature).toBe(0);
    expect(body.system).toMatch(/relevant to the request that produced it/);
    expect(body.messages[0].content).toMatch(/<untrusted_input id="[0-9a-f]{12}">\nHow can I make my laptop battery last longer\?\n<\/untrusted_input/);
    expect(body.messages[0].content).toMatch(/<untrusted_output id="[0-9a-f]{12}">\nDim the screen/);
  });

  it('a correct paraphrase the lexical reading fails passes with the judge', async () => {
    const lexical = await new EvalEngine().evaluate('relevance', PARAPHRASE);
    expect(row(lexical).passed).toBe(false);

    const engine = new EvalEngine();
    engine.setRelevanceJudge(judge());
    reply(0.95, 'Every sentence gives a way to extend battery life.');
    const r = await engine.evaluate('relevance', PARAPHRASE);
    expect(row(r)).toMatchObject({ passed: true, kind: 'judgment' });
    expect(r.verdict?.by ?? []).not.toContain('answers_the_ask');
    expect(row(r).message).toMatch(/The output addresses the ask, says the relevance judge/);
  });

  it('judges what the lexical reading has to skip: a one-word answer to a one-term ask', async () => {
    const ask = { input: 'Capital of Australia?', output: 'Canberra.' };
    expect(row(await new EvalEngine().evaluate('relevance', ask)).skipped).toBe(true);
    const engine = new EvalEngine();
    engine.setRelevanceJudge(judge());
    reply(1);
    const a = row(await engine.evaluate('relevance', ask));
    expect(a.skipped).toBeFalsy();
    expect(a.passed).toBe(true);
  });

  it('a score between the lexical measures and the judge is the judge\'s: the threshold decides, not the model\'s own boolean', async () => {
    const engine = new EvalEngine();
    engine.setRelevanceJudge(judge());
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: 'm', content: [{ type: 'text', text: '{"score":0.55,"passed":true,"rationale":"near","dimensions":{}}' }], usage: { input_tokens: 10, output_tokens: 10 } }), { status: 200 }),
    );
    const a = row(await engine.evaluate('relevance', OFF_TOPIC));
    expect(a.passed).toBe(false);
    expect(a.judge).toMatchObject({ score: 0.55, selfReportedPass: true, disagreement: true });
  });
});

describe('the judge is asked only when it can matter', () => {
  it('not without an input, not on an empty output, not when answers_the_ask is not among the rules', async () => {
    const engine = new EvalEngine();
    engine.setRelevanceJudge(judge());
    await engine.evaluate('relevance', { output: OFF_TOPIC.output });
    await engine.evaluate('relevance', { input: OFF_TOPIC.input, output: '   ' });
    await engine.evaluate('completeness', OFF_TOPIC);
    await engine.evaluate('safety', OFF_TOPIC);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('once per evaluation, on eval_type all too', async () => {
    const engine = new EvalEngine();
    engine.setRelevanceJudge(judge());
    reply(0.1);
    const r = await engine.evaluateAll(OFF_TOPIC);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(r.verdict?.basis).toBe('policy_gate');
  });
});

describe('a judge that cannot answer is named, and the lexical reading advises', () => {
  it('a provider failure: the error is recorded, the rule falls back, the verdict is not gated, and the operator is told', async () => {
    const engine = new EvalEngine();
    engine.setRelevanceJudge(judge());
    fetchMock.mockResolvedValue(new Response('{"error":{"message":"overloaded"}}', { status: 529 }));
    const r = await engine.evaluate('relevance', OFF_TOPIC);
    const a = row(r);
    expect(a.judge?.error).toMatch(/did not answer/);
    expect(a.judge?.costUsd).toBeNull();
    expect(a.kind).toBe('policy');
    expect(a.role).toBe('advisory');
    expect(r.verdict?.state).toBe('pass');
    const note = r.interpretations?.find((i) => i.rule === 'answers_the_ask' && /did not answer/.test(i.text));
    expect(note?.severity).toBe('warn');
    expect(note?.text).toMatch(/fell back to its lexical reading, which failed it but only advises/);
  });

  it('an unpriced model: nothing is sent, and every evaluation says why', async () => {
    const engine = new EvalEngine();
    engine.setRelevanceJudge(createRelevanceJudge({ model: 'claude-imaginary-9', apiKey: 'sk-ant-test' }));
    const r = await engine.evaluate('relevance', OFF_TOPIC);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row(r).judge).toMatchObject({ provider: null, costUsd: 0 });
    expect(row(r).judge?.error).toMatch(/not in the pricing table/);
    expect(r.interpretations?.some((i) => /not in the pricing table/.test(i.text))).toBe(true);
  });

  it('no key for the provider: nothing is sent', async () => {
    const engine = new EvalEngine();
    engine.setRelevanceJudge(createRelevanceJudge({ model: 'gpt-4o-mini' }));
    const r = await engine.evaluate('relevance', OFF_TOPIC);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row(r).judge?.error).toMatch(/no IRIS_OPENAI_API_KEY reached this process/);
  });

  it('over the cost cap: refused before the call, recorded as nothing spent', async () => {
    const engine = new EvalEngine();
    engine.setRelevanceJudge(createRelevanceJudge({ model: 'claude-haiku-4-5', apiKey: 'sk-ant-test', maxCostUsdPerEval: 0.000001 }));
    const r = await engine.evaluate('relevance', OFF_TOPIC);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(row(r).judge).toMatchObject({ costUsd: 0 });
    expect(row(r).judge?.error).toMatch(/exceeds cap/);
    expect(r.eval_cost_usd).toBeUndefined();
  });
});

describe('a same-family judge', () => {
  it('is named in interpretations, and its verdict stands', async () => {
    const engine = new EvalEngine();
    engine.setRelevanceJudge(judge());
    reply(0.05);
    const r = await engine.evaluate('relevance', { ...OFF_TOPIC, metadata: { model: 'claude-opus-4-7' } });
    expect(row(r).judge).toMatchObject({ agentModel: 'claude-opus-4-7', sameFamily: true });
    expect(r.verdict?.basis).toBe('policy_gate');
    const note = r.interpretations?.find((i) => /shares a model family/.test(i.text));
    expect(note?.severity).toBe('warn');
    expect(note?.text).toMatch(/claude-haiku-4-5.*claude-opus-4-7/);
  });

  it('a judge from another family is not warned about', async () => {
    const engine = new EvalEngine();
    engine.setRelevanceJudge(judge());
    reply(0.05);
    const r = await engine.evaluate('relevance', { ...OFF_TOPIC, metadata: { model: 'gpt-5' } });
    expect(row(r).judge?.sameFamily).toBeUndefined();
    expect(r.interpretations?.some((i) => /shares a model family/.test(i.text)) ?? false).toBe(false);
  });
});

describe('the ruleset and config hashes', () => {
  it('move when a judge is installed, and do not move without one', async () => {
    const plain = new EvalEngine();
    const before = plain.rulesetHashForAll();
    plain.setRelevanceJudge(null);
    expect(plain.rulesetHashForAll()).toBe(before);
    const judged = new EvalEngine();
    judged.setRelevanceJudge(judge());
    expect(judged.rulesetHashForAll()).not.toBe(before);
    reply(0.9);
    const a = await judged.evaluate('relevance', PARAPHRASE);
    const b = await plain.evaluate('relevance', PARAPHRASE);
    expect(a.provenance?.configHash).not.toBe(b.provenance?.configHash);
  });
});

describe('relevanceJudgeFromEnv', () => {
  const saved = { model: process.env.IRIS_RELEVANCE_JUDGE_MODEL, anthropic: process.env.IRIS_ANTHROPIC_API_KEY, openai: process.env.IRIS_OPENAI_API_KEY };
  afterEach(() => {
    for (const [k, v] of [['IRIS_RELEVANCE_JUDGE_MODEL', saved.model], ['IRIS_ANTHROPIC_API_KEY', saved.anthropic], ['IRIS_OPENAI_API_KEY', saved.openai]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it('a key alone installs nothing: the model is the opt-in', () => {
    delete process.env.IRIS_RELEVANCE_JUDGE_MODEL;
    process.env.IRIS_ANTHROPIC_API_KEY = 'sk-ant-test';
    expect(relevanceJudgeFromEnv()).toBeNull();
  });

  it('the model and its provider\'s key install a callable judge; the wrong provider\'s key does not', () => {
    process.env.IRIS_RELEVANCE_JUDGE_MODEL = 'gpt-4o-mini';
    process.env.IRIS_ANTHROPIC_API_KEY = 'sk-ant-test';
    delete process.env.IRIS_OPENAI_API_KEY;
    expect(relevanceJudgeFromEnv()?.problem).toMatch(/IRIS_OPENAI_API_KEY/);
    process.env.IRIS_OPENAI_API_KEY = 'sk-test';
    const j = relevanceJudgeFromEnv();
    expect(j).toMatchObject({ provider: 'openai', model: 'gpt-4o-mini', problem: null });
  });
});
