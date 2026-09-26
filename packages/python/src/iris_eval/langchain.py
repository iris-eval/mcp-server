"""``IrisCallbackHandler`` — every LangChain and LangGraph run, recorded and scored.

    from iris_eval.langchain import IrisCallbackHandler

    iris = IrisCallbackHandler(agent_name="support-bot")
    graph.invoke({"messages": [("user", "Weather in Paris?")]}, config={"callbacks": [iris]})

One top-level run (a graph, a chain, an agent, or a model called on its own)
becomes one trace: the run is the root span, and every step inside it — each
model call, each tool call, each chain or graph node, each retriever — is a
child span, in the OpenTelemetry GenAI conventions (``invoke_agent``,
``chat``, ``execute_tool``). The trace is handed to the recorder when the
top-level run ends, so Iris stores it with the run's input, output, tool
calls, token usage and latency, and returns a verdict — the same OTLP door
and the same recorder the provider wrappers use.

The handler needs ``langchain-core``; importing ``iris_eval`` alone does not.
"""

from __future__ import annotations

import json
import threading
from dataclasses import dataclass, field
from typing import Any, Mapping, Sequence
from uuid import UUID

from langchain_core.callbacks import BaseCallbackHandler

from ._genai import clip
from .recorder import SPAN_KIND_CLIENT, SPAN_KIND_INTERNAL, IrisRecorder, Span, TraceRecord, default_recorder, new_span_id, new_trace_id, now_nanos, program_name

__all__ = ["IrisCallbackHandler"]

_ROLES = {"human": "user", "user": "user", "ai": "assistant", "assistant": "assistant", "system": "system", "developer": "system", "tool": "tool", "function": "tool"}


def _dumps(value: Any) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False, default=str)


def _text_of(content: Any) -> str:
    """The words in a message's content: a string, or the text blocks of a list."""
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        return "\n".join(b if isinstance(b, str) else str(b.get("text")) for b in content if isinstance(b, str) or (isinstance(b, Mapping) and b.get("type") == "text" and isinstance(b.get("text"), str)))
    return ""


def _parts_of(content: Any) -> list[dict[str, Any]]:
    if isinstance(content, str):
        return [{"type": "text", "content": clip(content)}] if content else []
    parts: list[dict[str, Any]] = []
    for block in content if isinstance(content, list) else []:
        if isinstance(block, str):
            parts.append({"type": "text", "content": clip(block)})
        elif isinstance(block, Mapping) and block.get("type") == "text" and isinstance(block.get("text"), str):
            parts.append({"type": "text", "content": clip(block["text"])})
        elif isinstance(block, Mapping) and block.get("type") in ("thinking", "reasoning"):
            text = block.get("thinking") or block.get("reasoning") or block.get("text")
            if isinstance(text, str):
                parts.append({"type": "reasoning", "content": clip(text)})
        elif isinstance(block, Mapping) and block.get("type") in ("tool_use", "tool_call"):
            continue  # carried by the message's tool_calls
        else:
            kind = block.get("type") if isinstance(block, Mapping) else None
            parts.append({"type": kind if isinstance(kind, str) and kind else "unknown"})
    return parts


def _message(msg: Any) -> dict[str, Any] | None:
    """A LangChain message (object, dict, or ``(role, content)`` tuple) in the conventions' schema."""
    if isinstance(msg, tuple) and len(msg) == 2:
        role, content = msg
        return {"role": _ROLES.get(str(role), str(role)), "parts": _parts_of(content)}
    if isinstance(msg, str):
        return {"role": "user", "parts": _parts_of(msg)}
    kind = getattr(msg, "type", None) if not isinstance(msg, Mapping) else (msg.get("role") or msg.get("type"))
    content = msg.get("content") if isinstance(msg, Mapping) else getattr(msg, "content", None)
    if kind is None and content is None:
        return None
    role = _ROLES.get(str(kind), str(kind))
    if role == "tool":
        call_id = msg.get("tool_call_id") if isinstance(msg, Mapping) else getattr(msg, "tool_call_id", None)
        response = clip(content) if isinstance(content, str) else _text_of(content) or content
        return {"role": "tool", "parts": [{"type": "tool_call_response", **({"id": call_id} if call_id else {}), "response": response}]}
    parts = _parts_of(content)
    calls = msg.get("tool_calls") if isinstance(msg, Mapping) else getattr(msg, "tool_calls", None)
    for call in calls or []:
        if isinstance(call, Mapping):
            parts.append({"type": "tool_call", **({"id": call["id"]} if call.get("id") else {}), "name": str(call.get("name") or ""), "arguments": call.get("args", {})})
    return {"role": role, "parts": parts}


