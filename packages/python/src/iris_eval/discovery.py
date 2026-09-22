"""Where the server is.

In order: ``IRIS_URL`` (the whole base, ``http://host:port``); the
``runtime.json`` a running dashboard writes under ``IRIS_HOME`` (or
``~/.iris``) with the port it actually bound; nothing. The file may be
stale after an unclean exit, so a location read from it is verified with
``GET /api/v1/health`` before it is trusted — the contract the server's own
comment states.
"""

from __future__ import annotations

import json
import os
from dataclasses import dataclass
from pathlib import Path

import httpx

DEFAULT_HEALTH_TIMEOUT = 2.0


@dataclass(frozen=True)
class ServerLocation:
    """A base URL and where it came from: ``env``, ``runtime.json`` or ``default``."""

    base_url: str
    source: str


def iris_home() -> Path:
    """``IRIS_HOME``, or ``~/.iris`` — the same rule the server applies."""
    home = os.environ.get("IRIS_HOME")
    return Path(home).expanduser() if home else Path.home() / ".iris"


def runtime_file() -> Path:
    return iris_home() / "runtime.json"


def read_runtime_port(path: Path | None = None) -> int | None:
    """The dashboard port a running server recorded, or None."""
    p = path or runtime_file()
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None
    port = data.get("dashboardPort") if isinstance(data, dict) else None
    return port if isinstance(port, int) and 0 < port < 65536 else None


def is_healthy(base_url: str, *, timeout: float = DEFAULT_HEALTH_TIMEOUT, transport: httpx.BaseTransport | None = None) -> bool:
    """``GET /api/v1/health`` answers — 200 (ok) or 503 (degraded) both mean a server is there; a connection error means none."""
    try:
        with httpx.Client(base_url=base_url, timeout=timeout, transport=transport) as client:
            res = client.get("/api/v1/health")
        return res.status_code in (200, 503)
    except httpx.HTTPError:
        return False


def find_server(*, verify: bool = True, transport: httpx.BaseTransport | None = None) -> ServerLocation | None:
    """The server's base URL, or None when nothing names one.

    ``IRIS_URL`` wins as written (a URL the operator set is not second-guessed).
    A port read from ``runtime.json`` is only returned when the health route
    answers on it, unless ``verify`` is False.
    """
    env = os.environ.get("IRIS_URL")
    if env:
        return ServerLocation(env.rstrip("/"), "env")
    port = read_runtime_port()
    if port is None:
        return None
    base = f"http://127.0.0.1:{port}"
    if verify and not is_healthy(base, transport=transport):
        return None
    return ServerLocation(base, "runtime.json")
