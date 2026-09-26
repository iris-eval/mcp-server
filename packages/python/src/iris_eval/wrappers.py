"""``wrap_openai`` / ``wrap_anthropic`` — every model call the client makes, recorded.

    from openai import OpenAI
    from iris_eval import wrap_openai

    client = wrap_openai(OpenAI(), agent_name="support-bot")
    client.chat.completions.create(model="gpt-5.2", messages=[...])   # recorded, and scored by Iris

How: both official SDKs send every request through one method on the
client, ``post(path, body=..., stream=..., ...)``, which each API resource
binds when it is built. The wrapper takes ``client.copy()`` — a real
client of the same class, sharing the original's connection pool — and
gives the copy a ``post`` that watches the three model endpoints
(``/chat/completions``, ``/responses``, ``/v1/messages``) and passes every
other request through untouched. So every method that reaches those
endpoints is covered — ``create``, ``parse``, the ``stream`` helpers, sync
and async — and the original client is not changed. ``with_options`` and
``copy`` on the wrapped client return wrapped clients.

Each call becomes one OpenTelemetry GenAI span, handed to the recorder
after the response has been read — for a stream, when it ends or is
closed — so the caller never waits on Iris. A failed call is recorded too,
with its error, and the exception the caller sees is the provider's, the
same object, unchanged. Raw-response calls (``with_raw_response``,
``with_streaming_response``) pass through unrecorded: their body is the
caller's to read.
"""

from __future__ import annotations

import inspect
from typing import Any, Callable, Mapping, TypeVar
from urllib.parse import urlsplit

from ._genai import assembler_for, genai_span
from .recorder import SPAN_KIND_CLIENT, IrisRecorder, Span, TraceRecord, default_recorder, new_span_id, new_trace_id, now_nanos, program_name

T = TypeVar("T")

_WRAPPED = "_iris_eval_wrapped"
_RAW_RESPONSE_HEADER = "X-Stainless-Raw-Response"
#: The events after which a Responses or Messages stream has nothing more to say.
_TERMINAL_EVENTS = frozenset({"response.completed", "response.incomplete", "response.failed", "message_stop"})
_CANCELLED = ("cancelled", "the stream was closed before it finished")


class _Settings:
    def __init__(
        self,
        recorder: IrisRecorder | None,
        agent_name: str | None,
        session_id: str | None,
        run: str | None,
        evaluate: bool | None,
        eval_type: str | None,
        stream_usage: bool,
    ):
        self._recorder = recorder
        self.agent_name = agent_name
        self.session_id = session_id
        self.run = run
        self.evaluate = evaluate
        self.eval_type = eval_type
        self.stream_usage = stream_usage

    @property
    def recorder(self) -> IrisRecorder:
        return self._recorder if self._recorder is not None else default_recorder()


def _api_of(path: Any) -> str | None:
    if not isinstance(path, str):
        return None
    bare = path.split("?", 1)[0].rstrip("/")
    if bare.endswith("/chat/completions"):
        return "chat"
    if bare.endswith("/responses"):
        return "responses"
    if bare.endswith("/messages"):
        return "messages"
    return None


def _to_dict(obj: Any) -> dict[str, Any] | None:
    if isinstance(obj, Mapping):
        return dict(obj)
    dump = getattr(obj, "model_dump", None)
    if callable(dump):
        try:
            out = dump(mode="json", warnings=False)
        except Exception:
            out = dump()
        return out if isinstance(out, dict) else None
    return None


def _is_stream(obj: Any) -> bool:
    """The SDK's Stream / AsyncStream: iterable, closable, carrying its HTTP response — and not a parsed model."""
    return (
        not hasattr(obj, "model_dump")
        and hasattr(obj, "response")
        and callable(getattr(obj, "close", None))
        and (hasattr(obj, "__next__") or hasattr(obj, "__anext__"))
    )


class _Call:
    """One call in flight: the request as sent, when it started, and where it went."""

    def __init__(self, api: str, request: Mapping[str, Any], base_url: Any, settings: _Settings):
        self.api = api
        self.request = request
        self.start = now_nanos()
        self.settings = settings
        self.done = False
        try:
            parts = urlsplit(str(base_url))
            self.address = parts.hostname
            self.port = parts.port or (443 if parts.scheme == "https" else 80)
        except ValueError:
            self.address, self.port = None, None

    def finish(self, response: Mapping[str, Any] | None, error: tuple[str, str] | None = None) -> None:
        if self.done:
            return
        self.done = True
        try:
            s = self.settings
            recorder = s.recorder
            extra = {"gen_ai.conversation.id": s.session_id} if s.session_id else None
            name, attrs = genai_span(self.api, self.request, response, error=error, server_address=self.address, server_port=self.port, extra=extra)
            span = Span(
                trace_id=new_trace_id(),
                span_id=new_span_id(),
                name=name,
                start_ns=self.start,
                end_ns=now_nanos(),
                attributes=attrs,
                kind=SPAN_KIND_CLIENT,
                status="error" if error else "ok",
                status_message=error[1] if error else None,
            )
            resource = recorder.resource(s.agent_name or program_name(), {"iris.run": s.run}, evaluate=s.evaluate, eval_type=s.eval_type)
            recorder.record(TraceRecord(resource=resource, spans=[span]))
        except Exception:  # recording never fails the call it records
            pass


