# Iris HTTP Transport

Use Iris over HTTP instead of stdio. This enables multi-client access, REST-based integrations, and browser-based dashboards — all with the same MCP tools available over the network.

## Starting Iris in HTTP Mode

### CLI

```bash
npx @iris-eval/mcp-server --transport http --port 3000 --api-key my-secret-key --dashboard
```

This starts two servers:

| Server | Default Port | Purpose |
|--------|-------------|---------|
| MCP over HTTP | 3000 | Streamable HTTP transport for MCP tool calls (`/mcp`) |
| Dashboard API | 6920 | REST API for querying traces, evaluations, and metrics (`/api/v1/*`) |

### Environment Variables

You can configure everything with environment variables instead of CLI flags:

```bash
export IRIS_TRANSPORT=http
export IRIS_PORT=3000
export IRIS_API_KEY=my-secret-key
export IRIS_DASHBOARD=true
export IRIS_DASHBOARD_PORT=6920
export IRIS_ALLOWED_ORIGINS="http://localhost:5173,https://myapp.example.com"

npx @iris-eval/mcp-server
```

### Health Check

The `/health` endpoint on the MCP server is unauthenticated:

```bash
curl http://localhost:3000/health
# {"status":"ok","server":"iris-eval","timestamp":"2026-03-16T12:00:00.000Z"}
```

The dashboard also has its own health endpoint at `/api/v1/health` (requires auth if `--api-key` is set):

```bash
curl -H "Authorization: Bearer my-secret-key" http://localhost:6920/api/v1/health
# {"status":"ok","version":"0.1.0","uptime_seconds":3600,"trace_count":142,"storage":"connected"}
```

---

## Authentication

When `--api-key` is set (or `IRIS_API_KEY` env var), all endpoints except `/health` require a Bearer token:

```
Authorization: Bearer my-secret-key
```

If the header is missing or incorrect, the server returns:

- **401** `{"error":"Missing or invalid Authorization header"}` -- no Bearer token
- **403** `{"error":"Invalid API key"}` -- wrong key

The comparison uses `timingSafeEqual` to prevent timing attacks.

---

## MCP Tool Calls via HTTP

The MCP server uses the Streamable HTTP transport at `POST /mcp`. The request body follows the [JSON-RPC 2.0](https://www.jsonrpc.org/specification) format used by the MCP protocol.

### 1. log_trace -- Log an Agent Execution Trace

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-secret-key" \
  -d '{
    "jsonrpc": "2.0",
    "id": 1,
    "method": "tools/call",
    "params": {
      "name": "log_trace",
      "arguments": {
        "agent_name": "code-review-agent",
        "framework": "langchain",
        "input": "Review this pull request for security issues",
        "output": "Found 2 potential SQL injection vulnerabilities in auth.ts...",
        "tool_calls": [
          {
            "tool_name": "read_file",
            "input": {"path": "src/auth.ts"},
            "latency_ms": 45
          }
        ],
        "latency_ms": 3200,
        "token_usage": {
          "prompt_tokens": 1500,
          "completion_tokens": 800,
          "total_tokens": 2300
        },
        "cost_usd": 0.0345,
        "metadata": {"pr_number": 42, "repo": "acme/backend"}
      }
    }
  }'
```

Response (inside the JSON-RPC result):

```json
{
  "trace_id": "trc_1a2b3c4d5e6f",
  "status": "stored"
}
```

### 2. evaluate_output -- Evaluate Agent Output Quality

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-secret-key" \
  -d '{
    "jsonrpc": "2.0",
    "id": 2,
    "method": "tools/call",
    "params": {
      "name": "evaluate_output",
      "arguments": {
        "output": "The SQL injection vulnerability is in auth.ts on line 42.",
        "eval_type": "completeness",
        "expected": "SQL injection found in auth.ts at the query concatenation on line 42",
        "input": "Review the code for security issues",
        "trace_id": "trc_1a2b3c4d5e6f"
      }
    }
  }'
```

