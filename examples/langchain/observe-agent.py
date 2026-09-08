"""
Iris + LangChain — log a run and get its verdict in one request.

Iris never intercepts your agent. A framework that is not an MCP client
sends each run to the dashboard's HTTP ingest and asks for the evaluation
on write. This example sends a real request; nothing here is a stub.

Prerequisites:
  pip install langchain langchain-anthropic
  Start Iris with its dashboard (the ingest API lives on the dashboard port):
    npx @iris-eval/mcp-server --dashboard
  If you started it with --api-key, set IRIS_API_KEY in this shell.
"""

import json
import os
import time
import urllib.error
import urllib.request

# The dashboard port. The MCP transport (port 3000, path /mcp) is for MCP
# clients; HTTP ingest is POST /api/v1/traces on the dashboard.
IRIS_INGEST_URL = os.environ.get("IRIS_INGEST_URL", "http://127.0.0.1:6920/api/v1/traces")
IRIS_API_KEY = os.environ.get("IRIS_API_KEY")


def log_and_evaluate(agent_name, input_text, output_text, latency_ms, token_usage=None, tool_calls=None, cost_usd=None):
    """POST one trace to Iris and evaluate it in the same request."""
    trace = {
        "agent_name": agent_name,
        "framework": "langchain",
        "input": input_text,
        "output": output_text,
        "latency_ms": latency_ms,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
        # evaluate on write: the response carries the verdict, not only an id
        "evaluate": True,
    }
    if token_usage:
        trace["token_usage"] = token_usage
    if tool_calls:
        trace["tool_calls"] = tool_calls
    if cost_usd is not None:
        trace["cost_usd"] = cost_usd

    req = urllib.request.Request(IRIS_INGEST_URL, data=json.dumps(trace).encode("utf-8"), method="POST")
    req.add_header("content-type", "application/json")
    if IRIS_API_KEY:
        req.add_header("authorization", f"Bearer {IRIS_API_KEY}")
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            return json.loads(res.read().decode("utf-8"))
    except urllib.error.URLError as err:
        raise SystemExit(f"Iris is not reachable at {IRIS_INGEST_URL}: {err}. Start it with: npx @iris-eval/mcp-server --dashboard")


def main():
    input_text = "What is the weather in San Francisco?"
    start = time.time()

    # --- Your LangChain agent code goes here ---
    # from langchain_anthropic import ChatAnthropic
    # from langchain.agents import create_tool_calling_agent, AgentExecutor
    # result = agent_executor.invoke({"input": input_text})
    # output_text = result["output"]
    # ---
    output_text = "The weather in San Francisco is currently 65°F and partly cloudy."
    latency_ms = int((time.time() - start) * 1000) + 1500  # simulated

    result = log_and_evaluate(
        agent_name="weather-agent",
        input_text=input_text,
        output_text=output_text,
        latency_ms=latency_ms,
        token_usage={"prompt_tokens": 45, "completion_tokens": 20, "total_tokens": 65},
        tool_calls=[{"tool_name": "weather_api", "input": {"location": "San Francisco"}, "output": "65F, partly cloudy"}],
    )

    print(f"trace_id: {result.get('trace_id')}")
    ev = result.get("evaluation")
    if ev:
        verdict = ev.get("verdict", {})
        print(f"passed: {ev.get('passed')}  basis: {verdict.get('basis')}  by: {verdict.get('by')}")
        for q in (ev.get("coverage") or {}).get("questions", []):
            if q.get("status") == "unjudged":
                print(f"  not judged: {q.get('id')} — {q.get('why')}")
    else:
        print("stored, not evaluated (the server was started without an eval engine)")


if __name__ == "__main__":
    main()