def _error_of(err: BaseException) -> tuple[str, str]:
    status = getattr(err, "status_code", None)
    kind = str(status) if isinstance(status, int) else type(err).__name__
    body = getattr(err, "body", None)
    message = None
    if isinstance(body, Mapping):
        inner = body.get("error")
        if isinstance(inner, Mapping) and isinstance(inner.get("message"), str):
            message = inner["message"]
        elif isinstance(body.get("message"), str):
            message = body["message"]
    return kind, message or getattr(err, "message", None) or str(err)


def _is_usage_only(chunk: Mapping[str, Any] | None) -> bool:
    return isinstance(chunk, Mapping) and chunk.get("choices") == [] and chunk.get("usage") is not None


class _RecordingStream:
    """The SDK's stream, read through: every event is passed on as it comes, and the call is recorded when it ends."""

    def __init__(self, inner: Any, call: _Call, swallow_usage: bool):
        self._inner = inner
        self._call = call
        self._swallow = swallow_usage
        self._assembler = assembler_for(call.api)
        self._terminal = False
        self._it: Any = None

    def __getattr__(self, name: str) -> Any:
        if name == "_inner":  # not set yet (a copy or a pickle): never recurse
            raise AttributeError(name)
        return getattr(self._inner, name)

    def _complete(self) -> bool:
        """The stream said all it will: a terminal event, or a Chat Completions stream whose every choice has finished."""
        if self._terminal:
            return True
        result = self._assembler.result() if self._call.api == "chat" else None
        choices = (result or {}).get("choices") or []
        return bool(choices) and all(c.get("finish_reason") for c in choices)

    def _seen(self, item: Any) -> bool:
        """Feed one event to the assembler; False when it is the usage chunk the wrapper asked for and the caller did not."""
        data = _to_dict(item)
        if data is None:
            return True
        try:
            if data.get("type") in _TERMINAL_EVENTS:
                self._terminal = True
            self._assembler.add(data)
        except Exception:
            pass
        return not (self._swallow and _is_usage_only(data))

    def _end(self, error: tuple[str, str] | None = None) -> None:
        self._call.finish(self._assembler.result(), error)

    def __iter__(self) -> "_RecordingStream":
        return self

    def __next__(self) -> Any:
        if self._it is None:
            self._it = iter(self._inner)
        while True:
            try:
                item = next(self._it)
            except StopIteration:
                self._end()
                raise
            except BaseException as err:
                self._end(_error_of(err))
                raise
            if self._seen(item):
                return item

    def __enter__(self) -> "_RecordingStream":
        return self

    def __exit__(self, *exc: object) -> None:
        self.close()

    def close(self) -> None:
        self._end(None if self._complete() else _CANCELLED)
        self._inner.close()


class _AsyncRecordingStream(_RecordingStream):
    def __aiter__(self) -> "_AsyncRecordingStream":
        return self

    async def __anext__(self) -> Any:
        if self._it is None:
            self._it = self._inner.__aiter__()
        while True:
            try:
                item = await self._it.__anext__()
            except StopAsyncIteration:
                self._end()
                raise
            except BaseException as err:
                self._end(_error_of(err))
                raise
            if self._seen(item):
                return item

    async def __aenter__(self) -> "_AsyncRecordingStream":
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self.close()

    async def close(self) -> None:  # type: ignore[override]
        self._end(None if self._complete() else _CANCELLED)
        await self._inner.close()


def _given(value: Any) -> bool:
    """False for the SDKs' "not given" sentinels (NotGiven, Omit), which older versions leave in the body and drop when they send it."""
    return value is not None and type(value).__name__ not in ("NotGiven", "Omit")


def _sent_body(body: Mapping[str, Any]) -> dict[str, Any]:
    """The body as it goes on the wire: without the sentinels."""
    return {k: v for k, v in body.items() if _given(v)}


def _prepare(api: str | None, kwargs: dict[str, Any], settings: _Settings) -> tuple[dict[str, Any], bool]:
    """The request to send and whether the usage chunk it brings must be hidden; ``kwargs`` is not changed."""
    body = kwargs.get("body")
    if api != "chat" or not isinstance(body, Mapping) or body.get("stream") is not True or _given(body.get("stream_options")) or not settings.stream_usage:
        return kwargs, False
    # Chat Completions streams carry no usage unless asked: ask, and hide the chunk the answer adds.
    return {**kwargs, "body": {**body, "stream_options": {"include_usage": True}}}, True


def _watched(api: str | None, kwargs: Mapping[str, Any]) -> bool:
    if api is None or not isinstance(kwargs.get("body"), Mapping):
        return False
    options = kwargs.get("options")
    headers = options.get("headers") if isinstance(options, Mapping) else None
    return not (isinstance(headers, Mapping) and headers.get(_RAW_RESPONSE_HEADER))


