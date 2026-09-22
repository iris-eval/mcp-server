"""Where the server is: IRIS_URL first, then the runtime.json a running
server wrote (verified with the health route), then nothing."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from iris_eval import find_server
from iris_eval.discovery import is_healthy, iris_home, read_runtime_port, runtime_file


@pytest.fixture(autouse=True)
def clean_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> Path:
    monkeypatch.delenv("IRIS_URL", raising=False)
    monkeypatch.setenv("IRIS_HOME", str(tmp_path))
    return tmp_path


def test_iris_home_follows_the_servers_rule(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    assert iris_home() == tmp_path
    assert runtime_file() == tmp_path / "runtime.json"
    monkeypatch.delenv("IRIS_HOME")
    assert iris_home() == Path.home() / ".iris"


def test_env_wins_as_written(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv("IRIS_URL", "http://iris.internal:7000/")
    assert find_server() is not None
    assert find_server().base_url == "http://iris.internal:7000"
    assert find_server().source == "env"


def test_runtime_json_is_read_only_when_the_port_is_a_port(tmp_path: Path) -> None:
    assert read_runtime_port() is None
    (tmp_path / "runtime.json").write_text("not json", encoding="utf-8")
    assert read_runtime_port() is None
    (tmp_path / "runtime.json").write_text(json.dumps({"dashboardPort": "6920"}), encoding="utf-8")
    assert read_runtime_port() is None
    (tmp_path / "runtime.json").write_text(json.dumps({"dashboardPort": 6920, "pid": 1}), encoding="utf-8")
    assert read_runtime_port() == 6920


def test_a_recorded_port_is_trusted_only_when_health_answers(tmp_path: Path) -> None:
    (tmp_path / "runtime.json").write_text(json.dumps({"dashboardPort": 6931}), encoding="utf-8")
    alive = httpx.MockTransport(lambda req: httpx.Response(503 if req.url.path == "/api/v1/health" else 404, json={"status": "degraded"}))
    dead = httpx.MockTransport(lambda req: (_ for _ in ()).throw(httpx.ConnectError("refused")))
    assert is_healthy("http://127.0.0.1:6931", transport=alive) is True
    assert is_healthy("http://127.0.0.1:6931", transport=dead) is False
    found = find_server(transport=alive)
    assert found is not None and found.base_url == "http://127.0.0.1:6931" and found.source == "runtime.json"
    assert find_server(transport=dead) is None
    assert find_server(verify=False, transport=dead).base_url == "http://127.0.0.1:6931"


def test_nothing_names_a_server() -> None:
    assert find_server() is None
