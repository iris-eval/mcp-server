"""The two processes the end-to-end tests run against, started once per session:
this checkout's Iris server (keyed, in a scratch IRIS_HOME) and the scripted
model provider the official SDKs are pointed at.

Both need Node and a server build (``npm run build:server`` at the repository
root). Without them the end-to-end tests are skipped locally; CI sets
``IRIS_E2E=1``, which turns a missing prerequisite into a failure.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Iterator

import httpx
import pytest

REPO_ROOT = Path(__file__).resolve().parents[3]
SERVER = REPO_ROOT / "dist" / "index.js"
PROVIDER = REPO_ROOT / "tests" / "fixtures" / "scripted-provider" / "server.mjs"

REPLIES = {
    "default": "The capital of France is Paris.",
    "ssn": "Her SSN is 123-45-6789.",
    "after_tool": "It is 18 degrees and sunny in Paris.",
}


def require_prerequisites() -> str:
    node = shutil.which("node")
    missing = []
    if node is None:
        missing.append("node on PATH")
    if not SERVER.exists():
        missing.append(f"a server build at {SERVER} (npm run build:server)")
    if missing:
        message = "the end-to-end tests need " + " and ".join(missing)
        if os.environ.get("IRIS_E2E") == "1":
            pytest.fail(message)
        pytest.skip(message)
    return node  # type: ignore[return-value]


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


@dataclass
class Iris:
    url: str
    api_key: str

    def trace(self, trace_id: str) -> dict[str, Any]:
        """GET /api/v1/traces/:id — the trace, its spans and its evaluations, as the server stored them."""
        res = httpx.get(f"{self.url}/api/v1/traces/{trace_id}", headers={"authorization": f"Bearer {self.api_key}"}, timeout=10)
        res.raise_for_status()
        return res.json()


@dataclass
class Provider:
    url: str

    def requests(self) -> list[dict[str, Any]]:
        return httpx.get(f"{self.url}/__requests", timeout=10).json()


def _launch(node: str, home: str, api_key: str) -> tuple[subprocess.Popen[bytes], str, Any]:
    port = free_port()
    env = {**os.environ, "IRIS_HOME": home, "IRIS_NO_AUTO_LAUNCH": "1"}
    env.pop("IRIS_URL", None)
    env.pop("IRIS_API_KEY", None)
    log = open(Path(home) / "server.log", "a", encoding="utf-8")  # noqa: SIM115 - closed by the caller
    # stdin stays open: the MCP transport is stdio, and it ends the process when stdin closes.
    proc = subprocess.Popen([node, str(SERVER), "--dashboard", "--dashboard-port", str(port), "--api-key", api_key], env=env, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=log)
    url = f"http://127.0.0.1:{port}"
    deadline = time.monotonic() + 45
    while True:
        try:
            if httpx.get(f"{url}/api/v1/health", timeout=1).status_code in (200, 503):
                return proc, url, log
        except Exception:  # not listening yet: refused, or on Windows a connect that times out
            pass
        if proc.poll() is not None or time.monotonic() > deadline:
            proc.kill()
            proc.wait(timeout=10)
            log.close()
            raise RuntimeError(f"Iris did not start on {url}")
        time.sleep(0.15)


def start_iris(config: dict[str, Any] | None = None) -> Iterator[Iris]:
    """This checkout's server in a scratch home; ``config`` is written as that home's config.json."""
    node = require_prerequisites()
    home = tempfile.mkdtemp(prefix="iris-py-e2e-")
    if config is not None:
        (Path(home) / "config.json").write_text(json.dumps(config), encoding="utf-8")
    api_key = "py-e2e-key"
    # A free port can be taken between choosing it and binding it; a second attempt picks another.
    for attempt in range(3):
        try:
            proc, url, log = _launch(node, home, api_key)
            break
        except RuntimeError:
            if attempt == 2:
                raise RuntimeError("Iris did not start:\n" + (Path(home) / "server.log").read_text(encoding="utf-8")) from None
    try:
        yield Iris(url, api_key)
    finally:
        proc.kill()
        proc.wait(timeout=10)
        log.close()
        shutil.rmtree(home, ignore_errors=True)


def start_provider() -> Iterator[Provider]:
    node = require_prerequisites()
    proc = subprocess.Popen([node, str(PROVIDER)], stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    assert proc.stdout is not None
    line = proc.stdout.readline()
    try:
        port = json.loads(line)["port"]
    except (ValueError, KeyError):
        proc.kill()
        raise RuntimeError(f"the scripted provider did not start: {line!r} {proc.stderr.read() if proc.stderr else ''}")
    try:
        yield Provider(f"http://127.0.0.1:{port}")
    finally:
        proc.kill()
        proc.wait(timeout=10)
