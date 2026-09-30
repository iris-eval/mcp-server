"""One LlamaIndex agent run traced by OpenInference — the recipe in
docs/otel-recipes.md, run for real.

    python examples/otel-recipes/llamaindex_run.py "What is the weather in Paris?"

The exporter reads the standard variables (``OTEL_EXPORTER_OTLP_ENDPOINT``,
``OTEL_EXPORTER_OTLP_HEADERS``, ``OTEL_SERVICE_NAME``). In CI the model is
the scripted provider in tests/fixtures/scripted-provider, reached through
``OPENAI_API_BASE``, so the run needs no key and gives the same answer every
time; with it unset, the model is OpenAI's, with your ``OPENAI_API_KEY``. ``tests/otel-recipes/test_recipes_e2e.py`` points the exporter at an Iris server, and
``tests/fixtures/otlp/capture_recipe.py`` at a capturing server to record the
fixture.
"""

from __future__ import annotations

import asyncio
import sys

# --- the recipe: docs/otel-recipes.md, "LlamaIndex" ------------------------------
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from openinference.instrumentation.llama_index import LlamaIndexInstrumentor

provider = TracerProvider()
provider.add_span_processor(BatchSpanProcessor(OTLPSpanExporter()))   # reads OTEL_EXPORTER_OTLP_*
LlamaIndexInstrumentor().instrument(tracer_provider=provider)
# --- end of the recipe ---------------------------------------------------------

from llama_index.core.agent.workflow import FunctionAgent  # noqa: E402
from llama_index.llms.openai import OpenAI  # noqa: E402
from openinference.instrumentation import using_session  # noqa: E402


def get_weather(city: str) -> str:
    """The current weather for a city."""
    return f"18 degrees and sunny in {city}"


agent = FunctionAgent(
    name="weather_agent",
    description="Answers questions about the weather.",
    system_prompt="Answer questions about the weather. Use get_weather for current conditions.",
    # FunctionAgent streams; OpenAI sends a streamed call's usage only when asked.
    llm=OpenAI(model="gpt-4o-mini", additional_kwargs={"stream_options": {"include_usage": True}}),
    tools=[get_weather],
)


async def run(question: str) -> str:
    with using_session("session-paris-1"):
        response = await agent.run(user_msg=question)
    return str(response)


def main() -> None:
    question = sys.argv[1] if len(sys.argv) > 1 else "What is the weather in Paris?"
    print(asyncio.run(run(question)))
    provider.force_flush()


if __name__ == "__main__":
    main()
