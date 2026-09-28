"""The OpenAI Agents SDK (Python and JavaScript) and LlamaIndex recipes in
docs/otel-recipes.md, run for real: each framework, instrumented by its
OpenInference package exactly as the recipe says, runs a tool-calling agent
against the scripted model provider and exports to a real Iris server built
from this checkout. The trace is read back with its words, its tool call, its
token usage, its session and a verdict — and a leak through the same route is
failed.

Each recipe needs its own environment (the two Python frameworks pin
incompatible ``openai`` majors):

    pip install -r examples/otel-recipes/requirements-openai-agents.txt   # or -llamaindex
    (cd examples/otel-recipes/js && npm ci)                               # the JavaScript recipe
    IRIS_RECIPE=openai-agents python -m pytest tests/otel-recipes -q

``IRIS_RECIPE`` names the recipe this environment is for and makes its
missing packages a failure rather than a skip; CI runs one job per recipe.
Without it, every recipe whose packages are present runs.
"""

from __future__ import annotations

import importlib.util
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest

REPO = Path(__file__).resolve().parents[2]
RECIPE_DIR = REPO / "examples" / "otel-recipes"
sys.path.insert(0, str(REPO / "packages" / "python" / "tests"))

from live import Iris, Provider, start_iris, start_provider  # noqa: E402

QUESTION = "What is the weather in Paris?"
ANSWER = "It is 18 degrees and sunny in Paris."


@dataclass(frozen=True)
class Recipe:
    name: str
    command: list[str]
    needs: str  # a module (Python) or a directory (JavaScript) the recipe cannot run without


RECIPES = [
    Recipe("openai-agents", [sys.executable, str(RECIPE_DIR / "openai_agents_run.py")], "openinference.instrumentation.openai_agents"),
    Recipe("llamaindex", [sys.executable, str(RECIPE_DIR / "llamaindex_run.py")], "openinference.instrumentation.llama_index"),
    Recipe("openai-agents-js", ["node", str(RECIPE_DIR / "js" / "openai-agents-run.mjs")], str(RECIPE_DIR / "js" / "node_modules" / "@openai" / "agents")),
]


def installed(recipe: Recipe) -> bool:
    if recipe.name.endswith("-js"):
        return shutil.which("node") is not None and Path(recipe.needs).is_dir()
    try:
        return importlib.util.find_spec(recipe.needs) is not None
    except ModuleNotFoundError:
        return False


def require(recipe: Recipe) -> None:
    chosen = os.environ.get("IRIS_RECIPE")
    if chosen is not None and chosen != recipe.name:
        pytest.skip(f"this environment is for the {chosen} recipe")
    if not installed(recipe):
        message = f"the {recipe.name} recipe's packages are not installed"
        if chosen == recipe.name:
            pytest.fail(message)
        pytest.skip(message)


@pytest.fixture(scope="module")
def iris() -> Iterator[Iris]:
    # The recipes' scoring line: an OTLP feed is scored when the server says so.
    yield from start_iris({"otel": {"evaluateOnIngest": True}})


@pytest.fixture(scope="module")
def provider() -> Iterator[Provider]:
    yield from start_provider()


def run(recipe: Recipe, iris: Iris, provider: Provider, question: str) -> str:
    env = {k: v for k, v in os.environ.items() if not k.startswith(("OTEL_", "OPENAI_", "IRIS_"))}
    env.update(
        {
            # The lines every recipe shares, with this server's host and key.
            "OTEL_EXPORTER_OTLP_ENDPOINT": iris.url,
            "OTEL_EXPORTER_OTLP_HEADERS": f"Authorization=Bearer%20{iris.api_key}",
            # The Python recipes name the agent here; the JavaScript one names it in code.
            "OTEL_SERVICE_NAME": "weather-agent",
            # The run leaves in one export request, as the flush at its end sends it. The batch processor
            # also exports every 5 s, and the door stores each request's spans as their own trace, so a
            # run that straddled that tick would arrive as two traces and this test would read half of one.
            "OTEL_BSP_SCHEDULE_DELAY": "60000",
            "OPENAI_BASE_URL": f"{provider.url}/v1",
            "OPENAI_API_BASE": f"{provider.url}/v1",
            "OPENAI_API_KEY": "scripted",
        }
    )
    done = subprocess.run([*recipe.command, question], env=env, capture_output=True, text=True, timeout=180)
    assert done.returncode == 0, done.stderr
    # Both exporters log a failed export and carry on; a run that exported nothing is a failure here.
    for marker in ("Failed to export", "Export failed", "OTLPExporterError"):
        assert marker not in done.stderr, done.stderr
    return done.stdout.strip()


def stored(iris: Iris, question: str) -> dict[str, Any]:
    page = httpx.get(
        f"{iris.url}/api/v1/traces",
        params={"agent_name": "weather-agent", "limit": 50},
        headers={"authorization": f"Bearer {iris.api_key}"},
        timeout=10,
    ).json()
    return [t for t in page["traces"] if t.get("input") == question]


@pytest.mark.parametrize("recipe", RECIPES, ids=[r.name for r in RECIPES])
def test_a_tool_calling_run_arrives_with_its_words_tool_call_usage_session_and_verdict(recipe: Recipe, iris: Iris, provider: Provider) -> None:
    require(recipe)
    before = len(stored(iris, QUESTION))
    assert run(recipe, iris, provider, QUESTION) == ANSWER
    matching = stored(iris, QUESTION)
    assert len(matching) == before + 1, [t.get("input") for t in matching]
    got = iris.trace(matching[0]["trace_id"])
    trace, spans, evals = got["trace"], got["spans"], got["evals"]
    assert trace["source"] == "otel"
    assert trace["agent_name"] == "weather-agent"
    assert trace["input"] == QUESTION
    assert trace["output"] == ANSWER
    # Two model calls: 15 in and 12 out for the tool request, 35 in and 8 out for the answer.
    assert trace["token_usage"] == {"prompt_tokens": 50, "completion_tokens": 20, "total_tokens": 70}
    assert trace["session_id"] == "session-paris-1"
    assert trace["metadata"]["model"] == "gpt-4o-mini"
    assert [t["name"] for t in trace["tools"]] == ["get_weather"]
    tools = [s for s in spans if s["kind"] == "TOOL"]
    assert [s["attributes"]["tool.name"] for s in tools] == ["get_weather"]
    assert len(evals) == 1
    assert evals[0]["passed"] is True, [r for r in evals[0]["rule_results"] if not r["passed"]]


@pytest.mark.parametrize("recipe", RECIPES, ids=[r.name for r in RECIPES])
def test_a_leak_through_the_recipe_is_failed(recipe: Recipe, iris: Iris, provider: Provider) -> None:
    require(recipe)
    question = f"What is her SSN? ({recipe.name})"
    assert run(recipe, iris, provider, question) == "Her SSN is 123-45-6789."
    (only,) = stored(iris, question)
    got = iris.trace(only["trace_id"])
    assert got["trace"]["output"] == "Her SSN is 123-45-6789."
    (evaluation,) = got["evals"]
    assert evaluation["passed"] is False
    assert any(r["ruleName"] == "no_pii" and not r["passed"] for r in evaluation["rule_results"])
