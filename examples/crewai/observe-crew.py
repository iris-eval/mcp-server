"""
Iris + CrewAI: a crew's run, traced with OpenInference and scored by Iris.

CrewAI's own tracing uploads to CrewAI's platform; the OpenInference
instrumentor is how a crew reaches any OpenTelemetry backend, and Iris reads
what it emits at POST /v1/traces. This is the CrewAI recipe in
docs/otel-recipes.md as a script; the vocabulary it relies on is held by
tests/fixtures/otlp/conventions/crewai-openinference.otlp.json.

Prerequisites:
  pip install crewai openinference-instrumentation-crewai opentelemetry-sdk opentelemetry-exporter-otlp-proto-http
  export OPENAI_API_KEY=...          # or whichever model your crew uses
  Start Iris with scoring on for its OTLP feed:
    echo '{"otel": {"evaluateOnIngest": true}}' > ~/.iris/config.json
    npx -y @iris-eval/mcp-server --dashboard
  (started with --api-key? set IRIS_API_KEY in this shell)

Then:  python observe-crew.py
"""

import os

from crewai import Agent, Crew, Task
from openinference.instrumentation.crewai import CrewAIInstrumentor
from opentelemetry import trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

IRIS = os.environ.get("IRIS_URL", "http://127.0.0.1:6920")
KEY = os.environ.get("IRIS_API_KEY")

provider = TracerProvider(resource=Resource({"service.name": "launch-crew"}))
provider.add_span_processor(
    BatchSpanProcessor(OTLPSpanExporter(endpoint=f"{IRIS}/v1/traces", headers={"Authorization": f"Bearer {KEY}"} if KEY else None))
)
trace.set_tracer_provider(provider)
CrewAIInstrumentor().instrument(tracer_provider=provider)


def main():
    planner = Agent(role="Launch planner", goal="Plan product launches", backstory="You plan launches in three phases.")
    task = Task(description="Plan the Q4 launch of a note-taking app in three sentences.", expected_output="A three-sentence plan.", agent=planner)
    result = Crew(agents=[planner], tasks=[task]).kickoff()
    print(result)
    # Send what is batched before the script ends; then open the dashboard to see the trace and its verdict.
    provider.force_flush()
    print(f"Traced to Iris: {IRIS} (agent launch-crew)")


if __name__ == "__main__":
    main()
