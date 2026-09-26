"""Record langsmith-langgraph.pb: what LangSmith's OpenTelemetry export really posts for a LangGraph run.

    python tests/fixtures/otlp/capture_langsmith.py

Needs the Python client's test extras (``pip install -e "packages/python[test]"``).
Runs ``packages/python/tests/langsmith_otel_run.py`` — the scripted LangGraph
tool loop — with the variables docs/otel-recipes.md gives, pointed at a
capturing HTTP server in this process, and writes the one request body it
receives as ``langsmith-langgraph.pb``, and the same message through
protobuf's own JSON mapping (ids hex-encoded, as OTLP/JSON requires) as
``langsmith-langgraph.otlp.json``. The run happens in a scratch directory so
nothing about this checkout (LangSmith records a git revision when it finds
one) ends up in the fixture.
"""

from __future__ import annotations

import base64
import http.server
import json
import os
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

HERE = Path(__file__).resolve().parent
RUN = HERE.parents[2] / "packages" / "python" / "tests" / "langsmith_otel_run.py"


def main() -> None:
    bodies: list[bytes] = []

    class Capture(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - the stdlib's name
            bodies.append(self.rfile.read(int(self.headers["content-length"])))
            self.send_response(200)
            self.send_header("content-type", "application/x-protobuf")
            self.end_headers()

        def log_message(self, *args: object) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Capture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("LANGSMITH_", "LANGCHAIN_", "OTEL_"))}
    env.update(
        {
            "LANGSMITH_TRACING": "true",
            "LANGSMITH_OTEL_ENABLED": "true",
            "LANGSMITH_OTEL_ONLY": "true",
            "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://127.0.0.1:{server.server_address[1]}/v1/traces",
            "OTEL_SERVICE_NAME": "weather-graph",
        }
    )
    with tempfile.TemporaryDirectory() as scratch:
        subprocess.run([sys.executable, str(RUN)], env=env, cwd=scratch, check=True)
    server.shutdown()
    if len(bodies) != 1:
        raise SystemExit(f"expected one export request, got {len(bodies)}")

    (HERE / "langsmith-langgraph.pb").write_bytes(bodies[0])
    request = ExportTraceServiceRequest()
    request.ParseFromString(bodies[0])
    as_json = MessageToDict(request, use_integers_for_enums=True)
    for resource_spans in as_json.get("resourceSpans", []):
        for scope_spans in resource_spans.get("scopeSpans", []):
            for span in scope_spans.get("spans", []):
                for key in ("traceId", "spanId", "parentSpanId"):
                    if key in span:
                        span[key] = base64.b64decode(span[key]).hex()
    (HERE / "langsmith-langgraph.otlp.json").write_text(json.dumps(as_json, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {len(bodies[0])} bytes")


if __name__ == "__main__":
    main()
