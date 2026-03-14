/**
 * Seed Demo Data — Populates the Iris dashboard with realistic agent traces
 *
 * Usage: npx tsx scripts/seed-demo-data.ts [--db-path <path>]
 * Default: ~/.iris/demo.db
 */

import { parseArgs } from 'node:util';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { mkdirSync, existsSync } from 'node:fs';
import { SqliteAdapter } from '../src/storage/sqlite-adapter.js';
import { generateTraceId, generateSpanId, generateEvalId } from '../src/utils/ids.js';
import type { Trace, Span } from '../src/types/trace.js';
import type { EvalResult } from '../src/types/eval.js';

const { values } = parseArgs({
  options: { 'db-path': { type: 'string' } },
  strict: false,
});

const dbPath = (values['db-path'] as string) ?? join(homedir(), '.iris', 'demo.db');
const dbDir = join(dbPath, '..');
if (!existsSync(dbDir)) mkdirSync(dbDir, { recursive: true });

const AGENTS = [
  { name: 'customer-support-bot', framework: 'langchain' },
  { name: 'code-review-agent', framework: 'crewai' },
  { name: 'research-assistant', framework: 'autogen' },
  { name: 'data-pipeline-agent', framework: 'custom' },
];

const TOOL_NAMES = ['web_search', 'code_analysis', 'database_query', 'file_read', 'calculator', 'api_call'];

const INPUTS = [
  'Summarize the latest quarterly report',
  'Review this pull request for security issues',
  'What are the top trends in AI observability?',
  'Process the customer feedback dataset',
  'Explain the error in this code snippet',
  'Generate a report on agent performance metrics',
  'Find relevant documentation for the MCP protocol',
  'Analyze customer sentiment from support tickets',
  'Draft a response to the billing inquiry',
  'Identify anomalies in the transaction logs',
];

const OUTPUTS = [
  'The quarterly report shows 15% revenue growth with strong performance in the enterprise segment. Key highlights include expansion into 3 new markets and a 20% increase in customer retention.',
  'Found 2 potential issues: 1) SQL query uses string interpolation instead of parameterized queries (line 45). 2) API key is logged in debug mode (line 78). Recommend fixing both before merge.',
  'Top trends in AI observability include: trace-based debugging for multi-step agents, quality evaluation frameworks, cost tracking per execution, and MCP-native tooling for protocol-level visibility.',
  'Processed 1,247 feedback entries. Sentiment breakdown: 68% positive, 22% neutral, 10% negative. Top themes: response quality (45%), latency (30%), cost concerns (25%).',
  'The error occurs because the async function is not awaited on line 23. The promise rejection goes unhandled, causing the process to exit silently. Add await before the function call.',
  'Agent performance summary: avg latency 1.2s, avg cost $0.003/call, eval pass rate 87%. The code-review-agent shows highest accuracy at 94% pass rate.',
  'The MCP protocol documentation covers: tool registration, resource templates, stdio and HTTP transports, session management, and server manifests for registry listing.',
  'Sentiment analysis complete. 78% of tickets express frustration with wait times. Recommended action: implement priority queue for high-value customers.',
  'Draft response: "Thank you for reaching out about your billing concern. I\'ve reviewed your account and identified the discrepancy. A credit of $45.00 has been applied."',
  'Detected 3 anomalies in the last 24 hours: unusually high transaction volume at 3:00 AM UTC, duplicate entries from merchant ID 7823, and a currency conversion error affecting EUR transactions.',
];

function randomChoice<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomBetween(min: number, max: number): number {
  return Math.round((Math.random() * (max - min) + min) * 100) / 100;
}

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