def _messages(seq: Any) -> list[dict[str, Any]]:
    return [m for m in (_message(x) for x in (seq if isinstance(seq, (list, tuple)) else [])) if m is not None]


def _plain(messages: list[dict[str, Any]]) -> str:
    return "\n".join(p["content"] for m in messages for p in m["parts"] if p.get("type") == "text")


def _last_text(messages: list[dict[str, Any]], role: str) -> str | None:
    for m in reversed(messages):
        if m["role"] == role:
            text = "\n".join(p["content"] for p in m["parts"] if p.get("type") == "text")
            if text:
                return text
    return None


def _run_input(inputs: Any) -> str | None:
    """What a run was asked, in words: the last user message, an ``input`` / ``question`` / ``query`` field, or the value itself."""
    if isinstance(inputs, str):
        return clip(inputs)
    if isinstance(inputs, Mapping):
        if "messages" in inputs:
            return _last_text(_messages(inputs["messages"]), "user")
        for key in ("input", "question", "query", "prompt"):
            if isinstance(inputs.get(key), str):
                return clip(inputs[key])
    if isinstance(inputs, (list, tuple)):
        return _last_text(_messages(inputs), "user")
    return clip(_dumps(inputs)) if inputs not in (None, {}, []) else None


def _run_output(outputs: Any) -> str | None:
    """What a run answered, in words: the last assistant message, an ``output`` / ``answer`` field, or the value itself."""
    if isinstance(outputs, str):
        return clip(outputs)
    msg = _message(outputs) if hasattr(outputs, "content") else None
    if msg is not None:
        return _plain([msg]) or None
    if isinstance(outputs, Mapping):
        if "messages" in outputs:
            return _last_text(_messages(outputs["messages"]), "assistant")
        for key in ("output", "answer", "result", "text"):
            if isinstance(outputs.get(key), str):
                return clip(outputs[key])
    return clip(_dumps(outputs)) if outputs not in (None, {}, []) else None


@dataclass
class _Run:
    span_id: str
    root: UUID
    parent: UUID | None
    name: str
    kind: str  # chain | llm | tool | retriever
    start_ns: int
    attributes: dict[str, Any] = field(default_factory=dict)
    end_ns: int | None = None
    error: str | None = None
    input_text: str | None = None
    output_text: str | None = None