Response (inside the JSON-RPC result):

```json
{
  "id": "eval_7g8h9i0j1k2l",
  "score": 0.925,
  "passed": true,
  "rule_results": [
    {"ruleName": "min_output_length", "passed": true, "score": 1, "message": "Output length (55) meets minimum (10)"},
    {"ruleName": "non_empty_output", "passed": true, "score": 1, "message": "Output is non-empty"},
    {"ruleName": "sentence_count", "passed": true, "score": 1, "message": "Sentence count (1) meets minimum (1)"},
    {"ruleName": "expected_coverage", "passed": true, "score": 0.8, "message": "Covered 8/10 expected terms (80%)"}
  ],
  "suggestions": []
}
```

#### Evaluate with Custom Rules

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-secret-key" \
  -d '{
    "jsonrpc": "2.0",
    "id": 3,
    "method": "tools/call",
    "params": {
      "name": "evaluate_output",
      "arguments": {
        "output": "{\"vulnerabilities\": [{\"type\": \"sqli\", \"file\": \"auth.ts\"}]}",
        "eval_type": "custom",
        "custom_rules": [
          {"name": "valid_json", "type": "json_schema", "config": {}, "weight": 2},
          {"name": "has_vuln_type", "type": "contains_keywords", "config": {"keywords": ["sqli", "xss", "csrf"]}, "weight": 1}
        ]
      }
    }
  }'
```

### 3. get_traces -- Query Stored Traces

```bash
curl -X POST http://localhost:3000/mcp \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer my-secret-key" \
  -d '{
    "jsonrpc": "2.0",
    "id": 4,
    "method": "tools/call",
    "params": {
      "name": "get_traces",
      "arguments": {
        "agent_name": "code-review-agent",
        "since": "2026-03-15T00:00:00Z",
        "limit": 10,
        "sort_by": "cost_usd",
        "sort_order": "desc",
        "include_summary": true
      }
    }
  }'
```

---

## Dashboard API Queries

The dashboard API runs on a separate port (default: 6920) and provides REST endpoints for querying traces, evaluations, and metrics. All endpoints require auth if `--api-key` is set.

### List Traces

```bash
curl "http://localhost:6920/api/v1/traces?agent_name=code-review-agent&limit=10&sort_by=cost_usd&sort_order=desc" \
  -H "Authorization: Bearer my-secret-key"
```

Response:

```json
{
  "traces": [
    {
      "trace_id": "trc_...",
      "agent_name": "code-review-agent",
      "framework": "langchain",
      "input": "Review this pull request",
      "output": "Found 2 vulnerabilities...",
      "latency_ms": 3200,
      "token_usage": {"prompt_tokens": 1500, "completion_tokens": 800, "total_tokens": 2300},
      "cost_usd": 0.0345,
      "timestamp": "2026-03-16T10:00:00.000Z",
      "created_at": "2026-03-16T10:00:03.200Z"
    }
  ],
  "total": 142,
  "limit": 10,
  "offset": 0
}
```

Query parameters: `agent_name`, `framework`, `since`, `until`, `limit` (1-1000, default 50), `offset` (default 0), `sort_by` (`timestamp`|`latency_ms`|`cost_usd`), `sort_order` (`asc`|`desc`).

### Get Single Trace

```bash
curl "http://localhost:6920/api/v1/traces/trc_1a2b3c4d5e6f" \
  -H "Authorization: Bearer my-secret-key"
```

Response includes the trace, its spans, and linked evaluations:

```json
{
  "trace": {"trace_id": "trc_1a2b3c4d5e6f", "agent_name": "code-review-agent", "...": "..."},
  "spans": [{"span_id": "spn_a1b2c3d4", "name": "llm_call", "kind": "LLM", "...": "..."}],
  "evals": [{"id": "eval_7g8h9i0j1k2l", "score": 0.925, "passed": true, "...": "..."}]
}
```

### List Evaluations

```bash
curl "http://localhost:6920/api/v1/evaluations?eval_type=safety&passed=true&limit=20" \
  -H "Authorization: Bearer my-secret-key"
