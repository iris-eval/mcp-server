/**
 * Iris HTTP Transport — TypeScript Client Example
 *
 * Demonstrates the full workflow:
 *   1. Start Iris in HTTP mode programmatically
 *   2. Log a trace via MCP over HTTP (JSON-RPC)
 *   3. Evaluate the output via MCP over HTTP
 *   4. Query traces and summary via the Dashboard REST API
 *
 * Prerequisites:
 *   npm install @iris-eval/mcp-server
 *
 * Run:
 *   npx tsx examples/http-transport/client.ts
 *
 * Or start Iris separately and run the client against it:
 *   npx @iris-eval/mcp-server --transport http --port 3000 --api-key test-key --dashboard
 *   IRIS_ALREADY_RUNNING=1 npx tsx examples/http-transport/client.ts
 */

import { spawn, type ChildProcess } from 'node:child_process';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const MCP_PORT = 3000;
const DASHBOARD_PORT = 6920;
const API_KEY = 'example-api-key';

const MCP_URL = `http://localhost:${MCP_PORT}`;
const DASHBOARD_URL = `http://localhost:${DASHBOARD_PORT}`;
const AUTH_HEADER = { Authorization: `Bearer ${API_KEY}` };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Make a JSON-RPC 2.0 tool call to the MCP HTTP endpoint. */
async function mcpToolCall(
  toolName: string,
  args: Record<string, unknown>,
  id: number = 1,
): Promise<unknown> {
  const res = await fetch(`${MCP_URL}/mcp`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...AUTH_HEADER,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: toolName, arguments: args },
    }),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`MCP request failed (${res.status}): ${text}`);
  }

  const json = (await res.json()) as {
    result?: { content?: Array<{ text: string }> };
    error?: { message: string };
  };

  if (json.error) {
    throw new Error(`MCP error: ${json.error.message}`);
  }

  // MCP tool results come wrapped in content[].text
  const text = json.result?.content?.[0]?.text;
  return text ? JSON.parse(text) : json.result;
}

