"""One OpenAI Agents SDK run traced by OpenInference — the recipe in
docs/otel-recipes.md, run for real.

    python examples/otel-recipes/openai_agents_run.py "What is the weather in Paris?"

The exporter reads the standard variables (``OTEL_EXPORTER_OTLP_ENDPOINT``,
``OTEL_EXPORTER_OTLP_HEADERS``, ``OTEL_SERVICE_NAME``). In CI the model is
the scripted provider in tests/fixtures/scripted-provider, reached through
``OPENAI_BASE_URL``, so the run needs no key and gives the same answer every
time; with it unset, the model is OpenAI's, with your ``OPENAI_API_KEY``. ``tests/otel-recipes/test_recipes_e2e.py`` points the exporter at an Iris server, and
``tests/fixtures/otlp/capture_recipe.py`` at a capturing server to record the
fixture. No trace is sent to OpenAI: the instrumentor replaces the SDK's own
trace processor, which is what would upload to the OpenAI dashboard.
"""

from __future__ import annotations

import sys

# --- the recipe: docs/otel-recipes.md, "OpenAI Agents SDK (Python)" -------------
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from openinference.instrumentation.openai_agents import OpenAIAgentsInstrumentor

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))   # reads OTEL_EXPORTER_OTLP_*
OpenAIAgentsInstrumentor().instrument(tracer_provider=provider)
# --- end of the recipe ---------------------------------------------------------

from agents import Agent, Runner, function_tool  # noqa: E402
from openinference.instrumentation import using_session  # noqa: E402


@function_tool
def get_weather(city: str) -> str:
    """The current weather for a city."""
    return f"18 degrees and sunny in {city}"


agent = Agent(
    name="Weather agent",
    instructions="Answer questions about the weather. Use get_weather for current conditions.",
    model="gpt-4o-mini",
    tools=[get_weather],
)


def main() -> None:
    question = sys.argv[1] if len(sys.argv) > 1 else "What is the weather in Paris?"
    with using_session("session-paris-1"):
        result = Runner.run_sync(agent, question)
    print(result.final_output)
    provider.force_flush()


if __name__ == "__main__":
    main()
