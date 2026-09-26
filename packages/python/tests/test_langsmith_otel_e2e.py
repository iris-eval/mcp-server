"""The OpenTelemetry route for LangGraph, with real traces: LangSmith's own
OTel export (``LANGSMITH_OTEL_ENABLED``, ``LANGSMITH_OTEL_ONLY``) of a real
LangGraph run, posted to a real Iris server exactly as docs/otel-recipes.md
tells a user to set it up, and the trace read back with its input, output,
tool call, token usage and verdict.

The variables are read out of the recipe itself — the ``export`` lines of
the "LangGraph via LangSmith's export" section — with only the host and the
key put in, so the documented settings are the settings under test. Two of
them were learned from running this: LangSmith posts to
``OTEL_EXPORTER_OTLP_ENDPOINT`` as written (so the path ``/v1/traces`` goes
in it), and passes ``OTEL_EXPORTER_OTLP_HEADERS`` through without
percent-decoding (so the space after ``Bearer`` is a space).
"""

from __future__ import annotations

import os
import re
import shlex
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
RECIPES = Path(__file__).resolve().parents[3] / "docs" / "otel-recipes.md"


def recipe_settings() -> dict[str, str]:
    """The ``export NAME=value`` lines of the LangGraph recipe, as documented."""
    text = RECIPES.read_text(encoding="utf-8")
    section = text.split("### LangGraph via LangSmith's export", 1)[1].split("\n### ", 1)[0]
    block = re.search(r"```bash\n(.*?)```", section, re.S)
    assert block, "the LangGraph recipe has no bash block"
    settings: dict[str, str] = {}
    for line in block.group(1).splitlines():
        if line.startswith("export "):
            name, _, value = shlex.split(line[len("export "):], comments=True)[0].partition("=")
            settings[name] = value
    return settings


def test_the_recipe_documents_the_settings_that_work() -> None:
    settings = recipe_settings()
    assert settings["OTEL_EXPORTER_OTLP_ENDPOINT"] == "http://127.0.0.1:6920/v1/traces"
    assert settings["OTEL_EXPORTER_OTLP_HEADERS"] == "Authorization=Bearer <key>"
    assert {"LANGSMITH_TRACING", "LANGSMITH_OTEL_ENABLED", "LANGSMITH_OTEL_ONLY", "OTEL_SERVICE_NAME"} <= set(settings)


@pytest.fixture(scope="module")
def iris() -> Iterator[Iris]:
    # The recipe's scoring line: an OTLP feed is scored when the server says so.
    yield from start_iris({"otel": {"evaluateOnIngest": True}})


def run_graph(iris: Iris, question: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("LANGSMITH_", "LANGCHAIN_", "OTEL_"))}
    # The recipe's lines, with this server's host and key put in, and the agent this test reads back.
    for name, value in recipe_settings().items():
        env[name] = value.replace("http://127.0.0.1:6920", iris.url).replace("<key>", iris.api_key)
    env["OTEL_SERVICE_NAME"] = "weather-graph"
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
