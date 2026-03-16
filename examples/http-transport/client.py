"""
Iris HTTP Transport — Python Client Example

Demonstrates the full workflow:
  1. Start Iris in HTTP mode (or connect to a running instance)
  2. Log a trace via MCP over HTTP (JSON-RPC)
  3. Evaluate the output via MCP over HTTP
  4. Query traces and summary via the Dashboard REST API

Prerequisites:
  pip install requests
  npm install -g @iris-eval/mcp-server  (or use npx)

Usage:
  # Option A: Let this script start Iris automatically
  python examples/http-transport/client.py

  # Option B: Start Iris yourself, then run the client
  npx @iris-eval/mcp-server --transport http --port 3000 --api-key test-key --dashboard
  IRIS_ALREADY_RUNNING=1 python examples/http-transport/client.py
"""

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

import requests

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------

MCP_PORT = 3000
DASHBOARD_PORT = 6920
API_KEY = "example-api-key"

MCP_URL = f"http://localhost:{MCP_PORT}"
DASHBOARD_URL = f"http://localhost:{DASHBOARD_PORT}"
AUTH_HEADERS = {"Authorization": f"Bearer {API_KEY}"}

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def mcp_tool_call(tool_name: str, arguments: dict, request_id: int = 1) -> dict:
    """Make a JSON-RPC 2.0 tool call to the Iris MCP HTTP endpoint."""
    payload = {
        "jsonrpc": "2.0",
        "id": request_id,
        "method": "tools/call",
        "params": {
            "name": tool_name,
            "arguments": arguments,
        },
    }
    resp = requests.post(
        f"{MCP_URL}/mcp",
        headers={"Content-Type": "application/json", **AUTH_HEADERS},
        json=payload,
    )
    resp.raise_for_status()
    data = resp.json()

    if "error" in data:
        raise RuntimeError(f"MCP error: {data['error']['message']}")

    # MCP tool results come wrapped in content[].text
    content = data.get("result", {}).get("content", [])
    if content and "text" in content[0]:
        return json.loads(content[0]["text"])
    return data.get("result", {})


def dashboard_get(path: str, params: dict | None = None) -> dict:
    """Make a GET request to the Iris Dashboard REST API."""
    resp = requests.get(
        f"{DASHBOARD_URL}/api/v1{path}",
        headers=AUTH_HEADERS,
        params=params,
    )
    resp.raise_for_status()
    return resp.json()