/** Make a GET request to the Dashboard REST API. */
async function dashboardGet(
  path: string,
  params?: Record<string, string>,
): Promise<unknown> {
  const url = new URL(`/api/v1${path}`, DASHBOARD_URL);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), { headers: AUTH_HEADER });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Dashboard request failed (${res.status}): ${text}`);
  }

  return res.json();
}

/** Wait for a URL to respond with 200, retrying up to `maxAttempts` times. */
async function waitForServer(url: string, maxAttempts = 30): Promise<void> {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Server not ready yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Server at ${url} did not become ready`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  let serverProcess: ChildProcess | undefined;

  // Start Iris if not already running
  if (!process.env.IRIS_ALREADY_RUNNING) {
    console.log('Starting Iris in HTTP mode...');
    serverProcess = spawn(
      'npx',
      [
        '@iris-eval/mcp-server',
        '--transport', 'http',
        '--port', String(MCP_PORT),
        '--api-key', API_KEY,
        '--dashboard',
        '--dashboard-port', String(DASHBOARD_PORT),
      ],
      { stdio: 'pipe', shell: true },
    );

    serverProcess.stderr?.on('data', (data: Buffer) => {
      const line = data.toString().trim();
      if (line) console.log(`  [iris] ${line}`);
    });

    // Wait for both servers to be ready
    console.log('Waiting for servers to start...');
    await waitForServer(`${MCP_URL}/health`);
    await waitForServer(`${DASHBOARD_URL}/api/v1/health`);
    console.log('Servers ready.\n');
  }

  try {
    // -----------------------------------------------------------------------
    // Step 1: Log a trace
    // -----------------------------------------------------------------------
    console.log('--- Step 1: Log a trace ---');
    const logResult = (await mcpToolCall('log_trace', {
      agent_name: 'code-review-agent',
      framework: 'langchain',
      input: 'Review this pull request for security issues',
      output: 'Found 2 potential SQL injection vulnerabilities in auth.ts on lines 42 and 87. The user input is concatenated directly into the query string without parameterization.',
      tool_calls: [
        { tool_name: 'read_file', input: { path: 'src/auth.ts' }, latency_ms: 45 },
        { tool_name: 'search_code', input: { query: 'SQL injection' }, output: { matches: 2 }, latency_ms: 120 },
      ],
      latency_ms: 3200,
      token_usage: { prompt_tokens: 1500, completion_tokens: 800, total_tokens: 2300 },
      cost_usd: 0.0345,
      metadata: { pr_number: 42, repo: 'acme/backend' },
      spans: [
        {
          name: 'llm_call',
          kind: 'LLM',
          status_code: 'OK',
          start_time: new Date(Date.now() - 3200).toISOString(),
          end_time: new Date().toISOString(),
          attributes: { model: 'gpt-4o' },
        },
      ],
    })) as { trace_id: string; status: string };

    const traceId = logResult.trace_id;
    console.log(`Logged trace: ${traceId} (status: ${logResult.status})\n`);

    // -----------------------------------------------------------------------
    // Step 2: Evaluate the output (completeness)
    // -----------------------------------------------------------------------
    console.log('--- Step 2: Evaluate output (completeness) ---');
    const evalResult = (await mcpToolCall('evaluate_output', {
      output: 'Found 2 potential SQL injection vulnerabilities in auth.ts on lines 42 and 87. The user input is concatenated directly into the query string without parameterization.',
      eval_type: 'completeness',
      expected: 'SQL injection found in auth.ts at the query concatenation on line 42',
      input: 'Review the code for security issues',
      trace_id: traceId,
    }, 2)) as { id: string; score: number; passed: boolean; rule_results: Array<{ ruleName: string; score: number }> };

    console.log(`Evaluation: id=${evalResult.id}, score=${evalResult.score}, passed=${evalResult.passed}`);
    for (const rule of evalResult.rule_results) {
      console.log(`  ${rule.ruleName}: ${rule.score}`);
    }
    console.log();

    // -----------------------------------------------------------------------
    // Step 3: Evaluate with custom rules
    // -----------------------------------------------------------------------
    console.log('--- Step 3: Evaluate with custom rules ---');
    const customEval = (await mcpToolCall('evaluate_output', {
      output: 'Found 2 potential SQL injection vulnerabilities in auth.ts on lines 42 and 87.',
      eval_type: 'custom',
      custom_rules: [
        { name: 'min_response_length', type: 'min_length', config: { length: 50 }, weight: 1 },
        { name: 'mentions_file', type: 'contains_keywords', config: { keywords: ['auth.ts', 'SQL injection'] }, weight: 2 },
        { name: 'no_apology', type: 'regex_no_match', config: { pattern: "I apologize|I'm sorry", flags: 'i' }, weight: 1 },
      ],
    }, 3)) as { score: number; passed: boolean; rule_results: Array<{ ruleName: string; score: number; message: string }> };

    console.log(`Custom eval: score=${customEval.score}, passed=${customEval.passed}`);
    for (const rule of customEval.rule_results) {
      console.log(`  ${rule.ruleName}: ${rule.score} -- ${rule.message}`);
    }
    console.log();

    // -----------------------------------------------------------------------
    // Step 4: Query traces via MCP
    // -----------------------------------------------------------------------
    console.log('--- Step 4: Query traces via MCP tool ---');
    const queryResult = (await mcpToolCall('get_traces', {
      agent_name: 'code-review-agent',
      limit: 5,
      sort_by: 'timestamp',
      sort_order: 'desc',
    }, 4)) as { traces: Array<{ trace_id: string; agent_name: string; cost_usd: number }>; total: number };

    console.log(`Found ${queryResult.total} trace(s)`);
    for (const t of queryResult.traces) {
      console.log(`  ${t.trace_id} | ${t.agent_name} | $${t.cost_usd}`);
    }
    console.log();

    // -----------------------------------------------------------------------
    // Step 5: Query the Dashboard REST API
    // -----------------------------------------------------------------------
    console.log('--- Step 5: Query Dashboard REST API ---');

    // 5a. List traces
    const traces = (await dashboardGet('/traces', {
      agent_name: 'code-review-agent',
      limit: '5',
      sort_by: 'cost_usd',
      sort_order: 'desc',
    })) as { traces: Array<{ trace_id: string }>; total: number };
    console.log(`Dashboard traces: ${traces.total} total, showing ${traces.traces.length}`);

    // 5b. Get single trace detail
    const detail = (await dashboardGet(`/traces/${traceId}`)) as {
      trace: { trace_id: string };
      spans: unknown[];
      evals: unknown[];
    };
    console.log(`Trace detail: ${detail.trace.trace_id}, ${detail.spans.length} span(s), ${detail.evals.length} eval(s)`);

    // 5c. Summary metrics
    const summary = (await dashboardGet('/summary', { hours: '24' })) as {
      total_traces: number;
      avg_latency_ms: number;
      total_cost_usd: number;
      eval_pass_rate: number;
    };
    console.log(`Summary: ${summary.total_traces} traces, avg latency ${summary.avg_latency_ms}ms, $${summary.total_cost_usd} total cost, ${(summary.eval_pass_rate * 100).toFixed(1)}% pass rate`);

    // 5d. Evaluations
    const evals = (await dashboardGet('/evaluations', { limit: '5' })) as {
      results: Array<{ id: string; score: number }>;
      total: number;
    };
    console.log(`Evaluations: ${evals.total} total`);

    // 5e. Filter values
    const filters = (await dashboardGet('/filters')) as {
      agent_names: string[];
      frameworks: string[];
    };
    console.log(`Filters: agents=${filters.agent_names.join(', ')}, frameworks=${filters.frameworks.join(', ')}`);

    console.log('\nDone!');
  } finally {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
