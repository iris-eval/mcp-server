"""The recorder: spans in, OTLP/HTTP JSON out to Iris's ``POST /v1/traces``.

The provider wrappers (``wrap_openai``, ``wrap_anthropic``) and the
LangChain handler hand their spans to a recorder, and the recorder is the
only thing that talks to the network. It keeps three promises:

1. It never breaks, slows or changes the application. ``record()`` puts the
   trace on a bounded queue and returns; a daemon thread sends it. The queue
   drops its oldest trace when full, nothing it does raises into the
   caller, and at exit it gets a short, bounded chance to deliver.
2. It speaks plain OTLP. The body is an ExportTraceServiceRequest and the
   span attributes are the GenAI semantic conventions; the only Iris-specific
   parts are the endpoint and the ``iris.*`` resource attributes that ask for
   a verdict.
3. It returns what Iris said. Each answer names the Iris trace each OTLP
   trace became and, when evaluation was asked for, its verdict; those land
   in ``results`` and the ``on_result`` callback.
"""

from __future__ import annotations

import atexit
import collections
import json
import logging
import os
import secrets
import sys
import threading
import time
import weakref
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Mapping

import httpx

from .discovery import find_server

logger = logging.getLogger("iris_eval")

SDK_NAME = "iris-eval"
#: The bundles Iris can run; ``all`` (the default) runs every one.
EVAL_TYPES = ("completeness", "relevance", "safety", "cost", "custom", "all")
#: Bytes one request may carry: under the server's 1 MB body limit, with room for the envelope.
MAX_BATCH_BYTES = 900_000
MAX_RESULTS = 1000

SPAN_KIND_INTERNAL = 1
SPAN_KIND_CLIENT = 3


def new_trace_id() -> str:
    return secrets.token_hex(16)


def new_span_id() -> str:
    return secrets.token_hex(8)


def now_nanos() -> int:
    return time.time_ns()


@dataclass
class Span:
    """One span, as OTLP carries it."""

    trace_id: str
    span_id: str
    name: str
    start_ns: int
    end_ns: int
    attributes: dict[str, Any] = field(default_factory=dict)
    parent_span_id: str | None = None
    kind: int = SPAN_KIND_INTERNAL
    #: ``"ok"``, ``"error"`` or None (unset).
    status: str | None = None
    status_message: str | None = None


@dataclass
class TraceRecord:
    """One trace: the resource (``service.name`` names the agent) and its spans."""

    resource: dict[str, Any]
    spans: list[Span]


# ---------- OTLP JSON ----------


def _any_value(v: Any) -> dict[str, Any]:
    if isinstance(v, bool):
        return {"boolValue": v}
    if isinstance(v, int):
        return {"intValue": str(v)}
    if isinstance(v, float):
        return {"doubleValue": v}
    if isinstance(v, (list, tuple)):
        return {"arrayValue": {"values": [_any_value(x) for x in v]}}
    if isinstance(v, str):
        return {"stringValue": v}
    return {"stringValue": json.dumps(v, separators=(",", ":"), ensure_ascii=False, default=str)}


def _key_values(attrs: Mapping[str, Any]) -> list[dict[str, Any]]:
    return [{"key": k, "value": _any_value(v)} for k, v in attrs.items() if v is not None]


def _otlp_span(s: Span) -> dict[str, Any]:
    out: dict[str, Any] = {
        "traceId": s.trace_id,
        "spanId": s.span_id,
        "name": s.name,
        "kind": s.kind,
        "startTimeUnixNano": str(s.start_ns),
        "endTimeUnixNano": str(s.end_ns),
        "attributes": _key_values(s.attributes),
    }
    if s.parent_span_id:
        out["parentSpanId"] = s.parent_span_id
    if s.status in ("ok", "error"):
        status: dict[str, Any] = {"code": 1 if s.status == "ok" else 2}
        if s.status_message:
            status["message"] = s.status_message
        out["status"] = status
    return out


def export_request(traces: list[TraceRecord]) -> dict[str, Any]:
    """One ExportTraceServiceRequest for a batch: one ResourceSpans per distinct resource."""
    from . import __version__

    groups: dict[str, tuple[dict[str, Any], list[Span]]] = {}
    for t in traces:
        key = json.dumps(sorted(t.resource.items()), default=str)
        groups.setdefault(key, (t.resource, []))[1].extend(t.spans)
    return {
        "resourceSpans": [
            {
                "resource": {"attributes": _key_values(resource)},
                "scopeSpans": [{"scope": {"name": SDK_NAME, "version": __version__}, "spans": [_otlp_span(s) for s in spans]}],
            }
            for resource, spans in groups.values()
        ]
    }


def program_name() -> str:
    """The running program's name: the agent name when none is given."""
    main = sys.modules.get("__main__")
    spec = getattr(main, "__spec__", None)
    if spec is not None and getattr(spec, "name", None):
        name = spec.name
        return name[: -len(".__main__")] if name.endswith(".__main__") else name
    argv0 = sys.argv[0] if sys.argv and sys.argv[0] else ""
    stem = Path(argv0).stem
    return stem or "python"


