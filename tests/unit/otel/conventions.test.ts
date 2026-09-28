/*
 * The conventions a buyer will test against the OTLP door.
 *
 * One fixture per framework under tests/fixtures/otlp/conventions/, each
 * authored to the vendor's own documentation (the README beside them names
 * the page every key came from). For each, the door must read the agent,
 * the input, the output, the tokens, the model, the session, the tool
 * steps, and say what the payload lacked. The token arithmetic in the
 * fixtures is chosen so a wrong summation rule shows: a parent that
 * carries the same usage as its children is counted once, and an explicit
 * whole-run aggregate wins over the per-call sum.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { fromOtlp, otlpTraceRequestSchema } from '../../../src/otel/ingest.js';
import { toSteps } from '../../../src/eval/steps.js';

const DIR = fileURLToPath(new URL('../../fixtures/otlp/conventions/', import.meta.url));

function load(file: string) {
  const request = otlpTraceRequestSchema.parse(JSON.parse(readFileSync(DIR + file, 'utf-8')));
  const mapped = fromOtlp(request);
  expect(mapped.traces, `${file} maps to exactly one trace`).toHaveLength(1);
  const { trace, lacked } = mapped.traces[0];
  return { trace, lacked, steps: toSteps({ spans: trace.spans }).map((s) => s.name) };
}

interface Expected {
  agent: string;
  input: string | RegExp;
  output: string | RegExp;
  tokens: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
  model: string;
  /** The cost estimated from the tokens at list price (none of these conventions sends a cost), or null when the model is not priced. */
  cost: { usd: number; pricedAs: string } | null;
  session?: string;
  steps: string[];
  lacked: Array<string | RegExp>;
}

