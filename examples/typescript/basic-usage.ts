/**
 * Iris MCP Server — Basic Usage Example
 *
 * This example connects to a running Iris server via MCP protocol,
 * logs a trace, evaluates the output, and queries the results.
 *
 * Prerequisites:
 *   1. Start Iris: npx @iris-eval/mcp-server --transport http --dashboard
 *   2. Run this: npx tsx examples/typescript/basic-usage.ts
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

async function main() {
  // Connect to Iris via stdio
  const transport = new StdioClientTransport({
    command: 'npx',
    args: ['@iris-eval/mcp-server'],
  });

  const client = new Client({ name: 'example-client', version: '1.0.0' });
  await client.connect(transport);

  console.log('Connected to Iris MCP server');

  // 1. Log a trace
  const logResult = await client.callTool({
    name: 'log_trace',
    arguments: {
      agent_name: 'example-agent',
      framework: 'custom',
      input: 'What is the capital of France?',
      output: 'The capital of France is Paris.',
      latency_ms: 1200,
      token_usage: { prompt_tokens: 15, completion_tokens: 8, total_tokens: 23 },
      cost_usd: 0.0003,
    },
  });
  const traceId = JSON.parse((logResult.content as Array<{ text: string }>)[0].text).trace_id;
  console.log(`Logged trace: ${traceId}`);

  // 2. Evaluate the output
  const evalResult = await client.callTool({
    name: 'evaluate_output',
    arguments: {
      output: 'The capital of France is Paris.',
      eval_type: 'completeness',
      expected: 'Paris is the capital of France.',
      trace_id: traceId,
    },
  });
  const evalData = JSON.parse((evalResult.content as Array<{ text: string }>)[0].text);
  console.log(`Evaluation: score=${evalData.score}, passed=${evalData.passed}`);

  // 3. Query traces
  const queryResult = await client.callTool({
    name: 'get_traces',
    arguments: {
      agent_name: 'example-agent',
      limit: 5,
    },
  });
  const queryData = JSON.parse((queryResult.content as Array<{ text: string }>)[0].text);
  console.log(`Found ${queryData.total} trace(s)`);

  await client.close();
  console.log('Done!');
}

main().catch(console.error);