def _sync_post(post: Callable[..., Any], client: Any, settings: _Settings) -> Callable[..., Any]:
    def post_and_record(path: str, *args: Any, **kwargs: Any) -> Any:
        api = _api_of(path)
        if not _watched(api, kwargs):
            return post(path, *args, **kwargs)
        sent, swallow = _prepare(api, kwargs, settings)
        call = _Call(api, _sent_body(kwargs["body"]), getattr(client, "base_url", ""), settings)  # type: ignore[arg-type]
        try:
            result = post(path, *args, **sent)
        except BaseException as err:
            call.finish(None, _error_of(err))
            raise
        if _is_stream(result):
            return _RecordingStream(result, call, swallow)
        call.finish(_to_dict(result))
        return result

    return post_and_record


def _async_post(post: Callable[..., Any], client: Any, settings: _Settings) -> Callable[..., Any]:
    async def post_and_record(path: str, *args: Any, **kwargs: Any) -> Any:
        api = _api_of(path)
        if not _watched(api, kwargs):
            return await post(path, *args, **kwargs)
        sent, swallow = _prepare(api, kwargs, settings)
        call = _Call(api, _sent_body(kwargs["body"]), getattr(client, "base_url", ""), settings)  # type: ignore[arg-type]
        try:
            result = await post(path, *args, **sent)
        except BaseException as err:
            call.finish(None, _error_of(err))
            raise
        if _is_stream(result):
            return _AsyncRecordingStream(result, call, swallow)
        call.finish(_to_dict(result))
        return result

    return post_and_record


def _rebind(client: Any, obj: Any, seen: set[int], depth: int = 0) -> None:
    """Point every resource already built on this client at the recording ``post``.

    Current SDKs build their resources on first use, after the wrapper is in
    place; older ones (anthropic before 0.50, for one) build them all in the
    client's constructor, each holding the ``post`` it was given then.
    """
    for value in list(vars(obj).values()):
        if id(value) in seen or depth > 6 or not hasattr(value, "__dict__"):
            continue
        seen.add(id(value))
        if getattr(value, "_client", None) is client and "_post" in vars(value):
            value._post = client.post
            _rebind(client, value, seen, depth + 1)


def _install(client: Any, settings: _Settings) -> Any:
    post = client.post
    copy = client.copy
    client.post = (_async_post if inspect.iscoroutinefunction(post) else _sync_post)(post, client, settings)
    _rebind(client, client, set())

    def copy_and_wrap(*args: Any, **kwargs: Any) -> Any:
        return _install(copy(*args, **kwargs), settings)

    client.copy = copy_and_wrap
    client.with_options = copy_and_wrap
    setattr(client, _WRAPPED, True)
    return client


def _wrap(client: T, provider: str, settings: _Settings) -> T:
    if getattr(client, _WRAPPED, False):
        return client
    if not callable(getattr(client, "post", None)) or not callable(getattr(client, "copy", None)):
        raise TypeError(f"wrap_{provider}: expected a client from the official `{provider}` package (it has post() and copy()); got {type(client).__name__}")
    return _install(client.copy(), settings)  # type: ignore[attr-defined]


def wrap_openai(
    client: T,
    *,
    recorder: IrisRecorder | None = None,
    agent_name: str | None = None,
    session_id: str | None = None,
    run: str | None = None,
    evaluate: bool | None = None,
    eval_type: str | None = None,
    stream_usage: bool = True,
) -> T:
    """Record every Chat Completions and Responses call an ``OpenAI`` / ``AsyncOpenAI`` client makes.

    Returns a new client of the same class; the one passed in is not changed.

    ``recorder``: where the spans go (default: one process-wide recorder,
    configured from ``IRIS_URL`` / ``IRIS_API_KEY``). ``agent_name``: the
    agent (``service.name``; default: the running program's name).
    ``session_id``: the conversation (``gen_ai.conversation.id``). ``run``:
    the batch (``iris.run``). ``evaluate`` / ``eval_type``: ask Iris for a
    verdict, and which bundle (default: the recorder's — yes, every bundle).
    ``stream_usage``: Chat Completions streams carry no token usage unless
    asked; when a streamed call does not set ``stream_options`` the wrapper
    asks, and removes the usage-only final chunk before your code sees the
    stream. Set False for an OpenAI-compatible server that refuses the option.
    """
    return _wrap(client, "openai", _Settings(recorder, agent_name, session_id, run, evaluate, eval_type, stream_usage))


def wrap_anthropic(
    client: T,
    *,
    recorder: IrisRecorder | None = None,
    agent_name: str | None = None,
    session_id: str | None = None,
    run: str | None = None,
    evaluate: bool | None = None,
    eval_type: str | None = None,
) -> T:
    """Record every Messages call an ``Anthropic`` / ``AsyncAnthropic`` client makes. The options are ``wrap_openai``'s."""
    return _wrap(client, "anthropic", _Settings(recorder, agent_name, session_id, run, evaluate, eval_type, True))
