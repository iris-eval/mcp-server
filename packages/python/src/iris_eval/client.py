"""The client: one method per door, the server's own sentence on every refusal.

``IrisClient`` and ``AsyncIrisClient`` have the same methods; the async one
awaits. Both are context managers and close their connection pool. A
non-2xx answer raises ``IrisError`` carrying the server's ``error`` sentence,
the status and, when the server sent them, the validation ``details``; a
server that cannot be reached raises ``IrisConnectionError`` naming the URL
and how to start one.
"""

from __future__ import annotations

from typing import Any, Mapping

import httpx

from .discovery import find_server
from .types import Capabilities, Evaluation, Health, LoggedTrace, TraceDetail, TracePage

DEFAULT_TIMEOUT = 10.0
API = "/api/v1"
NO_SERVER = (
    "No Iris server: set IRIS_URL (for example http://127.0.0.1:6920), or start one where this runs — "
    "`npx -y @iris-eval/mcp-server --dashboard` — and the client finds its port in runtime.json."
)


class IrisError(Exception):
    """The server refused: its own sentence, the HTTP status, and the validation details when it sent them."""

    def __init__(self, message: str, *, status: int, details: Any = None, method: str = "", path: str = ""):
        super().__init__(message)
        self.message = message
        self.status = status
        self.details = details
        self.method = method
        self.path = path

    def __str__(self) -> str:  # pragma: no cover - trivial
        where = f" ({self.method} {self.path} → {self.status})" if self.method else f" ({self.status})"
        return f"{self.message}{where}"


class IrisConnectionError(IrisError):
    """No server answered at the URL."""

    def __init__(self, base_url: str, cause: Exception):
        super().__init__(f"Could not reach the Iris server at {base_url}: {cause}. {NO_SERVER}", status=0)
        self.base_url = base_url
        self.cause = cause


def _error_from(res: httpx.Response) -> IrisError:
    message = f"HTTP {res.status_code}"
    details = None
    try:
        body = res.json()
        if isinstance(body, dict):
            if isinstance(body.get("error"), str):
                message = body["error"]
            elif isinstance(body.get("message"), str):
                message = body["message"]
            details = body.get("details")
    except ValueError:
        text = res.text.strip()
        if text:
            message = text[:300]
    return IrisError(message, status=res.status_code, details=details, method=res.request.method, path=res.request.url.path)


def _trace_body(
    agent_name: str,
    *,
    input: str | None,
    output: str | None,
    framework: str | None,
    tool_calls: list[Mapping[str, Any]] | None,
    latency_ms: float | None,
    token_usage: Mapping[str, Any] | None,
    cost_usd: float | None,
    metadata: Mapping[str, Any] | None,
    tools: list[Mapping[str, Any]] | None,
    run: str | None,
    case_key: str | None,
    session_id: str | None,
    spans: list[Mapping[str, Any]] | None,
    timestamp: str | None,
    evaluate: bool,
    eval_type: str | None,
) -> dict[str, Any]:
    body: dict[str, Any] = {"agent_name": agent_name}
    for key, value in (
        ("input", input),
        ("output", output),
        ("framework", framework),
        ("tool_calls", tool_calls),
        ("latency_ms", latency_ms),
        ("token_usage", token_usage),
        ("cost_usd", cost_usd),
        ("metadata", metadata),
        ("tools", tools),
        ("run", run),
        ("case_key", case_key),
        ("session_id", session_id),
        ("spans", spans),
        ("timestamp", timestamp),
        ("eval_type", eval_type),
    ):
        if value is not None:
            body[key] = value
    if evaluate:
        body["evaluate"] = True
    return body


