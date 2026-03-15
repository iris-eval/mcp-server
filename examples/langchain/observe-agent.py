"""
Iris + LangChain Integration Example

Logs LangChain agent executions to Iris for observability.

Prerequisites:
  pip install langchain langchain-anthropic mcp
  Start Iris: npx @iris-eval/mcp-server --transport http --dashboard

Note: This is a conceptual example showing how to instrument
a LangChain agent with Iris trace logging via HTTP API calls.
"""

import json
import time
import urllib.request

IRIS_URL = "http://localhost:3000"
# IRIS_API_KEY = "your-api-key"  # Uncomment if auth is enabled


def log_trace_to_iris(agent_name, input_text, output_text, latency_ms, token_usage=None, tool_calls=None):
    """Log an agent execution trace to Iris via the dashboard API."""
    trace = {
        "agent_name": agent_name,
        "framework": "langchain",
        "input": input_text,
        "output": output_text,
        "latency_ms": latency_ms,
        "timestamp": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()),
    }
    if token_usage:
        trace["token_usage"] = token_usage
    if tool_calls:
        trace["tool_calls"] = tool_calls

    # In production, use the MCP protocol client instead of direct HTTP
    # This example uses a simplified approach for demonstration
    print(f"Logged trace for '{agent_name}': {output_text[:50]}...")
    print(f"  Latency: {latency_ms}ms")
    if token_usage:
        print(f"  Tokens: {token_usage.get('total_tokens', 'N/A')}")


def main():
    """Example: instrument a LangChain agent run."""
    # Simulate a LangChain agent execution
    input_text = "What is the weather in San Francisco?"

    start = time.time()

    # --- Your LangChain agent code goes here ---
    # from langchain_anthropic import ChatAnthropic
    # from langchain.agents import create_tool_calling_agent, AgentExecutor
    # llm = ChatAnthropic(model="claude-sonnet-4-20250514")
    # result = agent_executor.invoke({"input": input_text})
    # output_text = result["output"]
    # ---

    # Simulated output for this example
    output_text = "The weather in San Francisco is currently 65°F and partly cloudy."
    latency_ms = (time.time() - start) * 1000 + 1500  # simulated

    log_trace_to_iris(
        agent_name="weather-agent",
        input_text=input_text,
        output_text=output_text,
        latency_ms=latency_ms,
        token_usage={"prompt_tokens": 45, "completion_tokens": 20, "total_tokens": 65},
        tool_calls=[{"tool_name": "weather_api", "input": {"location": "San Francisco"}}],
    )


if __name__ == "__main__":
    main()