class IrisCallbackHandler(BaseCallbackHandler):
    """Sends each top-level LangChain / LangGraph run to Iris as one trace, and asks for its verdict.

    ``recorder``: where the trace goes (default: the process-wide
    ``IrisRecorder``, which finds the server as ``IrisClient`` does).
    ``agent_name``: the agent (``service.name``; default: the running
    program's name). ``session_id``: the conversation
    (``gen_ai.conversation.id``); omitted, a LangGraph ``thread_id`` is used.
    ``run``: the batch (``iris.run``). ``evaluate`` / ``eval_type``: ask for
    a verdict, and which bundle (default: the recorder's — yes, every bundle).
    """

    # Called in order, on the caller's thread, even from async code: the handler only records, never waits.
    run_inline = True
    raise_error = False

    def __init__(
        self,
        *,
        recorder: IrisRecorder | None = None,
        agent_name: str | None = None,
        session_id: str | None = None,
        run: str | None = None,
        evaluate: bool | None = None,
        eval_type: str | None = None,
    ):
        super().__init__()
        self._recorder = recorder
        self.agent_name = agent_name
        self.session_id = session_id
        self.run = run
        self.evaluate = evaluate
        self.eval_type = eval_type
        self._runs: dict[UUID, _Run] = {}
        self._traces: dict[UUID, str] = {}
        self._threads: dict[UUID, str] = {}
        self._lock = threading.Lock()

    @property
    def recorder(self) -> IrisRecorder:
        return self._recorder if self._recorder is not None else default_recorder()

    # ---------- bookkeeping ----------

    def _start(self, run_id: UUID, parent_run_id: UUID | None, name: str, kind: str, attributes: dict[str, Any], metadata: Mapping[str, Any] | None) -> _Run:
        with self._lock:
            parent = self._runs.get(parent_run_id) if parent_run_id is not None else None
            root = parent.root if parent is not None else run_id
            if parent is None:
                self._traces[run_id] = new_trace_id()
            thread = (metadata or {}).get("thread_id")
            if parent is None and isinstance(thread, (str, int)) and str(thread):
                self._threads[run_id] = str(thread)
            run = _Run(new_span_id(), root, parent_run_id if parent is not None else None, name, kind, now_nanos(), attributes)
            self._runs[run_id] = run
            return run

    def _end(self, run_id: UUID, *, error: BaseException | None = None) -> None:
        with self._lock:
            run = self._runs.get(run_id)
            if run is None:
                return
            run.end_ns = now_nanos()
            if error is not None:
                run.error = f"{type(error).__name__}: {error}"
                run.attributes["error.type"] = type(error).__name__
            if run.root != run_id:
                return
            members = [(rid, r) for rid, r in self._runs.items() if r.root == run_id]
            for rid, _ in members:
                del self._runs[rid]
            trace_id = self._traces.pop(run_id)
            thread = self._threads.pop(run_id, None)
        try:
            self._emit(run_id, trace_id, members, thread)
        except Exception:  # recording never fails the run it records
            pass

    def _emit(self, root_id: UUID, trace_id: str, members: list[tuple[UUID, _Run]], thread: str | None) -> None:
        by_id = dict(members)
        root = by_id[root_id]
        end = root.end_ns or now_nanos()
        agent = self.agent_name or program_name()
        spans: list[Span] = []
        for rid, run in members:
            attrs = dict(run.attributes)
            if rid == root_id:
                if run.kind == "chain":
                    attrs["gen_ai.operation.name"] = "invoke_agent"
                    attrs["gen_ai.agent.name"] = agent
                if run.input_text is not None:
                    attrs["iris.input"] = run.input_text
                if run.output_text is not None:
                    attrs["iris.output"] = run.output_text
                session = self.session_id or thread
                if session:
                    attrs["gen_ai.conversation.id"] = session
            parent = by_id.get(run.parent) if run.parent is not None else None
            name = f"invoke_agent {agent}" if rid == root_id and run.kind == "chain" else run.name
            spans.append(
                Span(
                    trace_id=trace_id,
                    span_id=run.span_id,
                    parent_span_id=parent.span_id if parent is not None else None,
                    name=name,
                    start_ns=run.start_ns,
                    end_ns=run.end_ns or end,
                    attributes=attrs,
                    kind=SPAN_KIND_CLIENT if run.kind == "llm" else SPAN_KIND_INTERNAL,
                    status="error" if run.error else ("ok" if run.end_ns else None),
                    status_message=run.error,
                )
            )
        recorder = self.recorder
        extra = {"iris.run": self.run, "iris.framework": "langgraph" if root.attributes.get("langchain.integration") == "langgraph" else "langchain"}
        # A run that raised has no answer to judge: it is stored with its error and not scored.
        evaluate = False if root.error else self.evaluate
        recorder.record(TraceRecord(resource=recorder.resource(agent, extra, evaluate=evaluate, eval_type=self.eval_type), spans=spans))

    # ---------- chains and graphs ----------

    def on_chain_start(self, serialized: dict[str, Any] | None, inputs: Any, *, run_id: UUID, parent_run_id: UUID | None = None, tags: list[str] | None = None, metadata: dict[str, Any] | None = None, **kwargs: Any) -> None:
        try:
            name = kwargs.get("name") or ((serialized or {}).get("name") if isinstance(serialized, Mapping) else None) or "chain"
            attrs: dict[str, Any] = {"langchain.run_type": "chain"}
            node = (metadata or {}).get("langgraph_node")
            if isinstance(node, str):
                attrs["langgraph.node"] = node
            if (metadata or {}).get("ls_integration") == "langgraph":
                attrs["langchain.integration"] = "langgraph"
            run = self._start(run_id, parent_run_id, str(name), "chain", attrs, metadata)
            if run.root == run_id:
                run.input_text = _run_input(inputs)
        except Exception:
            pass

    def on_chain_end(self, outputs: Any, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any) -> None:
        try:
            run = self._runs.get(run_id)
            if run is not None and run.root == run_id:
                run.output_text = _run_output(outputs)
            self._end(run_id)
        except Exception:
            pass

    def on_chain_error(self, error: BaseException, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any) -> None:
        try:
            self._end(run_id, error=error)
        except Exception:
            pass

    # ---------- models ----------

    def _model_attributes(self, serialized: Mapping[str, Any] | None, metadata: Mapping[str, Any] | None, invocation: Mapping[str, Any] | None) -> tuple[str, dict[str, Any]]:
        meta = metadata or {}
        params = invocation or {}
        model = meta.get("ls_model_name") or params.get("model") or params.get("model_name")
        attrs: dict[str, Any] = {"gen_ai.operation.name": "chat", "langchain.run_type": "llm"}
        if isinstance(meta.get("ls_provider"), str):
            attrs["gen_ai.provider.name"] = meta["ls_provider"]
        if isinstance(model, str) and model:
            attrs["gen_ai.request.model"] = model
        for key, attr in (("ls_temperature", "gen_ai.request.temperature"), ("ls_max_tokens", "gen_ai.request.max_tokens")):
            value = meta.get(key)
            if isinstance(value, (int, float)) and not isinstance(value, bool):
                attrs[attr] = value
        tools = params.get("tools")
        if isinstance(tools, list) and tools:
            defs = []
            for t in tools:
                fn = t.get("function") if isinstance(t, Mapping) and isinstance(t.get("function"), Mapping) else t
                if isinstance(fn, Mapping) and fn.get("name"):
                    d = {"type": "function", "name": fn["name"]}
                    if fn.get("description"):
                        d["description"] = fn["description"]
                    schema = fn.get("parameters") or fn.get("input_schema")
                    if schema:
                        d["parameters"] = schema
                    defs.append(d)
            if defs:
                attrs["gen_ai.tool.definitions"] = _dumps(defs)
        name = f"chat {model}" if isinstance(model, str) and model else "chat"
        return name, attrs

    def on_chat_model_start(self, serialized: dict[str, Any] | None, messages: list[list[Any]], *, run_id: UUID, parent_run_id: UUID | None = None, tags: list[str] | None = None, metadata: dict[str, Any] | None = None, **kwargs: Any) -> None:
        try:
            name, attrs = self._model_attributes(serialized, metadata, kwargs.get("invocation_params"))
            conversation = _messages(messages[0] if messages else [])
            system = [p for m in conversation if m["role"] == "system" for p in m["parts"]]
            rest = [m for m in conversation if m["role"] != "system"]
            if rest:
                attrs["gen_ai.input.messages"] = _dumps(rest)
            if system:
                attrs["gen_ai.system_instructions"] = _dumps(system)
            run = self._start(run_id, parent_run_id, name, "llm", attrs, metadata)
            if run.root == run_id:
                run.input_text = _last_text(conversation, "user")
        except Exception:
            pass

    def on_llm_start(self, serialized: dict[str, Any] | None, prompts: list[str], *, run_id: UUID, parent_run_id: UUID | None = None, tags: list[str] | None = None, metadata: dict[str, Any] | None = None, **kwargs: Any) -> None:
        try:
            name, attrs = self._model_attributes(serialized, metadata, kwargs.get("invocation_params"))
            if prompts:
                attrs["gen_ai.input.messages"] = _dumps([{"role": "user", "parts": [{"type": "text", "content": clip(p)}]} for p in prompts])
            run = self._start(run_id, parent_run_id, name, "llm", attrs, metadata)
            if run.root == run_id and prompts:
                run.input_text = clip(prompts[-1])
        except Exception:
            pass

    def on_llm_end(self, response: Any, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any) -> None:
        try:
            run = self._runs.get(run_id)
            if run is not None:
                self._read_result(run, response)
            self._end(run_id)
        except Exception:
            pass

    def _read_result(self, run: _Run, response: Any) -> None:
        generations = getattr(response, "generations", None) or []
        first = generations[0][0] if generations and generations[0] else None
        message = getattr(first, "message", None)
        output = _message(message) if message is not None else ({"role": "assistant", "parts": _parts_of(getattr(first, "text", ""))} if first is not None else None)
        meta = getattr(message, "response_metadata", None) or {}
        info = getattr(first, "generation_info", None) or {}
        finish = meta.get("finish_reason") or meta.get("stop_reason") or info.get("finish_reason")
        if output is not None:
            if isinstance(finish, str):
                output["finish_reason"] = {"tool_calls": "tool_call", "tool_use": "tool_call", "end_turn": "stop", "max_tokens": "length"}.get(finish, finish)
            run.attributes["gen_ai.output.messages"] = _dumps([output])
            text = _plain([output])
            calls = [p for p in output["parts"] if p.get("type") == "tool_call"]
            run.output_text = text or (_dumps([{"tool": c["name"], "arguments": c.get("arguments", {})} for c in calls]) if calls else None)
        if isinstance(finish, str):
            run.attributes["gen_ai.response.finish_reasons"] = [finish]
        model = meta.get("model_name") or meta.get("model")
        if isinstance(model, str) and model:
            run.attributes["gen_ai.response.model"] = model
        response_id = getattr(message, "id", None) or meta.get("id")
        if isinstance(response_id, str) and response_id and not response_id.startswith("run-") and not response_id.startswith("lc_run"):
            run.attributes["gen_ai.response.id"] = response_id
        usage = getattr(message, "usage_metadata", None)
        if isinstance(usage, Mapping):
            _put_usage(run.attributes, usage.get("input_tokens"), usage.get("output_tokens"))
            details = usage.get("input_token_details") or {}
            if isinstance(details, Mapping):
                _put_int(run.attributes, "gen_ai.usage.cache_read.input_tokens", details.get("cache_read"))
                _put_int(run.attributes, "gen_ai.usage.cache_creation.input_tokens", details.get("cache_creation"))
            out_details = usage.get("output_token_details") or {}
            if isinstance(out_details, Mapping):
                _put_int(run.attributes, "gen_ai.usage.reasoning.output_tokens", out_details.get("reasoning"))
        else:
            llm_output = getattr(response, "llm_output", None) or {}
            tokens = llm_output.get("token_usage") or llm_output.get("usage") or {}
            if isinstance(tokens, Mapping):
                _put_usage(run.attributes, tokens.get("prompt_tokens", tokens.get("input_tokens")), tokens.get("completion_tokens", tokens.get("output_tokens")))

    def on_llm_error(self, error: BaseException, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any) -> None:
        try:
            self._end(run_id, error=error)
        except Exception:
            pass

    # ---------- tools ----------

    def on_tool_start(self, serialized: dict[str, Any] | None, input_str: str, *, run_id: UUID, parent_run_id: UUID | None = None, tags: list[str] | None = None, metadata: dict[str, Any] | None = None, inputs: dict[str, Any] | None = None, **kwargs: Any) -> None:
        try:
            tool = kwargs.get("name") or ((serialized or {}).get("name") if isinstance(serialized, Mapping) else None) or "tool"
            attrs: dict[str, Any] = {"gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": str(tool), "langchain.run_type": "tool"}
            description = (serialized or {}).get("description") if isinstance(serialized, Mapping) else None
            if isinstance(description, str) and description:
                attrs["gen_ai.tool.description"] = clip(description, 1000)
            call_id = kwargs.get("tool_call_id")
            if isinstance(call_id, str) and call_id:
                attrs["gen_ai.tool.call.id"] = call_id
            arguments = inputs if inputs is not None else input_str
            attrs["gen_ai.tool.call.arguments"] = arguments if isinstance(arguments, str) else _dumps(arguments)
            self._start(run_id, parent_run_id, f"execute_tool {tool}", "tool", attrs, metadata)
        except Exception:
            pass

    def on_tool_end(self, output: Any, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any) -> None:
        try:
            run = self._runs.get(run_id)
            if run is not None:
                content = getattr(output, "content", output)
                result = content if isinstance(content, str) else _text_of(content) or _dumps(content)
                run.attributes["gen_ai.tool.call.result"] = clip(result)
                if run.root == run_id:
                    run.output_text = clip(result)
            self._end(run_id)
        except Exception:
            pass

    def on_tool_error(self, error: BaseException, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any) -> None:
        try:
            run = self._runs.get(run_id)
            if run is not None:
                run.attributes["gen_ai.tool.call.result"] = clip(f"{type(error).__name__}: {error}")
            self._end(run_id, error=error)
        except Exception:
            pass

    # ---------- retrievers ----------

    def on_retriever_start(self, serialized: dict[str, Any] | None, query: str, *, run_id: UUID, parent_run_id: UUID | None = None, tags: list[str] | None = None, metadata: dict[str, Any] | None = None, **kwargs: Any) -> None:
        try:
            name = kwargs.get("name") or ((serialized or {}).get("name") if isinstance(serialized, Mapping) else None) or "retriever"
            run = self._start(run_id, parent_run_id, f"retrieve {name}", "retriever", {"langchain.run_type": "retriever", "retriever.query": clip(query)}, metadata)
            if run.root == run_id:
                run.input_text = clip(query)
        except Exception:
            pass

    def on_retriever_end(self, documents: Sequence[Any], *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any) -> None:
        try:
            run = self._runs.get(run_id)
            if run is not None:
                run.attributes["retriever.documents"] = len(documents)
            self._end(run_id)
        except Exception:
            pass

    def on_retriever_error(self, error: BaseException, *, run_id: UUID, parent_run_id: UUID | None = None, **kwargs: Any) -> None:
        try:
            self._end(run_id, error=error)
        except Exception:
            pass


def _put_int(attrs: dict[str, Any], key: str, value: Any) -> None:
    if isinstance(value, int) and not isinstance(value, bool):
        attrs[key] = value


def _put_usage(attrs: dict[str, Any], input_tokens: Any, output_tokens: Any) -> None:
    _put_int(attrs, "gen_ai.usage.input_tokens", input_tokens)
    _put_int(attrs, "gen_ai.usage.output_tokens", output_tokens)
