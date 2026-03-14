# Iris Demo Recording Script

Target length: 3-4 minutes. Screen recording with narration. Terminal on the left, browser on the right (split screen for dashboard sections).

---

## Scene 1: "Let's set up Iris in 60 seconds"

**Narration:** "Iris is an open-source observability server for AI agents. Let's get it running."

**Terminal commands:**

```bash
# Install globally
npm install -g @iris-eval/mcp-server

# Start with HTTP transport and dashboard enabled
iris-mcp --transport http --port 3000 --dashboard

# Expected output:
# [info] Iris MCP server starting...
# [info] Transport: http
# [info] HTTP server listening on port 3000
# [info] Dashboard available at http://localhost:6920
# [info] Database: ~/.iris/iris.db
```

**Narration:** "One install, one command. The MCP server is running on port 3000 and the dashboard is at port 6920. Traces are stored in a local SQLite file."

---

## Scene 2: "Log your first trace"

**Narration:** "Iris exposes MCP tools. Any MCP-compatible agent can call them. Let's log a trace manually to see how it works."

**Option A: Using Claude Desktop**

**Narration:** "If you use Claude Desktop, add Iris to your MCP config."

Show the config file at `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS) or `%APPDATA%/Claude/claude_desktop_config.json` (Windows):

```json
{
  "mcpServers": {
    "iris": {
      "command": "npx",
      "args": ["@iris-eval/mcp-server"]
    }
  }
}
```

**Narration:** "Now Claude Desktop can call Iris tools directly. Ask it to log a trace and it will use the `log_trace` tool."

**Option B: Using curl (HTTP transport)**

```bash
# Log a trace via the MCP HTTP endpoint
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "log_trace",
      "arguments": {
        "agent_name": "support-bot",
        "input": "How do I reset my password?",
        "output": "Go to Settings > Security > Reset Password. Click the reset link sent to your email.",
        "tool_calls": [
          {
            "tool_name": "search_docs",
            "input": "password reset instructions",
            "output": "Found 3 matching documents..."
          }
        ],
        "latency_ms": 1450,
        "token_usage": {
          "prompt_tokens": 520,
          "completion_tokens": 85,
          "total_tokens": 605
        },
        "cost_usd": 0.0038
      }
    }
  }'
```

**Narration:** "The response includes the trace ID. Let's use it to evaluate the output."

---

## Scene 3: "Evaluate output quality"

**Narration:** "The `evaluate_output` tool runs your output through configurable rules and returns a score."

```bash
# Evaluate the output for safety (PII, injection, blocklist)
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "evaluate_output",
      "arguments": {
        "output": "Go to Settings > Security > Reset Password. Click the reset link sent to your email.",
        "eval_type": "safety",
        "trace_id": "TRACE_ID_FROM_STEP_2"
      }
    }
  }'
```

**Narration:** "Score: 1.0, passed: true. All three safety rules passed -- no PII detected, no blocklisted content, no injection patterns."

**Then show a failing case:**

```bash
# Evaluate an output that contains PII
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "evaluate_output",
      "arguments": {
        "output": "Your account email is john.doe@example.com and your SSN is 123-45-6789.",
        "eval_type": "safety"
      }
    }
  }'
```

**Narration:** "Score: 0.0, passed: false. The `no_pii` rule detected an email address and SSN. This is the kind of issue that would be invisible without automated evaluation."

---

## Scene 4: "Query your traces"

**Narration:** "Use `get_traces` to search your trace history."

```bash
# Get traces for a specific agent with a minimum score
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "get_traces",
      "arguments": {
        "agent_name": "support-bot",
        "since": "2026-03-12T00:00:00Z",
        "limit": 10
      }
    }
  }'
```

**Narration:** "Returns matching traces with their scores, latency, cost, and tool call counts. You can filter by agent name, time range, score range, and paginate through results."

---

## Scene 5: "Open the dashboard"

**Narration:** "Open http://localhost:6920 in your browser."

**[Switch to browser -- show dashboard]**

**Page: Summary**
**Narration:** "The summary page shows four cards at the top: total traces, average evaluation score, pass rate, and total cost. Below that, a timeline chart shows trace volume and scores over time."

**[SCREENSHOT PLACEHOLDER: dashboard summary page with cards and chart]**

**Page: Traces**
**Narration:** "The traces page lists every recorded trace. You can sort by timestamp, score, latency, or cost. Filter by agent name or time range. Click any trace to expand it."

**[SCREENSHOT PLACEHOLDER: trace list with columns]**

**Page: Trace Detail**
**Narration:** "The trace detail view shows the full span tree -- every step in the agent's execution with timing. On the right, evaluation results show per-rule scores and suggestions for improvement."

**[SCREENSHOT PLACEHOLDER: span tree with eval results sidebar]**

---

## Scene 6: "That's Iris"

**Narration:** "That's Iris. Three MCP tools, 12 built-in eval rules, a real-time dashboard, and SQLite storage. Self-hosted, MIT licensed, no cloud dependency."

**Show on screen:**

```
GitHub:  https://github.com/iris-eval/mcp-server
npm:     https://www.npmjs.com/package/@iris-eval/mcp-server
Install: npm install -g @iris-eval/mcp-server
```

**Narration:** "Install it, point your agent at it, and start seeing what your agents are actually doing. Star the repo on GitHub if you find it useful. Thanks for watching."

---

## Recording Notes

- Terminal font: monospace, 16pt minimum for readability
- Use a dark terminal theme to match the dashboard aesthetic
- Pause briefly after each command to let output render
- Replace `TRACE_ID_FROM_STEP_2` with the actual trace ID returned in scene 2 during recording
- Dashboard screenshots should show realistic data (run a few dozen traces before recording)
- Total recording target: under 4 minutes
