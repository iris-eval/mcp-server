"""The OpenTelemetry route for LangGraph, with real traces: LangSmith's own
OTel export (``LANGSMITH_OTEL_ENABLED``, ``LANGSMITH_OTEL_ONLY``) of a real
LangGraph run, posted to a real Iris server exactly as docs/otel-recipes.md
tells a user to set it up, and the trace read back with its input, output,
tool call, token usage and verdict.

The variables are the recipe's, character for character — including the two
it had to learn from running this: LangSmith posts to
``OTEL_EXPORTER_OTLP_ENDPOINT`` as written (so the path ``/v1/traces`` goes
in it), and passes ``OTEL_EXPORTER_OTLP_HEADERS`` through without
percent-decoding (so the space after ``Bearer`` is a space).
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from typing import Iterator

import httpx
import pytest

from live import Iris, start_iris

pytest.importorskip("langgraph")
pytest.importorskip("langsmith")
pytest.importorskip("opentelemetry.exporter.otlp.proto.http")

RUN = Path(__file__).resolve().parent / "langsmith_otel_run.py"


@pytest.fixture(scope="module")
def iris() -> Iterator[Iris]:
    # The recipe's scoring line: an OTLP feed is scored when the server says so.
    yield from start_iris({"otel": {"evaluateOnIngest": True}})


def run_graph(iris: Iris, question: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("LANGSMITH_", "LANGCHAIN_", "OTEL_"))}
    env.update(
        {
            "LANGSMITH_TRACING": "true",
            "LANGSMITH_OTEL_ENABLED": "true",
            "LANGSMITH_OTEL_ONLY": "true",
            "OTEL_EXPORTER_OTLP_ENDPOINT": f"{iris.url}/v1/traces",
            "OTEL_EXPORTER_OTLP_HEADERS": f"Authorization=Bearer {iris.api_key}",
            "OTEL_SERVICE_NAME": "weather-graph",
        }
    )
    done = subprocess.run([sys.executable, str(RUN), question], env=env, capture_output=True, text=True, timeout=120)
    assert done.returncode == 0, done.stderr
    assert "Failed to export" not in done.stderr, done.stderr
    return done.stdout.strip()


def latest(iris: Iris, question: str) -> dict:
    page = httpx.get(f"{iris.url}/api/v1/traces", params={"agent_name": "weather-graph", "limit": 20}, headers={"authorization": f"Bearer {iris.api_key}"}, timeout=10).json()
    matching = [t for t in page["traces"] if t.get("input") == question]
    assert len(matching) == 1, [t.get("input") for t in page["traces"]]
    return iris.trace(matching[0]["trace_id"])


def test_a_langgraph_run_exported_by_langsmith_arrives_with_its_words_tool_call_usage_and_verdict(iris: Iris) -> None:
    question = "What is the weather in Paris?"
    assert run_graph(iris, question) == "It is 18 degrees and sunny in Paris."
    got = latest(iris, question)
    trace, spans, evals = got["trace"], got["spans"], got["evals"]
    assert trace["source"] == "otel"
    assert trace["agent_name"] == "weather-graph"
    # LangSmith writes the graph's whole state as JSON bytes; Iris reads it down to what was asked and answered.
    assert trace["input"] == question
    assert trace["output"] == "It is 18 degrees and sunny in Paris."
    assert trace["token_usage"] == {"prompt_tokens": 40, "completion_tokens": 20, "total_tokens": 60}
    tools = [s for s in spans if s["kind"] == "TOOL"]
    assert [s["attributes"]["gen_ai.tool.name"] for s in tools] == ["get_weather"]
    assert len([s for s in spans if s["attributes"].get("langsmith.span.kind") == "llm"]) == 2
    assert len(evals) == 1
    assert evals[0]["passed"] is True


def test_a_leak_through_the_otel_route_is_failed(iris: Iris) -> None:
    question = "What is her SSN?"
    assert run_graph(iris, question) == "Her SSN is 123-45-6789."
    got = latest(iris, question)
    assert got["trace"]["output"] == "Her SSN is 123-45-6789."
    (evaluation,) = got["evals"]
    assert evaluation["passed"] is False
    assert any(r["ruleName"] == "no_pii" and not r["passed"] for r in evaluation["rule_results"])
