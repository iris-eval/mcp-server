import type { Trace, Span } from '../../src/types/trace.js';

export const sampleTrace: Trace = {
  trace_id: 'a'.repeat(32),
  agent_name: 'test-agent',
  framework: 'langchain',
  input: 'What is the weather today?',
  output: 'The weather today is sunny with a high of 75°F.',
  tool_calls: [
    {
      tool_name: 'weather_api',
      input: { location: 'San Francisco' },
      output: { temperature: 75, condition: 'sunny' },
      latency_ms: 120,
    },
  ],
  latency_ms: 1500,
  token_usage: { prompt_tokens: 50, completion_tokens: 25, total_tokens: 75 },
  cost_usd: 0.0015,
  metadata: { model: 'claude-3-sonnet', session_id: 'sess-123' },
  timestamp: '2026-01-15T10:30:00.000Z',
};

export const sampleSpans: Span[] = [
  {
    span_id: 'b'.repeat(16),
    trace_id: 'a'.repeat(32),
    name: 'agent.run',
    kind: 'INTERNAL',
    status_code: 'OK',
    start_time: '2026-01-15T10:30:00.000Z',
    end_time: '2026-01-15T10:30:01.500Z',
  },
  {
    span_id: 'c'.repeat(16),
    trace_id: 'a'.repeat(32),
    parent_span_id: 'b'.repeat(16),
    name: 'llm.call',
    kind: 'LLM',
    status_code: 'OK',
    start_time: '2026-01-15T10:30:00.100Z',
    end_time: '2026-01-15T10:30:01.000Z',
    attributes: { model: 'claude-3-sonnet', temperature: 0.7 },
  },
  {
    span_id: 'd'.repeat(16),
    trace_id: 'a'.repeat(32),
    parent_span_id: 'b'.repeat(16),
    name: 'tool.weather_api',
    kind: 'TOOL',
    status_code: 'OK',
    start_time: '2026-01-15T10:30:01.000Z',
    end_time: '2026-01-15T10:30:01.120Z',
  },
];

export const minimalTrace: Trace = {
  trace_id: 'e'.repeat(32),
  agent_name: 'minimal-agent',
  timestamp: '2026-01-15T11:00:00.000Z',
};

export const errorTrace: Trace = {
  trace_id: 'f'.repeat(32),
  agent_name: 'error-agent',
  framework: 'autogen',
  input: 'Do something impossible',
  output: '',
  latency_ms: 5000,
  token_usage: { prompt_tokens: 200, completion_tokens: 5, total_tokens: 205 },
  cost_usd: 0.05,
  timestamp: '2026-01-15T12:00:00.000Z',
};

export const expensiveTrace: Trace = {
  trace_id: '1'.repeat(32),
  agent_name: 'expensive-agent',
  output: 'A very long and expensive response that consumed many tokens.',
  latency_ms: 30000,
  token_usage: { prompt_tokens: 5000, completion_tokens: 10000, total_tokens: 15000 },
  cost_usd: 1.50,
  timestamp: '2026-01-15T13:00:00.000Z',
};

export const allSampleTraces: Trace[] = [sampleTrace, minimalTrace, errorTrace, expensiveTrace];
