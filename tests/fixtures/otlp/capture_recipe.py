"""Record what a framework recipe really posts: one run of a recipe's script,
exported by the framework's own instrumentation, captured off the wire.

    python tests/fixtures/otlp/capture_recipe.py openai-agents
    python tests/fixtures/otlp/capture_recipe.py llamaindex
    python tests/fixtures/otlp/capture_recipe.py openai-agents-js

Run it with a Python that has the recipe's pinned packages installed
(``pip install -r examples/otel-recipes/requirements-<recipe>.txt``; for the
JavaScript recipe, any Python with ``opentelemetry-proto`` and ``npm ci`` in
examples/otel-recipes/js) and Node on PATH. It starts the scripted model provider (tests/fixtures/scripted-provider)
and a capturing HTTP server in this process, runs
the recipe's script under examples/otel-recipes/ with the standard OTLP variables pointed at the
capture and ``OPENAI_BASE_URL`` pointed at the provider, and writes the one
request body it receives as ``<recipe>.pb`` and the same message through
protobuf's own JSON mapping (ids hex-encoded, as OTLP/JSON requires) as
``<recipe>.otlp.json``. The run happens in a scratch directory with no
framework variables inherited, so nothing about this machine ends up in the
fixture.
"""

from __future__ import annotations

import base64
import gzip
import http.server
import json
import os
import shutil
import subprocess
import sys
import tempfile
import threading
from pathlib import Path

from google.protobuf.json_format import MessageToDict
from opentelemetry.proto.collector.trace.v1.trace_service_pb2 import ExportTraceServiceRequest

HERE = Path(__file__).resolve().parent
REPO = HERE.parents[2]
PROVIDER = REPO / "tests" / "fixtures" / "scripted-provider" / "server.mjs"
RECIPES = {
    "openai-agents": ["{python}", "openai_agents_run.py"],
    "llamaindex": ["{python}", "llamaindex_run.py"],
    # The JavaScript recipe names its service in code, as the recipe shows.
    "openai-agents-js": ["{node}", "js/openai-agents-run.mjs"],
}
QUESTION = "What is the weather in Paris?"


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in RECIPES:
        raise SystemExit(f"usage: capture_recipe.py {{{'|'.join(RECIPES)}}}")
    name = sys.argv[1]
    bodies: list[bytes] = []

    class Capture(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - the stdlib's name
            bodies.append(self.body())
            self.send_response(200)
            self.send_header("content-type", "application/x-protobuf")
            self.end_headers()

        def body(self) -> bytes:
            # The Python exporter sends a content-length; Node's sends the body chunked.
            if self.headers["content-length"] is not None:
                raw = self.rfile.read(int(self.headers["content-length"]))
            else:
                parts = []
                while (size := int(self.rfile.readline().split(b";")[0], 16)) > 0:
                    parts.append(self.rfile.read(size))
                    self.rfile.readline()
                self.rfile.readline()
                raw = b"".join(parts)
            return gzip.decompress(raw) if self.headers["content-encoding"] == "gzip" else raw

        def log_message(self, *args: object) -> None:
            pass

    node = shutil.which("node")
    if node is None:
        raise SystemExit("the scripted provider needs node on PATH")
    provider = subprocess.Popen([node, str(PROVIDER)], stdout=subprocess.PIPE, text=True)
    assert provider.stdout is not None
    port = json.loads(provider.stdout.readline())["port"]
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Capture)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    env = {k: v for k, v in os.environ.items() if not k.startswith(("OTEL_", "OPENAI_", "LLAMA_", "IRIS_"))}
    env.update(
        {
            "OTEL_EXPORTER_OTLP_ENDPOINT": f"http://127.0.0.1:{server.server_address[1]}",
            "OTEL_SERVICE_NAME": "weather-agent",
            # One request per run: the batch processor also exports every 5 s, and a slow start split a run in two.
            "OTEL_BSP_SCHEDULE_DELAY": "60000",
            "OPENAI_BASE_URL": f"http://127.0.0.1:{port}/v1",
            "OPENAI_API_BASE": f"http://127.0.0.1:{port}/v1",
            "OPENAI_API_KEY": "scripted",
        }
    )
    try:
        with tempfile.TemporaryDirectory() as scratch:
            interpreter, script = RECIPES[name]
            command = [interpreter.format(python=sys.executable, node=node), str(REPO / "examples" / "otel-recipes" / script), QUESTION]
            subprocess.run(command, env=env, cwd=scratch, check=True)
    finally:
        server.shutdown()
        provider.terminate()
    if len(bodies) != 1:
        raise SystemExit(f"expected one export request, got {len(bodies)}")

    (HERE / f"{name}.pb").write_bytes(bodies[0])
    request = ExportTraceServiceRequest()
    request.ParseFromString(bodies[0])
    as_json = MessageToDict(request, use_integers_for_enums=True)
    for resource_spans in as_json.get("resourceSpans", []):
        for scope_spans in resource_spans.get("scopeSpans", []):
            for span in scope_spans.get("spans", []):
                for key in ("traceId", "spanId", "parentSpanId"):
                    if key in span:
                        span[key] = base64.b64decode(span[key]).hex()
    (HERE / f"{name}.otlp.json").write_text(json.dumps(as_json, indent=2) + "\n", encoding="utf-8")
    print(f"wrote {name}.pb ({len(bodies[0])} bytes)")


if __name__ == "__main__":
    main()
