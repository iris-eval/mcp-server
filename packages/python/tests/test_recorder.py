"""The recorder's promise to the application: Iris away, slow or refusing is a
normal state. Nothing raises into the caller, the queue is bounded, the loss
is counted and said once, and a process that recorded a call still exits on
time with its own exit code.
"""

from __future__ import annotations

import http.server
import json
import logging
import subprocess
import sys
import textwrap
import threading
import time

import httpx
import pytest

from iris_eval import IrisRecorder, Span, TraceRecord
from iris_eval.recorder import export_request, new_span_id, new_trace_id, now_nanos


def trace(text: str = "hello", agent: str = "unit") -> TraceRecord:
    now = now_nanos()
    return TraceRecord(
        resource={"service.name": agent},
        spans=[Span(new_trace_id(), new_span_id(), "chat m", now, now, {"iris.output": text, "gen_ai.usage.input_tokens": 3, "gen_ai.request.temperature": 0.5, "gen_ai.response.finish_reasons": ["stop"]})],
    )


def test_the_wire_format_is_an_otlp_export_request() -> None:
    body = export_request([trace("a"), trace("b", agent="other"), trace("c")])
    assert len(body["resourceSpans"]) == 2
    first = body["resourceSpans"][0]["scopeSpans"][0]
    assert first["scope"]["name"] == "iris-eval"
    assert len(first["spans"]) == 2
    span = first["spans"][0]
    assert len(span["traceId"]) == 32 and len(span["spanId"]) == 16
    assert span["startTimeUnixNano"].isdigit() and len(span["startTimeUnixNano"]) == 19
    attrs = {kv["key"]: kv["value"] for kv in span["attributes"]}
    assert attrs["gen_ai.usage.input_tokens"] == {"intValue": "3"}
    assert attrs["gen_ai.request.temperature"] == {"doubleValue": 0.5}
    assert attrs["gen_ai.response.finish_reasons"] == {"arrayValue": {"values": [{"stringValue": "stop"}]}}


def test_what_iris_answers_lands_in_results_and_on_result() -> None:
    seen: list[dict] = []
    sent: list[dict] = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        sent.append({"auth": request.headers.get("authorization"), "path": request.url.path, "body": body})
        stored = [{"trace_id": f"t{i}", "otel_trace_id": s["traceId"], "agent_name": "unit", "spans": 1, "steps": 0, "lacked": [], "evaluation": {"verdict": {"state": "pass"}}} for i, s in enumerate(body["resourceSpans"][0]["scopeSpans"][0]["spans"])]
        return httpx.Response(200, json={"iris-eval": {"count": len(stored), "stored": stored}})

    recorder = IrisRecorder("http://iris.test", api_key="k", flush_interval=0.05, on_result=seen.append, transport=httpx.MockTransport(handler))
    recorder.record(trace("one"))
    recorder.record(trace("two"))
    assert recorder.flush(5)
    assert sent[0]["path"] == "/v1/traces" and sent[0]["auth"] == "Bearer k"
    assert len(sent) == 1, "a burst is one request"
    assert [r["trace_id"] for r in recorder.results] == ["t0", "t1"]
    assert [r["trace_id"] for r in seen] == ["t0", "t1"]
    assert recorder.stats == {"recorded": 2, "sent": 2, "dropped": 0}
    recorder.close()


def test_no_server_anywhere_is_one_warning_and_counted_drops(monkeypatch: pytest.MonkeyPatch, tmp_path, caplog: pytest.LogCaptureFixture) -> None:
    monkeypatch.delenv("IRIS_URL", raising=False)
    monkeypatch.setenv("IRIS_HOME", str(tmp_path))
    recorder = IrisRecorder(flush_interval=0)
    with caplog.at_level(logging.WARNING, logger="iris_eval"):
        recorder.record(trace())
        recorder.flush(5)
        recorder.record(trace())
        recorder.flush(5)
    warnings = [r for r in caplog.records if r.name == "iris_eval"]
    assert len(warnings) == 1 and "no server to send to" in warnings[0].getMessage()
    assert recorder.stats["dropped"] == 2
    recorder.close()


def test_the_queue_is_bounded_and_drops_the_oldest() -> None:
    errors: list[Exception] = []
    recorder = IrisRecorder("http://127.0.0.1:9", max_queue=2, flush_interval=60, on_error=errors.append, transport=httpx.MockTransport(lambda r: httpx.Response(200, json={})))
    for text in ("1", "2", "3"):
        recorder.record(trace(text))
    assert recorder.stats["dropped"] >= 1
    assert any("queue is full" in str(e) for e in errors)
    recorder.close(timeout=2)