const TABLE: Record<string, Expected> = {
  'pydantic-ai.otlp.json': {
    agent: 'weather-agent',
    // gen_ai.input.messages / gen_ai.output.messages, read down to the words asked and answered (0.20.0).
    input: 'What is the weather in Lisbon tomorrow?',
    output: 'Lisbon tomorrow: 24 °C, clear skies, a light wind from the northwest.',
    // The aggregate (812) wins over the leaf sum (402 + 390 = 792); cache_read tokens are not usage.
    tokens: { prompt_tokens: 812, completion_tokens: 133, total_tokens: 945 },
    model: 'gpt-4o',
    cost: { usd: 0.00336, pricedAs: 'gpt-4o' },
    steps: ['get_weather'],
    lacked: [],
  },
  'google-adk.otlp.json': {
    agent: 'weather_agent',
    input: /Porto this weekend/,
    output: /showers on Saturday/,
    tokens: { prompt_tokens: 318, completion_tokens: 44, total_tokens: 362 },
    model: 'gemini-2.5-flash',
    cost: null,
    session: 'session-4f2a',
    steps: ['get_weather'],
    // No service.name on the resource, but gen_ai.agent.name named the agent — so nothing is lacked.
    lacked: [],
  },
  'langsmith.otlp.json': {
    agent: 'support-graph',
    input: 'Where is my order 4471?',
    output: 'Order 4471 shipped on 19 September and arrives tomorrow.',
    tokens: { prompt_tokens: 210, completion_tokens: 27, total_tokens: 237 },
    model: 'gpt-4o-mini',
    cost: { usd: 0.0000477, pricedAs: 'gpt-4o-mini' },
    steps: ['lookup_order'],
    lacked: [],
  },
  'crewai-openinference.otlp.json': {
    agent: 'launch-crew',
    input: '{"topic":"Q4 launch"}',
    output: 'Launch plan: three phases over six weeks, research first.',
    tokens: { prompt_tokens: 640, completion_tokens: 88, total_tokens: 728 },
    model: 'gpt-4o',
    cost: { usd: 0.00248, pricedAs: 'gpt-4o' },
    session: 'crew-run-19',
    steps: ['web_search'],
    lacked: [],
  },
  'traceloop.otlp.json': {
    agent: 'rag-workflow',
    input: '{"args":["What does the refund policy say?"],"kwargs":{}}',
    output: '"Refunds are accepted within 30 days of purchase."',
    tokens: { prompt_tokens: 155, completion_tokens: 12, total_tokens: 167 },
    model: 'gpt-4o-mini',
    cost: { usd: 0.00003045, pricedAs: 'gpt-4o-mini' },
    steps: ['retrieve_policy'],
    lacked: [],
  },
  'agent-framework.otlp.json': {
    agent: 'agent-framework-sample',
    input: /two-line release note/,
    output: /2\.3 ships faster search/,
    // invoke_agent carries 1742/136 beside chat children carrying 812/96 and 930/40: counted once, never 3484.
    tokens: { prompt_tokens: 1742, completion_tokens: 136, total_tokens: 1878 },
    model: 'gpt-4o-mini',
    cost: { usd: 0.0003429, pricedAs: 'gpt-4o-mini' },
    steps: ['get_release_facts'],
    lacked: [],
  },
  'semantic-kernel.otlp.json': {
    agent: 'sk-console',
    // The gen_ai.content.* events carry OpenAI-shaped message arrays, read down to their words.
    input: 'Why is the sky blue in one sentence?',
    output: 'The sky appears blue because shorter blue wavelengths of sunlight are scattered by the atmosphere more than other colors.',
    tokens: { prompt_tokens: 16, completion_tokens: 29, total_tokens: 45 },
    model: 'gpt-4o',
    cost: { usd: 0.00033, pricedAs: 'gpt-4o' },
    steps: [],
    lacked: [],
  },
  'vercel-ai-sdk.otlp.json': {
    agent: 'next-app',
    input: '{"prompt":"Name three risks of shipping on a Friday."}',
    output: 'Fewer people on call, a slower rollback, and a weekend of silent failures.',
    // ai.generateText and its doGenerate child both carry 58/24: counted once, never 116/48.
    tokens: { prompt_tokens: 58, completion_tokens: 24, total_tokens: 82 },
    model: 'claude-sonnet-5',
    cost: { usd: 0.000356, pricedAs: 'claude-sonnet-5' },
    steps: ['get_oncall'],
    lacked: [],
  },
};

const matches = (actual: string | undefined, expected: string | RegExp) =>
  typeof expected === 'string' ? expect(actual).toBe(expected) : expect(actual).toMatch(expected);