```

### Dashboard Summary

```bash
curl "http://localhost:6920/api/v1/summary?hours=24" \
  -H "Authorization: Bearer my-secret-key"
```

Response:

```json
{
  "total_traces": 142,
  "avg_latency_ms": 2850.5,
  "total_cost_usd": 4.23,
  "error_rate": 0.03,
  "eval_pass_rate": 0.91,
  "traces_per_hour": [{"hour": "2026-03-16T09:00:00Z", "count": 12}],
  "top_agents": [{"agent_name": "code-review-agent", "count": 87}]
}
```

### Filter Values

```bash
curl "http://localhost:6920/api/v1/filters" \
  -H "Authorization: Bearer my-secret-key"
```

Response:

```json
{
  "agent_names": ["code-review-agent", "qa-agent"],
  "frameworks": ["langchain", "crewai"]
}
```

---

## Using `fetch` (JavaScript/TypeScript)

```typescript
const IRIS_MCP = "http://localhost:3000";
const API_KEY = "my-secret-key";

// Log a trace via MCP
const res = await fetch(`${IRIS_MCP}/mcp`, {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${API_KEY}`,
  },
  body: JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "log_trace",
      arguments: {
        agent_name: "my-agent",
        output: "Hello world",
        latency_ms: 500,
      },
    },
  }),
});

const data = await res.json();
console.log(data);
```

## Using Python `requests`

```python
import requests

IRIS_MCP = "http://localhost:3000"
API_KEY = "my-secret-key"

# Log a trace via MCP
res = requests.post(
    f"{IRIS_MCP}/mcp",
    headers={"Authorization": f"Bearer {API_KEY}"},
    json={
        "jsonrpc": "2.0",
        "id": 1,
        "method": "tools/call",
        "params": {
            "name": "log_trace",
            "arguments": {
                "agent_name": "my-agent",
                "output": "Hello world",
                "latency_ms": 500,
            },
        },
    },
)

print(res.json())
```

---

## CORS Configuration for Frontend Apps

By default, Iris allows origins matching `http://localhost:*`. To allow your frontend app's origin, set the `IRIS_ALLOWED_ORIGINS` environment variable or configure `security.allowedOrigins` in `~/.iris/config.json`.

### Environment Variable

```bash
export IRIS_ALLOWED_ORIGINS="http://localhost:5173,https://myapp.example.com,https://*.example.com"
```

Patterns support wildcards (`*`), so `https://*.example.com` matches any subdomain.

### Config File (`~/.iris/config.json`)

```json
{
  "security": {
    "allowedOrigins": [
      "http://localhost:5173",
      "https://myapp.example.com",
      "https://*.example.com"
    ]
  }
}
```

### What CORS Headers Are Set

When a request's `Origin` header matches an allowed origin, Iris responds with:

```
Access-Control-Allow-Origin: <matched origin>
Access-Control-Allow-Methods: GET, POST, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
Vary: Origin
```

Preflight `OPTIONS` requests return `204 No Content` immediately.

---

## Rate Limiting

Both servers enforce rate limits per client IP:

| Server | Default Limit | Window |
|--------|--------------|--------|
| MCP (`POST /mcp`, `DELETE /mcp`) | 20 requests | 60 seconds |
| Dashboard API (`/api/v1/*`) | 100 requests | 60 seconds |

Rate limit headers follow the [draft-7 standard](https://datatracker.ietf.org/doc/draft-ietf-httpapi-ratelimit-headers/). When exceeded, the server returns `429 Too Many Requests`.

---

## Example Files

- [`client.ts`](client.ts) -- TypeScript example: start the server, log traces, evaluate, query via dashboard API
- [`client.py`](client.py) -- Python example: same workflow using `requests`
