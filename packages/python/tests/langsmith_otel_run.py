"""One LangGraph run traced by LangSmith's own OpenTelemetry export — the
recipe in docs/otel-recipes.md, run for real.

Run as a separate process, because LangSmith reads its settings from the
environment once: ``test_langsmith_otel_e2e.py`` sets the recipe's variables
and points the exporter at an Iris server, and
``tests/fixtures/otlp/capture_langsmith.py`` at the repository root points
it at a capturing server to record the fixture. Nothing here talks to
LangSmith's service: ``LANGSMITH_OTEL_ONLY`` sends OpenTelemetry and nothing
else.
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from langchain_core.messages import HumanMessage  # noqa: E402
from langsmith.run_trees import get_cached_client  # noqa: E402
from opentelemetry import trace  # noqa: E402

from langgraph_app import build_graph  # noqa: E402


def main() -> None:
    question = sys.argv[1] if len(sys.argv) > 1 else "What is the weather in Paris?"
    out = build_graph().invoke({"messages": [HumanMessage(question)]})
    print(out["messages"][-1].content)
    # LangSmith batches in the background; flush its client and the tracer provider before the process ends.
    get_cached_client().flush()
    provider = trace.get_tracer_provider()
    force_flush = getattr(provider, "force_flush", None)
    if callable(force_flush):
        force_flush()


if __name__ == "__main__":
    main()