describe('the OTLP door — one fixture per convention', () => {
  it('every fixture in the directory has a row here and a row in the README, so a new one cannot land unread', () => {
    const files = readdirSync(DIR).filter((f) => f.endsWith('.otlp.json')).sort();
    expect(files).toEqual(Object.keys(TABLE).sort());
    const readme = readFileSync(DIR + 'README.md', 'utf-8');
    for (const f of files) expect(readme, `README names ${f}`).toContain(`\`${f}\``);
  });

  for (const [file, want] of Object.entries(TABLE)) {
    it(`${file}: agent, input, output, tokens, model, session, steps, and what it lacked`, () => {
      const { trace, lacked, steps } = load(file);
      expect(trace.agent_name).toBe(want.agent);
      matches(trace.input, want.input);
      matches(trace.output, want.output);
      expect(trace.token_usage).toEqual(want.tokens);
      // No framework in the table emits a cost attribute (the GenAI registry has none), so the cost is the
      // tokens above at the list price of the model below: marked estimated, never passed off as reported.
      if (want.cost === null) {
        expect(trace.cost_usd).toBeUndefined();
        expect(trace.cost_source).toBeUndefined();
        expect(trace.cost_estimate).toMatchObject({ status: 'unpriced', reason: 'unknown_model', models: [want.model] });
      } else {
        expect(trace.cost_usd).toBeCloseTo(want.cost.usd, 12);
        expect(trace.cost_source).toBe('estimated');
        expect(trace.cost_estimate).toMatchObject({ status: 'estimated', basis: 'token_usage', calls: [{ priced_as: want.cost.pricedAs, prompt_tokens: want.tokens.prompt_tokens, completion_tokens: want.tokens.completion_tokens }] });
      }
      expect(trace.metadata?.model).toBe(want.model);
      expect(trace.session_id).toBe(want.session);
      expect(steps).toEqual(want.steps);
      expect(lacked).toHaveLength(want.lacked.length);
      want.lacked.forEach((l, idx) => matches(lacked[idx], l));
      expect(trace.source).toBe('otel');
    });
  }

  it('google-adk: the tool catalogue rides along as tools[], in the shape valid_tool_arguments checks against', () => {
    const { trace } = load('google-adk.otlp.json');
    expect(trace.tools).toEqual([
      { name: 'get_weather', description: 'Current weather for a city', inputSchema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    ]);
  });

  it('pydantic-ai: the cache-read tokens stay on the span they came on — informational, never usage', () => {
    const { trace } = load('pydantic-ai.otlp.json');
    const carrier = trace.spans?.find((s) => s.attributes?.['gen_ai.usage.cache_read.input_tokens'] !== undefined);
    expect(carrier?.attributes?.['gen_ai.usage.cache_read.input_tokens']).toBe(256);
  });

  it('the kinds are read off each convention: LLM and TOOL spans are found without gen_ai.operation.name', () => {
    const kinds = (file: string) => load(file).trace.spans?.map((s) => `${s.name}:${s.kind}`);
    expect(kinds('langsmith.otlp.json')).toEqual(['support_graph:INTERNAL', 'lookup_order:TOOL', 'ChatOpenAI:LLM']);
    expect(kinds('traceloop.otlp.json')).toEqual(['answer_question.workflow:INTERNAL', 'retrieve_policy.tool:TOOL', 'openai.chat:LLM']);
    expect(kinds('crewai-openinference.otlp.json')).toEqual(['Crew.kickoff:INTERNAL', 'Task._execute_core:INTERNAL', 'web_search:TOOL', 'ChatOpenAI.chat:LLM']);
    expect(kinds('vercel-ai-sdk.otlp.json')).toEqual(['ai.generateText:LLM', 'ai.generateText.doGenerate:LLM', 'ai.toolCall:TOOL']);
  });

  it('an agent operation (invoke_agent, create_agent) is INTERNAL, never a model call, and the usage totals do not move', () => {
    const kinds = (file: string) => load(file).trace.spans?.map((s) => `${s.name}:${s.kind}`);
    // The Agent Framework's invoke_agent carries the model's name and the run's usage; it is still the agent, not a call.
    expect(kinds('agent-framework.otlp.json')).toEqual(['invoke_agent Writer:INTERNAL', 'chat gpt-4o-mini:LLM', 'execute_tool get_release_facts:TOOL', 'chat gpt-4o-mini:LLM']);
    expect(kinds('google-adk.otlp.json')).toEqual(['invoke_agent weather_agent:INTERNAL', 'generate_content gemini-2.5-flash:LLM', 'execute_tool get_weather:TOOL']);
    expect(kinds('pydantic-ai.otlp.json')).toEqual(['agent run:INTERNAL', 'chat gpt-4o:LLM', 'running tool get_weather:TOOL', 'chat gpt-4o:LLM']);
    // Usage is summed over the leaf carriers whatever their kind: the totals are the ones asserted above, unchanged.
    expect(load('agent-framework.otlp.json').trace.token_usage).toEqual({ prompt_tokens: 1742, completion_tokens: 136, total_tokens: 1878 });
    expect(load('google-adk.otlp.json').trace.token_usage).toEqual({ prompt_tokens: 318, completion_tokens: 44, total_tokens: 362 });
    expect(load('pydantic-ai.otlp.json').trace.token_usage).toEqual({ prompt_tokens: 812, completion_tokens: 133, total_tokens: 945 });
  });
});
