"""The pytest plugin, run through pytester: the fixture skips (or fails
with IRIS_REQUIRE=1) without a server; against a fake server, assert_iris
passes a clean answer, fails a leaky one naming the basis and the rules,
and refuses an unknown trace field."""

from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

import pytest

pytest_plugins = ["pytester"]


class _Handler(BaseHTTPRequestHandler):
    def log_message(self, *args: object) -> None:  # quiet
        pass

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/api/v1/health":
            self._send(200, {"status": "ok", "version": "0.16.0"})
        else:
            self._send(404, {"error": "no route"})

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("content-length", "0"))
        body = json.loads(self.rfile.read(length) or b"{}")
        leaky = "123-45-6789" in (body.get("output") or "")
        self._send(
            201,
            {
                "trace_id": "trace_1",
                "status": "stored",
                "evaluation": {
                    "id": "eval_1",
                    "trace_id": "trace_1",
                    "score": 0.4 if leaky else 0.9,
                    "passed": not leaky,
                    "verdict": {"state": "fail", "basis": "detector_veto", "by": ["no_pii"]} if leaky else {"state": "pass", "basis": "clean", "by": []},
                },
            },
        )


@pytest.fixture
def fake_server():
    server = HTTPServer(("127.0.0.1", 0), _Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}"
    finally:
        server.shutdown()
        server.server_close()


TEST_FILE = """
from iris_eval.pytest_plugin import assert_iris

def test_clean(iris):
    evaluation = assert_iris("The refund was approved and posts within five days.", input="Was the refund approved?", client=iris)
    assert evaluation["verdict"]["basis"] == "clean"

def test_leaky(iris):
    assert_iris("The SSN is 123-45-6789.", input="q", client=iris)

def test_expect_fail(iris):
    assert_iris("The SSN is 123-45-6789.", input="q", expect="fail", client=iris)

def test_unknown_field(iris):
    assert_iris("fine", client=iris, colour="blue")
"""


def test_without_a_server_the_fixture_skips_with_the_recipe(pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.delenv("IRIS_URL", raising=False)
    monkeypatch.delenv("IRIS_REQUIRE", raising=False)
    monkeypatch.setenv("IRIS_HOME", str(tmp_path / "empty-home"))
    pytester.makepyfile(TEST_FILE)
    result = pytester.runpytest("-rs")
    result.assert_outcomes(skipped=4)
    result.stdout.fnmatch_lines(["*no Iris server: set IRIS_URL*"])


def test_with_iris_require_the_fixture_fails_instead(pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.delenv("IRIS_URL", raising=False)
    monkeypatch.setenv("IRIS_REQUIRE", "1")
    monkeypatch.setenv("IRIS_HOME", str(tmp_path / "empty-home"))
    pytester.makepyfile(TEST_FILE)
    result = pytester.runpytest()
    result.assert_outcomes(errors=4)


def test_against_a_server_assert_iris_judges_on_the_verdict(pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch, fake_server: str) -> None:
    monkeypatch.setenv("IRIS_URL", fake_server)
    monkeypatch.delenv("IRIS_REQUIRE", raising=False)
    pytester.makepyfile(TEST_FILE)
    result = pytester.runpytest()
    result.assert_outcomes(passed=2, failed=2)
    result.stdout.fnmatch_lines(["*Iris verdict fail on detector_veto by no_pii (expected pass)*"])
    result.stdout.fnmatch_lines(["*assert_iris got unexpected keyword(s): colour*"])


def test_the_url_option_beats_the_environment(pytester: pytest.Pytester, monkeypatch: pytest.MonkeyPatch, fake_server: str) -> None:
    monkeypatch.setenv("IRIS_URL", "http://127.0.0.1:1")
    pytester.makepyfile(TEST_FILE)
    result = pytester.runpytest(f"--iris-url={fake_server}", "-k", "test_clean")
    result.assert_outcomes(passed=1)