def _query(
    *,
    agent_name: str | None,
    framework: str | None,
    session: str | None,
    q: str | None,
    since: str | None,
    until: str | None,
    min_score: float | None,
    max_score: float | None,
    limit: int | None,
    offset: int | None,
    sort_by: str | None,
    sort_order: str | None,
) -> dict[str, Any]:
    params: dict[str, Any] = {}
    for key, value in (
        ("agent_name", agent_name),
        ("framework", framework),
        ("session", session),
        ("q", q),
        ("since", since),
        ("until", until),
        ("min_score", min_score),
        ("max_score", max_score),
        ("limit", limit),
        ("offset", offset),
        ("sort_by", sort_by),
        ("sort_order", sort_order),
    ):
        if value is not None:
            params[key] = value
    return params


class _Base:
    def __init__(self, base_url: str | None, api_key: str | None, timeout: float, user_agent: str):
        located = base_url.rstrip("/") if base_url else None
        if located is None:
            found = find_server()
            if found is None:
                raise IrisConnectionError("(no URL)", RuntimeError("nothing names a server"))
            located = found.base_url
        self.base_url = located
        headers = {"accept": "application/json", "user-agent": user_agent}
        if api_key:
            headers["authorization"] = f"Bearer {api_key}"
        self._headers = headers
        self._timeout = timeout