def wait_for_server(url: str, max_attempts: int = 30) -> None:
    """Wait for a URL to respond with 200."""
    for _ in range(max_attempts):
        try:
            resp = requests.get(url, timeout=2)
            if resp.status_code == 200:
                return
        except requests.ConnectionError:
            pass
        time.sleep(0.5)
    raise TimeoutError(f"Server at {url} did not become ready")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    server_process = None

    # Start Iris if not already running
    if not os.environ.get("IRIS_ALREADY_RUNNING"):
        print("Starting Iris in HTTP mode...")
        server_process = subprocess.Popen(
            [
                "npx", "@iris-eval/mcp-server",
                "--transport", "http",
                "--port", str(MCP_PORT),
                "--api-key", API_KEY,
                "--dashboard",
                "--dashboard-port", str(DASHBOARD_PORT),
            ],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )

        print("Waiting for servers to start...")
        wait_for_server(f"{MCP_URL}/health")
        wait_for_server(f"{DASHBOARD_URL}/api/v1/health")
        print("Servers ready.\n")

    try:
        # -------------------------------------------------------------------
        # Step 1: Log a trace
        # -------------------------------------------------------------------
        print("--- Step 1: Log a trace ---")
        now = datetime.now(timezone.utc)
        log_result = mcp_tool_call("log_trace", {
            "agent_name": "code-review-agent",
            "framework": "langchain",
            "input": "Review this pull request for security issues",
            "output": (
                "Found 2 potential SQL injection vulnerabilities in auth.ts "
                "on lines 42 and 87. The user input is concatenated directly "
                "into the query string without parameterization."
            ),
            "tool_calls": [
                {
                    "tool_name": "read_file",
                    "input": {"path": "src/auth.ts"},
                    "latency_ms": 45,
                },
                {
                    "tool_name": "search_code",
                    "input": {"query": "SQL injection"},
                    "output": {"matches": 2},
                    "latency_ms": 120,
                },
            ],
            "latency_ms": 3200,
            "token_usage": {
                "prompt_tokens": 1500,
                "completion_tokens": 800,
                "total_tokens": 2300,
            },
            "cost_usd": 0.0345,
            "metadata": {"pr_number": 42, "repo": "acme/backend"},
            "spans": [
                {
                    "name": "llm_call",
                    "kind": "LLM",
                    "status_code": "OK",
                    "start_time": (now.replace(microsecond=0)).isoformat() + "Z",
                    "end_time": now.isoformat() + "Z",
                    "attributes": {"model": "gpt-4o"},
                },
            ],
        })

        trace_id = log_result["trace_id"]
        print(f"Logged trace: {trace_id} (status: {log_result['status']})\n")

        # -------------------------------------------------------------------
        # Step 2: Evaluate the output (completeness)
        # -------------------------------------------------------------------
        print("--- Step 2: Evaluate output (completeness) ---")
        eval_result = mcp_tool_call("evaluate_output", {
            "output": (
                "Found 2 potential SQL injection vulnerabilities in auth.ts "
                "on lines 42 and 87. The user input is concatenated directly "
                "into the query string without parameterization."
            ),
            "eval_type": "completeness",
            "expected": "SQL injection found in auth.ts at the query concatenation on line 42",
            "input": "Review the code for security issues",
            "trace_id": trace_id,
        }, request_id=2)

        print(f"Evaluation: id={eval_result['id']}, score={eval_result['score']}, passed={eval_result['passed']}")
        for rule in eval_result["rule_results"]:
            print(f"  {rule['ruleName']}: {rule['score']}")
        print()

        # -------------------------------------------------------------------
        # Step 3: Evaluate with custom rules
        # -------------------------------------------------------------------
        print("--- Step 3: Evaluate with custom rules ---")
        custom_eval = mcp_tool_call("evaluate_output", {
            "output": "Found 2 potential SQL injection vulnerabilities in auth.ts on lines 42 and 87.",
            "eval_type": "custom",
            "custom_rules": [
                {
                    "name": "min_response_length",
                    "type": "min_length",
                    "config": {"length": 50},
                    "weight": 1,
                },
                {
                    "name": "mentions_file",
                    "type": "contains_keywords",
                    "config": {"keywords": ["auth.ts", "SQL injection"]},
                    "weight": 2,
                },
                {
                    "name": "no_apology",
                    "type": "regex_no_match",
                    "config": {"pattern": "I apologize|I'm sorry", "flags": "i"},
                    "weight": 1,
                },
            ],
        }, request_id=3)

        print(f"Custom eval: score={custom_eval['score']}, passed={custom_eval['passed']}")
        for rule in custom_eval["rule_results"]:
            print(f"  {rule['ruleName']}: {rule['score']} -- {rule['message']}")
        print()

        # -------------------------------------------------------------------
        # Step 4: Query traces via MCP
        # -------------------------------------------------------------------
        print("--- Step 4: Query traces via MCP tool ---")
        query_result = mcp_tool_call("get_traces", {
            "agent_name": "code-review-agent",
            "limit": 5,
            "sort_by": "timestamp",
            "sort_order": "desc",
        }, request_id=4)

        print(f"Found {query_result['total']} trace(s)")
        for t in query_result["traces"]:
            print(f"  {t['trace_id']} | {t['agent_name']} | ${t.get('cost_usd', 'N/A')}")
        print()

        # -------------------------------------------------------------------
        # Step 5: Query the Dashboard REST API
        # -------------------------------------------------------------------
        print("--- Step 5: Query Dashboard REST API ---")

        # 5a. List traces
        traces = dashboard_get("/traces", {
            "agent_name": "code-review-agent",
            "limit": "5",
            "sort_by": "cost_usd",
            "sort_order": "desc",
        })
        print(f"Dashboard traces: {traces['total']} total, showing {len(traces['traces'])}")

        # 5b. Get single trace detail
        detail = dashboard_get(f"/traces/{trace_id}")
        print(
            f"Trace detail: {detail['trace']['trace_id']}, "
            f"{len(detail['spans'])} span(s), "
            f"{len(detail['evals'])} eval(s)"
        )

        # 5c. Summary metrics
        summary = dashboard_get("/summary", {"hours": "24"})
        print(
            f"Summary: {summary['total_traces']} traces, "
            f"avg latency {summary['avg_latency_ms']}ms, "
            f"${summary['total_cost_usd']} total cost, "
            f"{summary['eval_pass_rate'] * 100:.1f}% pass rate"
        )

        # 5d. Evaluations
        evals = dashboard_get("/evaluations", {"limit": "5"})
        print(f"Evaluations: {evals['total']} total")

        # 5e. Filter values
        filters = dashboard_get("/filters")
        print(
            f"Filters: agents={', '.join(filters['agent_names'])}, "
            f"frameworks={', '.join(filters['frameworks'])}"
        )

        print("\nDone!")

    finally:
        if server_process:
            server_process.terminate()
            server_process.wait(timeout=10)


if __name__ == "__main__":
    main()
