/**
 * Iris Demo — Full MCP round-trip walkthrough
 *
 * Starts an Iris server, connects via MCP protocol, and demonstrates
 * all three tools + resource reading. Designed for asciinema recording.
 *
 * Usage: npx tsx scripts/demo.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { resolve } from 'node:path';

function log(section: string, message: string) {
  process.stderr.write(`\n${'='.repeat(60)}\n`);
  process.stderr.write(`  ${section}\n`);
  process.stderr.write(`${'='.repeat(60)}\n\n`);
  process.stderr.write(`${message}\n`);
}

function result(label: string, data: unknown) {
  process.stderr.write(`\n  ${label}:\n`);
  process.stderr.write(`  ${JSON.stringify(data, null, 2).split('\n').join('\n  ')}\n`);
}

async function main() {
  log('Step 1: Connect to Iris', 'Starting Iris MCP server via stdio transport...');

  const serverPath = resolve(import.meta.dirname, '../src/index.ts');
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['tsx', serverPath],
  });

  const client = new Client({ name: 'iris-demo', version: '1.0.0' });
  await client.connect(transport);

  // List available tools
  const tools = await client.listTools();
  process.stderr.write(`\n  Connected! Available tools:\n`);
  for (const tool of tools.tools) {
    process.stderr.write(`    - ${tool.name}: ${tool.description}\n`);
  }

  // ---- Step 2: Log a trace ----
  log('Step 2: Log a Trace', 'Logging an agent execution trace with tool calls and metrics...');

  const logResult = await client.callTool({
    name: 'log_trace',
    arguments: {
      agent_name: 'demo-agent',
      framework: 'langchain',
      input: 'What are the key benefits of MCP-native observability?',
      output: 'MCP-native observability provides three key benefits: 1) Protocol-level integration without SDK lock-in, 2) Automatic tool and resource discovery, 3) Works with any MCP-compatible agent framework including Claude Desktop, Cursor, and custom implementations.',
      latency_ms: 2340,
      token_usage: { prompt_tokens: 85, completion_tokens: 62, total_tokens: 147 },
      cost_usd: 0.0029,
      tool_calls: [
        { tool_name: 'web_search', input: { query: 'MCP protocol benefits' }, latency_ms: 450 },
        { tool_name: 'doc_lookup', input: { topic: 'observability' }, latency_ms: 120 },
      ],
      spans: [
        { name: 'agent.run', kind: 'INTERNAL', status_code: 'OK', start_time: new Date(Date.now() - 2340).toISOString(), end_time: new Date().toISOString() },
        { name: 'llm.generate', kind: 'LLM', status_code: 'OK', start_time: new Date(Date.now() - 2000).toISOString(), end_time: new Date(Date.now() - 500).toISOString() },
      ],
    },
  });
  const traceData = JSON.parse((logResult.content as Array<{ text: string }>)[0].text);
  result('Trace logged', traceData);

  // ---- Step 3: Evaluate output ----
  log('Step 3: Evaluate Output Quality', 'Running completeness evaluation on the agent output...');

  const evalResult = await client.callTool({
    name: 'evaluate_output',
    arguments: {
      output: 'MCP-native observability provides three key benefits: 1) Protocol-level integration without SDK lock-in, 2) Automatic tool and resource discovery, 3) Works with any MCP-compatible agent framework including Claude Desktop, Cursor, and custom implementations.',
      eval_type: 'completeness',
      expected: 'MCP observability benefits include protocol integration, tool discovery, and framework compatibility.',
      trace_id: traceData.trace_id,
    },
  });
  const evalData = JSON.parse((evalResult.content as Array<{ text: string }>)[0].text);
  result('Evaluation result', {
    score: evalData.score,
    passed: evalData.passed,
    rules: evalData.rule_results.map((r: { ruleName: string; passed: boolean; score: number }) => `${r.ruleName}: ${r.passed ? 'PASS' : 'FAIL'} (${r.score})`),
  });

  // ---- Step 4: Query traces ----
  log('Step 4: Query Traces', 'Searching for traces from demo-agent...');

  const queryResult = await client.callTool({
    name: 'get_traces',
    arguments: {
      agent_name: 'demo-agent',
      limit: 5,
      include_summary: true,
    },
  });
  const queryData = JSON.parse((queryResult.content as Array<{ text: string }>)[0].text);
  result('Query result', {
    total_traces: queryData.total,
    first_trace: queryData.traces[0]?.agent_name,
    summary: queryData.summary ? {
      total_traces: queryData.summary.total_traces,
      avg_latency: `${queryData.summary.avg_latency_ms}ms`,
      total_cost: `$${queryData.summary.total_cost_usd}`,
    } : 'N/A',
  });

  // ---- Step 5: Read dashboard summary ----
  log('Step 5: Read Dashboard Summary', 'Reading the iris://dashboard/summary resource...');

  const resources = await client.listResources();
  process.stderr.write(`  Available resources:\n`);
  for (const r of resources.resources) {
    process.stderr.write(`    - ${r.uri}: ${r.description}\n`);
  }

  const summary = await client.readResource({ uri: 'iris://dashboard/summary' });
  const summaryData = JSON.parse(summary.contents[0].text as string);
  result('Dashboard summary', summaryData);

  // ---- Done ----
  log('Demo Complete', 'Iris MCP server is ready for production use.\n\n  Install:  npm install -g @iris-eval/mcp-server\n  Start:    iris-mcp --dashboard\n  Dashboard: http://localhost:6920\n\n  GitHub:   https://github.com/iris-eval/mcp-server\n  npm:      https://npmjs.com/package/@iris-eval/mcp-server\n');

  await client.close();
}

main().catch((err) => {
  process.stderr.write(`Demo error: ${err}\n`);
  process.exit(1);
});