class IrisClient(_Base):
    """The synchronous client.

    ``base_url``: ``http://host:port`` of the dashboard; omitted, the server is
    found from ``IRIS_URL`` or ``runtime.json``. ``api_key``: sent as
    ``Authorization: Bearer`` — required by a server bound beyond loopback.
    ``transport``: an ``httpx`` transport, for tests.
    """

    def __init__(
        self,
        base_url: str | None = None,
        *,
        api_key: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        transport: httpx.BaseTransport | None = None,
    ):
        from . import __version__

        super().__init__(base_url, api_key, timeout, f"iris-eval-python/{__version__}")
        self._http = httpx.Client(base_url=self.base_url, headers=self._headers, timeout=timeout, transport=transport)

    def __enter__(self) -> "IrisClient":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._http.close()

    def _request(self, method: str, path: str, *, json: Any = None, params: Mapping[str, Any] | None = None) -> Any:
        try:
            res = self._http.request(method, API + path, json=json, params=params)
        except httpx.HTTPError as err:
            raise IrisConnectionError(self.base_url, err) from err
        if res.status_code >= 400:
            raise _error_from(res)
        return res.json()

    def log_trace(
        self,
        agent_name: str,
        *,
        input: str | None = None,
        output: str | None = None,
        framework: str | None = None,
        tool_calls: list[Mapping[str, Any]] | None = None,
        latency_ms: float | None = None,
        token_usage: Mapping[str, Any] | None = None,
        cost_usd: float | None = None,
        metadata: Mapping[str, Any] | None = None,
        tools: list[Mapping[str, Any]] | None = None,
        run: str | None = None,
        case_key: str | None = None,
        session_id: str | None = None,
        spans: list[Mapping[str, Any]] | None = None,
        timestamp: str | None = None,
        evaluate: bool = False,
        eval_type: str | None = None,
    ) -> LoggedTrace:
        """Store a trace (``POST /api/v1/traces``); with ``evaluate=True`` the answer carries its evaluation too."""
        body = _trace_body(
            agent_name,
            input=input,
            output=output,
            framework=framework,
            tool_calls=tool_calls,
            latency_ms=latency_ms,
            token_usage=token_usage,
            cost_usd=cost_usd,
            metadata=metadata,
            tools=tools,
            run=run,
            case_key=case_key,
            session_id=session_id,
            spans=spans,
            timestamp=timestamp,
            evaluate=evaluate,
            eval_type=eval_type,
        )
        return self._request("POST", "/traces", json=body)

    def evaluate_output(
        self,
        output: str,
        *,
        input: str | None = None,
        agent_name: str = "python",
        eval_type: str | None = None,
        tool_calls: list[Mapping[str, Any]] | None = None,
        tools: list[Mapping[str, Any]] | None = None,
        cost_usd: float | None = None,
        token_usage: Mapping[str, Any] | None = None,
        run: str | None = None,
        case_key: str | None = None,
        session_id: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> Evaluation:
        """Evaluate an output under the server's rules and get the verdict.

        Over HTTP the evaluate door is the ingest door: the output is stored
        as a trace of ``agent_name`` (so the dashboard shows it, and a run or
        case key makes it comparable) and evaluated in the same call — the
        same object the ``evaluate_output`` MCP tool returns. ``eval_type``
        names one bundle; omitted, every bundle runs.
        """
        logged = self.log_trace(
            agent_name,
            input=input,
            output=output,
            tool_calls=tool_calls,
            tools=tools,
            cost_usd=cost_usd,
            token_usage=token_usage,
            run=run,
            case_key=case_key,
            session_id=session_id,
            metadata=metadata,
            evaluate=True,
            eval_type=eval_type,
        )
        evaluation = logged.get("evaluation")
        if not isinstance(evaluation, dict):
            raise IrisError("The server stored the trace but answered with no evaluation", status=500, method="POST", path=API + "/traces")
        return evaluation

    def get_traces(
        self,
        *,
        agent_name: str | None = None,
        framework: str | None = None,
        session: str | None = None,
        q: str | None = None,
        since: str | None = None,
        until: str | None = None,
        min_score: float | None = None,
        max_score: float | None = None,
        limit: int | None = None,
        offset: int | None = None,
        sort_by: str | None = None,
        sort_order: str | None = None,
        **extra: Any,
    ) -> TracePage:
        """A page of traces (``GET /api/v1/traces``) — every filter the route reads.

        ``q`` is a full-text search over input, output, tool-call values and
        metadata values: every word must appear, ``"a phrase"`` in order,
        ``word*`` as a prefix. Results come back ranked by relevance unless
        ``sort_by`` says otherwise; each trace carries ``match`` (the field,
        a snippet, and the snippet as fragments with the matched words
        marked) and the page carries ``search``.

        Any other keyword is sent as a query parameter as it is, so a filter the
        server gains later needs no new client; one the server does not read is
        a 400 naming it (``IrisError``), never silently ignored.
        """
        params = _query(
            agent_name=agent_name,
            framework=framework,
            session=session,
            q=q,
            since=since,
            until=until,
            min_score=min_score,
            max_score=max_score,
            limit=limit,
            offset=offset,
            sort_by=sort_by,
            sort_order=sort_order,
        )
        params.update({k: v for k, v in extra.items() if v is not None})
        return self._request("GET", "/traces", params=params)

    def get_trace(self, trace_id: str) -> TraceDetail:
        """One trace with its spans and evaluations (``GET /api/v1/traces/:id``); a 404 raises ``IrisError``."""
        return self._request("GET", f"/traces/{trace_id}")

    def health(self) -> Health:
        """``GET /api/v1/health`` — open, unkeyed; ``status`` is ``ok`` or ``degraded`` (a 503 is still an answer)."""
        try:
            res = self._http.get(API + "/health")
        except httpx.HTTPError as err:
            raise IrisConnectionError(self.base_url, err) from err
        if res.status_code not in (200, 503):
            raise _error_from(res)
        return res.json()

    def capabilities(self) -> Capabilities:
        """``GET /api/v1/capabilities`` — what this server can do."""
        return self._request("GET", "/capabilities")


class AsyncIrisClient(_Base):
    """The asynchronous client — the same methods, awaited."""

    def __init__(
        self,
        base_url: str | None = None,
        *,
        api_key: str | None = None,
        timeout: float = DEFAULT_TIMEOUT,
        transport: httpx.AsyncBaseTransport | None = None,
    ):
        from . import __version__

        super().__init__(base_url, api_key, timeout, f"iris-eval-python/{__version__}")
        self._http = httpx.AsyncClient(base_url=self.base_url, headers=self._headers, timeout=timeout, transport=transport)

    async def __aenter__(self) -> "AsyncIrisClient":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.aclose()

    async def aclose(self) -> None:
        await self._http.aclose()

    async def _request(self, method: str, path: str, *, json: Any = None, params: Mapping[str, Any] | None = None) -> Any:
        try:
            res = await self._http.request(method, API + path, json=json, params=params)
        except httpx.HTTPError as err:
            raise IrisConnectionError(self.base_url, err) from err
        if res.status_code >= 400:
            raise _error_from(res)
        return res.json()

    async def log_trace(
        self,
        agent_name: str,
        *,
        input: str | None = None,
        output: str | None = None,
        framework: str | None = None,
        tool_calls: list[Mapping[str, Any]] | None = None,
        latency_ms: float | None = None,
        token_usage: Mapping[str, Any] | None = None,
        cost_usd: float | None = None,
        metadata: Mapping[str, Any] | None = None,
        tools: list[Mapping[str, Any]] | None = None,
        run: str | None = None,
        case_key: str | None = None,
        session_id: str | None = None,
        spans: list[Mapping[str, Any]] | None = None,
        timestamp: str | None = None,
        evaluate: bool = False,
        eval_type: str | None = None,
    ) -> LoggedTrace:
        body = _trace_body(
            agent_name,
            input=input,
            output=output,
            framework=framework,
            tool_calls=tool_calls,
            latency_ms=latency_ms,
            token_usage=token_usage,
            cost_usd=cost_usd,
            metadata=metadata,
            tools=tools,
            run=run,
            case_key=case_key,
            session_id=session_id,
            spans=spans,
            timestamp=timestamp,
            evaluate=evaluate,
            eval_type=eval_type,
        )
        return await self._request("POST", "/traces", json=body)

    async def evaluate_output(
        self,
        output: str,
        *,
        input: str | None = None,
        agent_name: str = "python",
        eval_type: str | None = None,
        tool_calls: list[Mapping[str, Any]] | None = None,
        tools: list[Mapping[str, Any]] | None = None,
        cost_usd: float | None = None,
        token_usage: Mapping[str, Any] | None = None,
        run: str | None = None,
        case_key: str | None = None,
        session_id: str | None = None,
        metadata: Mapping[str, Any] | None = None,
    ) -> Evaluation:
        logged = await self.log_trace(
            agent_name,
            input=input,
            output=output,
            tool_calls=tool_calls,
            tools=tools,
            cost_usd=cost_usd,
            token_usage=token_usage,
            run=run,
            case_key=case_key,
            session_id=session_id,
            metadata=metadata,
            evaluate=True,
            eval_type=eval_type,
        )
        evaluation = logged.get("evaluation")
        if not isinstance(evaluation, dict):
            raise IrisError("The server stored the trace but answered with no evaluation", status=500, method="POST", path=API + "/traces")
        return evaluation

    async def get_traces(
        self,
        *,
        agent_name: str | None = None,
        framework: str | None = None,
        session: str | None = None,
        q: str | None = None,
        since: str | None = None,
        until: str | None = None,
        min_score: float | None = None,
        max_score: float | None = None,
        limit: int | None = None,
        offset: int | None = None,
        sort_by: str | None = None,
        sort_order: str | None = None,
        **extra: Any,
    ) -> TracePage:
        params = _query(
            agent_name=agent_name,
            framework=framework,
            session=session,
            q=q,
            since=since,
            until=until,
            min_score=min_score,
            max_score=max_score,
            limit=limit,
            offset=offset,
            sort_by=sort_by,
            sort_order=sort_order,
        )
        params.update({k: v for k, v in extra.items() if v is not None})
        return await self._request("GET", "/traces", params=params)

    async def get_trace(self, trace_id: str) -> TraceDetail:
        return await self._request("GET", f"/traces/{trace_id}")

    async def health(self) -> Health:
        try:
            res = await self._http.get(API + "/health")
        except httpx.HTTPError as err:
            raise IrisConnectionError(self.base_url, err) from err
        if res.status_code not in (200, 503):
            raise _error_from(res)
        return res.json()

    async def capabilities(self) -> Capabilities:
        return await self._request("GET", "/capabilities")
