/*
 * One OpenAI Agents SDK (JavaScript) run traced by OpenInference — the recipe
 * in docs/otel-recipes.md, run for real.
 *
 *   node examples/otel-recipes/js/openai-agents-run.mjs "What is the weather in Paris?"
 *
 * Needs `npm ci` in this directory (the pinned versions in package.json). The
 * exporter reads the standard variables (OTEL_EXPORTER_OTLP_ENDPOINT,
 * OTEL_EXPORTER_OTLP_HEADERS). In CI the model is the scripted provider in
 * tests/fixtures/scripted-provider, reached through OPENAI_BASE_URL, so the
 * run needs no key and gives the same answer every time; with it unset, the
 * model is OpenAI's, with your OPENAI_API_KEY. No trace is sent to
 * OpenAI: the instrumentation replaces the SDK's own trace processor, which is
 * what would upload to the OpenAI dashboard.
 */

// --- the recipe: docs/otel-recipes.md, "OpenAI Agents SDK (JavaScript)" -----------
import * as agents from '@openai/agents';
import { OpenAIAgentsInstrumentation } from '@arizeai/openinference-instrumentation-openai-agents';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-proto';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';

const provider = new NodeTracerProvider({
  resource: resourceFromAttributes({ 'service.name': 'weather-agent' }),
  spanProcessors: [new BatchSpanProcessor(new OTLPTraceExporter())],   // reads OTEL_EXPORTER_OTLP_*
});
provider.register();
new OpenAIAgentsInstrumentation({ tracerProvider: provider }).manuallyInstrument(agents);
// --- end of the recipe ---------------------------------------------------------

import { context } from '@opentelemetry/api';
import { setSession } from '@arizeai/openinference-core';
import { z } from 'zod';

const getWeather = agents.tool({
  name: 'get_weather',
  description: 'The current weather for a city.',
  parameters: z.object({ city: z.string() }),
  execute: async ({ city }) => `18 degrees and sunny in ${city}`,
});

const agent = new agents.Agent({
  name: 'Weather agent',
  instructions: 'Answer questions about the weather. Use get_weather for current conditions.',
  model: 'gpt-4o-mini',
  tools: [getWeather],
});

const question = process.argv[2] ?? 'What is the weather in Paris?';
const result = await context.with(setSession(context.active(), { sessionId: 'session-paris-1' }), () => agents.run(agent, question));
console.log(result.finalOutput);
await provider.forceFlush();
await provider.shutdown();