def test_a_refusal_is_dropped_with_the_servers_own_sentence() -> None:
    errors: list[Exception] = []
    recorder = IrisRecorder("http://iris.test", flush_interval=0, on_error=errors.append, transport=httpx.MockTransport(lambda r: httpx.Response(401, json={"error": "A valid API key is required"})))
    recorder.record(trace())
    recorder.flush(5)
    assert recorder.stats["dropped"] == 1
    assert "answered 401: A valid API key is required" in str(errors[0])
    recorder.close()


def test_a_server_that_never_answers_is_abandoned_at_the_timeout() -> None:
    def hang(request: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out", request=request)

    recorder = IrisRecorder("http://iris.test", flush_interval=0, timeout=0.2, on_error=lambda e: None, transport=httpx.MockTransport(hang))
    recorder.record(trace())
    started = time.monotonic()
    assert recorder.flush(5)
    assert time.monotonic() - started < 2
    assert recorder.stats["dropped"] == 1
    recorder.close()


def test_a_trace_over_the_request_budget_is_dropped_and_the_rest_still_go() -> None:
    sent: list[int] = []
    errors: list[Exception] = []

    def handler(request: httpx.Request) -> httpx.Response:
        sent.append(len(request.content))
        return httpx.Response(200, json={"iris-eval": {"stored": []}})

    recorder = IrisRecorder("http://iris.test", flush_interval=0.05, on_error=errors.append, transport=httpx.MockTransport(handler))
    recorder.record(trace("x" * 1_000_000))
    recorder.record(trace("fits"))
    assert recorder.flush(5)
    assert recorder.stats["dropped"] == 1
    assert "over the 900000-byte request budget" in str(errors[0])
    assert len(sent) == 1 and sent[0] < 900_000
    recorder.close()


def test_an_unknown_bundle_is_refused_when_the_recorder_is_made() -> None:
    with pytest.raises(ValueError, match="eval_type must be one of"):
        IrisRecorder(eval_type="vibes")


def test_a_process_that_ends_without_flushing_still_delivers_what_it_recorded() -> None:
    received: list[dict] = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802 - the stdlib's name
            received.append(json.loads(self.rfile.read(int(self.headers["content-length"]))))
            payload = json.dumps({"iris-eval": {"stored": []}}).encode()
            self.send_response(200)
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)

        def log_message(self, *args: object) -> None:
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        script = textwrap.dedent(
            f"""
            from iris_eval import IrisRecorder, Span, TraceRecord
            from iris_eval.recorder import new_span_id, new_trace_id, now_nanos
            recorder = IrisRecorder("http://127.0.0.1:{server.server_address[1]}", flush_interval=60)
            now = now_nanos()
            recorder.record(TraceRecord({{"service.name": "exiting"}}, [Span(new_trace_id(), new_span_id(), "chat", now, now, {{"iris.output": "hi"}})]))
            """
        )
        result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=30)
    finally:
        server.shutdown()
    assert result.returncode == 0, result.stderr
    # The batch interval is a minute; the only way the trace arrived is the send on the way out.
    assert len(received) == 1
    assert received[0]["resourceSpans"][0]["resource"]["attributes"][0] == {"key": "service.name", "value": {"stringValue": "exiting"}}


def test_a_process_that_recorded_against_a_dead_server_exits_promptly_with_its_own_code() -> None:
    script = textwrap.dedent(
        """
        import sys
        from iris_eval import IrisRecorder, Span, TraceRecord
        from iris_eval.recorder import new_span_id, new_trace_id, now_nanos
        recorder = IrisRecorder("http://127.0.0.1:9", on_error=lambda e: None)
        now = now_nanos()
        recorder.record(TraceRecord({"service.name": "exit"}, [Span(new_trace_id(), new_span_id(), "chat", now, now, {"iris.output": "hi"})]))
        print("done")
        sys.exit(7)
        """
    )
    started = time.monotonic()
    result = subprocess.run([sys.executable, "-c", script], capture_output=True, text=True, timeout=30)
    took = time.monotonic() - started
    assert result.stdout.strip() == "done"
    assert result.returncode == 7
    assert took < 10, f"the process took {took:.1f}s to exit"