async function seed() {
  const adapter = new SqliteAdapter(dbPath);
  await adapter.initialize();

  const traces: Trace[] = [];
  const spans: Span[] = [];
  const evals: EvalResult[] = [];

  // Generate 30 traces distributed over the last 24 hours
  for (let i = 0; i < 30; i++) {
    const agent = randomChoice(AGENTS);
    const traceId = generateTraceId();
    const hoursBack = randomBetween(0.5, 23.5);
    const timestamp = hoursAgo(hoursBack);
    const isError = i === 7 || i === 19; // 2 error traces
    const latencyMs = isError ? randomBetween(5000, 30000) : randomBetween(200, 5000);
    const promptTokens = Math.floor(randomBetween(50, 5000));
    const completionTokens = Math.floor(randomBetween(20, 10000));
    const costPerToken = 0.0001;

    const input = randomChoice(INPUTS);
    const output = isError ? '' : randomChoice(OUTPUTS);

    const toolCallCount = Math.floor(randomBetween(0, 4));
    const toolCalls = Array.from({ length: toolCallCount }, () => ({
      tool_name: randomChoice(TOOL_NAMES),
      input: { query: input.slice(0, 30) },
      output: { result: 'success' },
      latency_ms: randomBetween(50, 500),
    }));

    const trace: Trace = {
      trace_id: traceId,
      agent_name: agent.name,
      framework: agent.framework,
      input,
      output,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      latency_ms: latencyMs,
      token_usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      cost_usd: (promptTokens + completionTokens) * costPerToken,
      metadata: { model: randomChoice(['claude-3-sonnet', 'claude-3-haiku', 'gpt-4o-mini']), session_id: `sess-${i}` },
      timestamp,
    };

    traces.push(trace);

    // Create spans for each trace
    const rootSpanId = generateSpanId();
    spans.push({
      span_id: rootSpanId,
      trace_id: traceId,
      name: 'agent.run',
      kind: 'INTERNAL',
      status_code: isError ? 'ERROR' : 'OK',
      status_message: isError ? 'Agent execution failed' : undefined,
      start_time: timestamp,
      end_time: new Date(new Date(timestamp).getTime() + latencyMs).toISOString(),
    });

    // LLM span
    const llmSpanId = generateSpanId();
    spans.push({
      span_id: llmSpanId,
      trace_id: traceId,
      parent_span_id: rootSpanId,
      name: 'llm.call',
      kind: 'LLM',
      status_code: 'OK',
      start_time: new Date(new Date(timestamp).getTime() + 50).toISOString(),
      end_time: new Date(new Date(timestamp).getTime() + latencyMs * 0.7).toISOString(),
      attributes: { model: trace.metadata?.model, temperature: 0.7 },
    });

    // Tool spans
    for (const tc of toolCalls) {
      spans.push({
        span_id: generateSpanId(),
        trace_id: traceId,
        parent_span_id: rootSpanId,
        name: `tool.${tc.tool_name}`,
        kind: 'TOOL',
        status_code: 'OK',
        start_time: new Date(new Date(timestamp).getTime() + latencyMs * 0.7).toISOString(),
        end_time: new Date(new Date(timestamp).getTime() + latencyMs * 0.7 + (tc.latency_ms ?? 100)).toISOString(),
      });
    }

    // Create eval result for ~70% of traces
    if (!isError && Math.random() > 0.3) {
      const evalTypes = ['completeness', 'relevance', 'safety', 'cost'] as const;
      const evalType = randomChoice([...evalTypes]);
      const score = randomBetween(0.4, 1.0);
      const passed = score >= 0.7;

      evals.push({
        id: generateEvalId(),
        trace_id: traceId,
        eval_type: evalType,
        output_text: output,
        score: Math.round(score * 1000) / 1000,
        passed,
        rule_results: [
          { ruleName: `${evalType}_check`, passed, score, message: passed ? 'Passed' : 'Below threshold' },
        ],
        suggestions: passed ? [] : [`Improve ${evalType} score`],
      });
    }
  }

  // Insert all data
  for (const trace of traces) {
    await adapter.insertTrace(trace);
  }
  for (const span of spans) {
    await adapter.insertSpan(span);
  }
  for (const evalResult of evals) {
    await adapter.insertEvalResult(evalResult);
  }

  await adapter.close();

  process.stderr.write(`\nDemo data seeded to ${dbPath}\n`);
  process.stderr.write(`  Traces: ${traces.length}\n`);
  process.stderr.write(`  Spans: ${spans.length}\n`);
  process.stderr.write(`  Evals: ${evals.length}\n`);
  process.stderr.write(`  Agents: ${AGENTS.map((a) => a.name).join(', ')}\n`);
  process.stderr.write(`\nStart the dashboard:\n`);
  process.stderr.write(`  npx tsx src/index.ts --transport http --dashboard --db-path ${dbPath}\n\n`);
}

seed().catch((err) => {
  process.stderr.write(`Error: ${err}\n`);
  process.exit(1);
});