# ---------- the recorder ----------


class IrisRecorder:
    """Sends traces to Iris over OTLP, off the caller's thread.

    ``base_url``: the dashboard, e.g. ``http://127.0.0.1:6920``; omitted, it
    is found as the client finds it (``IRIS_URL``, then ``runtime.json``) when
    the first trace is sent. ``api_key``: default ``IRIS_API_KEY``.
    ``evaluate`` asks Iris for a verdict on every trace (default true) and
    ``eval_type`` names the bundle (default: every bundle). ``on_result`` is
    called, on the sender thread, with each stored trace and its verdict.
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        api_key: str | None = None,
        evaluate: bool = True,
        eval_type: str | None = None,
        max_queue: int = 1000,
        flush_interval: float = 0.25,
        timeout: float = 5.0,
        on_result: Callable[[dict[str, Any]], None] | None = None,
        on_error: Callable[[Exception], None] | None = None,
        transport: httpx.BaseTransport | None = None,
    ):
        if eval_type is not None and eval_type not in EVAL_TYPES:
            raise ValueError(f"eval_type must be one of {', '.join(EVAL_TYPES)}; got {eval_type!r}")
        self._base_url = base_url.rstrip("/") if base_url else None
        self._api_key = api_key
        self.evaluate = evaluate
        self.eval_type = eval_type
        self._max_queue = max(1, max_queue)
        self._interval = max(0.0, flush_interval)
        self._timeout = timeout
        self._on_result = on_result
        self._on_error = on_error
        self._transport = transport
        self.results: collections.deque[dict[str, Any]] = collections.deque(maxlen=MAX_RESULTS)
        #: recorded (handed to ``record``), sent (stored by Iris), dropped (a full queue, no server, a refusal).
        self.stats = {"recorded": 0, "sent": 0, "dropped": 0}
        self._queue: collections.deque[list[Any]] = collections.deque()
        self._cond = threading.Condition()
        self._busy = False
        self._closed = False
        # Callers waiting in flush(); while there are any, the sender does not wait out its batching interval.
        self._flushing = 0
        self._thread: threading.Thread | None = None
        self._warned: set[str] = set()
        self._http: httpx.Client | None = None
        self._found: str | None = None
        _live.add(self)

    def resource(self, agent_name: str, extra: Mapping[str, Any] | None = None, *, evaluate: bool | None = None, eval_type: str | None = None) -> dict[str, Any]:
        """The resource attributes every trace carries: the agent, this client, and the ask for a verdict."""
        from . import __version__

        wants = self.evaluate if evaluate is None else evaluate
        bundle = eval_type if eval_type is not None else self.eval_type
        resource: dict[str, Any] = {
            "service.name": agent_name,
            "telemetry.sdk.name": SDK_NAME,
            "telemetry.sdk.language": "python",
            "telemetry.sdk.version": __version__,
        }
        if wants:
            resource["iris.evaluate"] = True
            if bundle:
                resource["iris.eval_type"] = bundle
        if extra:
            resource.update({k: v for k, v in extra.items() if v is not None})
        return resource

    # -- the caller's side: never blocks, never raises --

    def record(self, trace: TraceRecord) -> None:
        """Queue one trace for sending."""
        try:
            with self._cond:
                if self._closed:
                    return
                self.stats["recorded"] += 1
                if len(self._queue) >= self._max_queue:
                    self._queue.popleft()
                    self.stats["dropped"] += 1
                    full = True
                else:
                    full = False
                # Its size is measured on the sender thread, never on the caller's.
                self._queue.append([trace, None])
                self._ensure_thread()
                self._cond.notify_all()
            if full:
                self._fail("queue-full", RuntimeError(f"iris: the queue is full ({self._max_queue} traces); the oldest was dropped"))
        except Exception as err:  # pragma: no cover - defensive: recording never fails the call
            self._fail("internal", err)

    def flush(self, timeout: float = 10.0) -> bool:
        """Send everything queued. True when it was all delivered (or dropped) within ``timeout`` seconds."""
        deadline = time.monotonic() + timeout
        with self._cond:
            self._flushing += 1
            try:
                self._cond.notify_all()
                while self._queue or self._busy:
                    left = deadline - time.monotonic()
                    if left <= 0:
                        return False
                    self._ensure_thread()
                    self._cond.notify_all()
                    self._cond.wait(min(left, 0.05))
            finally:
                self._flushing -= 1
        return True

    def close(self, timeout: float = 10.0) -> None:
        """Flush, then stop the sender."""
        self.flush(timeout)
        with self._cond:
            self._closed = True
            self._cond.notify_all()
        if self._thread is not None:
            self._thread.join(timeout=1.0)
        if self._http is not None:
            self._http.close()
            self._http = None

    # -- the sender's side --

    def _ensure_thread(self) -> None:
        if self._thread is None or not self._thread.is_alive():
            self._thread = threading.Thread(target=self._run, name="iris-eval-recorder", daemon=True)
            self._thread.start()

    def _run(self) -> None:
        while True:
            with self._cond:
                while not self._queue and not self._closed:
                    self._cond.wait()
                if not self._queue and self._closed:
                    return
                # Let a burst gather into one request, unless someone is waiting on a flush or the
                # recorder is closing. record() wakes this wait too, so it is a deadline, not one wait:
                # otherwise every new trace cut the interval short and the queue was sent one at a time.
                gather_until = time.monotonic() + self._interval
                while not self._flushing and not self._closed:
                    left = gather_until - time.monotonic()
                    if left <= 0:
                        break
                    self._cond.wait(left)
                taken = list(self._queue)
                self._queue.clear()
                self._busy = True
            # Measured here, outside the lock, so a caller's record() never waits on a large trace.
            batch: list[TraceRecord] = []
            size = 0
            left: list[list[Any]] = []
            too_large: list[int] = []
            for item in taken:
                if item[1] is None:
                    item[1] = len(json.dumps(export_request([item[0]]), default=str))
                if item[1] > MAX_BATCH_BYTES:
                    too_large.append(item[1])
                elif left or size + item[1] > MAX_BATCH_BYTES:
                    left.append(item)
                else:
                    batch.append(item[0])
                    size += item[1]
            with self._cond:
                # What did not fit goes back in front of anything recorded meanwhile, in order.
                self._queue.extendleft(reversed(left))
                self.stats["dropped"] += len(too_large)
            for n in too_large:
                self._fail("too-large", RuntimeError(f"iris: a trace of {n} bytes is over the {MAX_BATCH_BYTES}-byte request budget and was not sent"))
            if not batch:
                with self._cond:
                    self._busy = False
                    self._cond.notify_all()
                continue
            try:
                self._send(batch)
            finally:
                with self._cond:
                    self._busy = False
                    self._cond.notify_all()

    def _client(self) -> httpx.Client:
        if self._http is None:
            self._http = httpx.Client(timeout=self._timeout, transport=self._transport)
        return self._http

    def _send(self, batch: list[TraceRecord]) -> None:
        from . import __version__

        base = self._base_url or self._found
        if base is None:
            found = find_server()
            base = self._found = found.base_url if found else None
        if base is None:
            with self._cond:
                self.stats["dropped"] += len(batch)
            self._fail(
                "no-server",
                RuntimeError(
                    "iris: no server to send to. Set IRIS_URL (for example http://127.0.0.1:6920), pass base_url, "
                    "or start one with `npx -y @iris-eval/mcp-server --dashboard`."
                ),
            )
            return
        api_key = self._api_key if self._api_key is not None else os.environ.get("IRIS_API_KEY")
        headers = {"content-type": "application/json", "user-agent": f"iris-eval-python/{__version__}"}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        try:
            res = self._client().post(f"{base}/v1/traces", content=json.dumps(export_request(batch), default=str), headers=headers)
        except httpx.HTTPError as err:
            with self._cond:
                self.stats["dropped"] += len(batch)
            self._found = None  # found, not given: look again next time
            self._fail("unreachable", RuntimeError(f"iris: could not reach {base}/v1/traces: {err}"))
            return
        if res.status_code >= 400:
            with self._cond:
                self.stats["dropped"] += len(batch)
            message = res.text[:300]
            try:
                body = res.json()
                if isinstance(body, dict) and isinstance(body.get("error"), str):
                    message = body["error"]
            except ValueError:
                pass
            self._fail(f"http-{res.status_code}", RuntimeError(f"iris: {base}/v1/traces answered {res.status_code}: {message}"))
            return
        try:
            stored = res.json().get("iris-eval", {}).get("stored", [])
        except (ValueError, AttributeError):
            stored = []
        with self._cond:
            self.stats["sent"] += len(stored)
            self.results.extend(stored)
        for entry in stored:
            if self._on_result is not None:
                try:
                    self._on_result(entry)
                except Exception as err:
                    self._fail("on-result", err)

    def _fail(self, kind: str, err: Exception) -> None:
        if self._on_error is not None:
            try:
                self._on_error(err)
            except Exception:
                pass
            return
        if kind in self._warned:
            return
        self._warned.add(kind)
        logger.warning("%s", err)


_live: "weakref.WeakSet[IrisRecorder]" = weakref.WeakSet()
_default: IrisRecorder | None = None
_default_lock = threading.Lock()


def default_recorder() -> IrisRecorder:
    """The process-wide recorder the wrappers use when none is passed."""
    global _default
    with _default_lock:
        if _default is None:
            _default = IrisRecorder()
        return _default


@atexit.register
def _deliver_at_exit() -> None:
    # A short, bounded chance to send what is queued; never holds the exit longer than this.
    deadline = time.monotonic() + 2.0
    for recorder in list(_live):
        left = deadline - time.monotonic()
        if left <= 0:
            return
        try:
            recorder.flush(timeout=left)
        except Exception:
            pass
