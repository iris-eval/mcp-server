"""One model call → the attributes of an OpenTelemetry GenAI ``chat`` span.

Three provider APIs, read from their own wire shapes: OpenAI Chat
Completions, OpenAI Responses and Anthropic Messages. The request is the
JSON body the SDK sends; the response is the body it received, or, for a
stream, the same body assembled from its events — so a streamed call and a
plain one become the same span.

The attributes are the GenAI semantic conventions
(https://opentelemetry.io/docs/specs/semconv/gen-ai/): the provider, the
request parameters, the response id, model and finish reasons, the usage,
the tool catalogue, and the messages as ``gen_ai.input.messages`` /
``gen_ai.output.messages`` / ``gen_ai.system_instructions`` in the
conventions' JSON schema. Beside them, ``iris.input`` and ``iris.output``
carry the plain text Iris scores — the last thing the user asked and what
the model answered.

The JavaScript package (``@iris-eval/sdk``, ``src/genai.ts``) maps the same
three APIs the same way; the two are held to the same span by their tests.
"""

from __future__ import annotations

import json
from typing import Any, Mapping

Json = dict[str, Any]
Part = dict[str, Any]
Message = dict[str, Any]

#: Longest a single text part may be before it is cut, so one call cannot outgrow the ingest body limit.
MAX_PART_CHARS = 16_384

PROVIDER = {"chat": "openai", "responses": "openai", "messages": "anthropic"}


def clip(text: str, limit: int = MAX_PART_CHARS) -> str:
    if len(text) <= limit:
        return text
    return f"{text[:limit]}… [{len(text) - limit} more characters not recorded]"


def _parse_arguments(raw: Any) -> Any:
    if not isinstance(raw, str):
        return raw
    try:
        return json.loads(raw)
    except ValueError:
        return raw


def _str(v: Any) -> str | None:
    return v if isinstance(v, str) else None


def _num(v: Any) -> int | float | None:
    return v if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def _other(kind: Any) -> Part:
    """A part that is not text is named by its type and never carried: an image's bytes do not belong in a trace."""
    return {"type": kind if isinstance(kind, str) and kind else "unknown"}


def _clip_value(v: Any) -> Any:
    return clip(v) if isinstance(v, str) else v


# ---------- input ----------


def _content_parts(content: Any) -> list[Part]:
    if isinstance(content, str):
        return [{"type": "text", "content": clip(content)}]
    if not isinstance(content, list):
        return []
    parts: list[Part] = []
    for p in content:
        if isinstance(p, str):
            parts.append({"type": "text", "content": clip(p)})
        elif isinstance(p, Mapping) and p.get("type") in ("text", "input_text", "output_text") and isinstance(p.get("text"), str):
            parts.append({"type": "text", "content": clip(p["text"])})
        elif isinstance(p, Mapping) and p.get("type") == "refusal" and isinstance(p.get("refusal"), str):
            parts.append({"type": "text", "content": clip(p["refusal"])})
        else:
            parts.append(_other(p.get("type") if isinstance(p, Mapping) else None))
    return parts


def _tool_call(call: Any) -> Part | None:
    if isinstance(call, Mapping) and isinstance(call.get("function"), Mapping):
        fn = call["function"]
        return {"type": "tool_call", "id": _str(call.get("id")), "name": str(fn.get("name") or ""), "arguments": _parse_arguments(fn.get("arguments"))}
    return None


def _chat_input(body: Mapping[str, Any]) -> list[Message]:
    out: list[Message] = []
    for m in body.get("messages") or []:
        if not isinstance(m, Mapping):
            continue
        role = _str(m.get("role")) or "user"
        if role == "tool":
            out.append({"role": "tool", "parts": [{"type": "tool_call_response", "id": _str(m.get("tool_call_id")), "response": _clip_value(m.get("content"))}]})
            continue
        parts = _content_parts(m.get("content"))
        for call in m.get("tool_calls") or []:
            part = _tool_call(call)
            if part:
                parts.append(part)
        out.append({"role": role, "parts": parts})
    return out


def _responses_input(body: Mapping[str, Any]) -> list[Message]:
    given = body.get("input")
    if isinstance(given, str):
        return [{"role": "user", "parts": [{"type": "text", "content": clip(given)}]}]
    out: list[Message] = []
    for item in given if isinstance(given, list) else []:
        if not isinstance(item, Mapping):
            continue
        kind = item.get("type")
        if kind == "function_call":
            out.append({"role": "assistant", "parts": [{"type": "tool_call", "id": _str(item.get("call_id")), "name": str(item.get("name") or ""), "arguments": _parse_arguments(item.get("arguments"))}]})
        elif kind == "function_call_output":
            out.append({"role": "tool", "parts": [{"type": "tool_call_response", "id": _str(item.get("call_id")), "response": _clip_value(item.get("output"))}]})
        elif kind is None or kind == "message":
            out.append({"role": _str(item.get("role")) or "user", "parts": _content_parts(item.get("content"))})
        else:
            out.append({"role": "user", "parts": [_other(kind)]})
    return out


def _anthropic_blocks(content: Any) -> list[Part]:
    if isinstance(content, str):
        return [{"type": "text", "content": clip(content)}]
    if not isinstance(content, list):
        return []
    parts: list[Part] = []
    for b in content:
        if not isinstance(b, Mapping):
            parts.append(_other(None))
            continue
        kind = b.get("type")
        if kind == "text" and isinstance(b.get("text"), str):
            parts.append({"type": "text", "content": clip(b["text"])})
        elif kind == "thinking" and isinstance(b.get("thinking"), str):
            parts.append({"type": "reasoning", "content": clip(b["thinking"])})
        elif kind in ("tool_use", "server_tool_use"):
            parts.append({"type": "tool_call", "id": _str(b.get("id")), "name": str(b.get("name") or ""), "arguments": b.get("input")})
        elif kind == "tool_result":
            inner = b.get("content")
            response = clip(inner) if isinstance(inner, str) else _anthropic_blocks(inner) if isinstance(inner, list) else inner
            parts.append({"type": "tool_call_response", "id": _str(b.get("tool_use_id")), "response": response})
        else:
            parts.append(_other(kind))
    return parts


def _anthropic_input(body: Mapping[str, Any]) -> list[Message]:
    out: list[Message] = []
    for m in body.get("messages") or []:
        if not isinstance(m, Mapping):
            continue
        parts = _anthropic_blocks(m.get("content"))
        role = _str(m.get("role")) or "user"
        # A user turn made only of tool results is the tool speaking, as the other two APIs say it.
        if role == "user" and parts and all(p["type"] == "tool_call_response" for p in parts):
            role = "tool"
        out.append({"role": role, "parts": parts})
    return out


def input_messages(api: str, body: Mapping[str, Any]) -> list[Message]:
    if api == "chat":
        return _chat_input(body)
    if api == "responses":
        return _responses_input(body)
    return _anthropic_input(body)


def system_instructions(api: str, body: Mapping[str, Any]) -> list[Part] | None:
    if api == "messages" and body.get("system") is not None:
        parts = _anthropic_blocks(body["system"])
        return parts or None
    if api == "responses" and isinstance(body.get("instructions"), str):
        return [{"type": "text", "content": clip(body["instructions"])}]
    return None


# ---------- output ----------

CHAT_FINISH = {"stop": "stop", "length": "length", "content_filter": "content_filter", "tool_calls": "tool_call", "function_call": "tool_call"}
ANTHROPIC_FINISH = {
    "end_turn": "stop",
    "stop_sequence": "stop",
    "pause_turn": "stop",
    "max_tokens": "length",
    "model_context_window_exceeded": "length",
    "tool_use": "tool_call",
    "refusal": "content_filter",
}


def _responses_finish(response: Mapping[str, Any], parts: list[Part]) -> str | None:
    details = response.get("incomplete_details")
    incomplete = _str(details.get("reason")) if isinstance(details, Mapping) else None
    if incomplete == "max_output_tokens":
        return "length"
    if incomplete == "content_filter":
        return "content_filter"
    if response.get("status") == "failed":
        return "error"
    if response.get("status") != "completed":
        return None
    return "tool_call" if any(p["type"] == "tool_call" for p in parts) else "stop"


def output_messages(api: str, response: Mapping[str, Any]) -> list[Message]:
    if api == "chat":
        out: list[Message] = []
        for choice in response.get("choices") or []:
            if not isinstance(choice, Mapping):
                continue
            message = choice.get("message") if isinstance(choice.get("message"), Mapping) else {}
            parts = _content_parts(message.get("content"))
            if not parts and isinstance(message.get("refusal"), str):
                parts.append({"type": "text", "content": clip(message["refusal"])})
            for call in message.get("tool_calls") or []:
                part = _tool_call(call)
                if part:
                    parts.append(part)
            msg: Message = {"role": "assistant", "parts": parts}
            reason = _str(choice.get("finish_reason"))
            if reason:
                msg["finish_reason"] = CHAT_FINISH.get(reason, reason)
            out.append(msg)
        return out
    if api == "responses":
        parts: list[Part] = []
        for item in response.get("output") or []:
            if not isinstance(item, Mapping):
                continue
            kind = item.get("type")
            if kind == "message":
                parts.extend(_content_parts(item.get("content")))
            elif kind == "function_call":
                parts.append({"type": "tool_call", "id": _str(item.get("call_id")), "name": str(item.get("name") or ""), "arguments": _parse_arguments(item.get("arguments"))})
            elif kind == "reasoning":
                summary = "\n".join(s["text"] for s in item.get("summary") or [] if isinstance(s, Mapping) and isinstance(s.get("text"), str))
                if summary:
                    parts.append({"type": "reasoning", "content": clip(summary)})
            else:
                parts.append(_other(kind))
        finish = _responses_finish(response, parts)
        if not parts and not finish:
            return []
        msg = {"role": "assistant", "parts": parts}
        if finish:
            msg["finish_reason"] = finish
        return [msg]
    parts = _anthropic_blocks(response.get("content"))
    reason = _str(response.get("stop_reason"))
    if not parts and not reason:
        return []
    msg = {"role": "assistant", "parts": parts}
    if reason:
        msg["finish_reason"] = ANTHROPIC_FINISH.get(reason, reason)
    return [msg]


def _raw_finish_reasons(api: str, response: Mapping[str, Any]) -> list[str]:
    if api == "chat":
        return [c["finish_reason"] for c in response.get("choices") or [] if isinstance(c, Mapping) and isinstance(c.get("finish_reason"), str)]
    if api == "messages":
        return [response["stop_reason"]] if isinstance(response.get("stop_reason"), str) else []
    details = response.get("incomplete_details")
    incomplete = _str(details.get("reason")) if isinstance(details, Mapping) else None
    if incomplete:
        return [incomplete]
    return [response["status"]] if isinstance(response.get("status"), str) else []


# ---------- the plain text Iris scores ----------


def _text_of(parts: list[Part]) -> str:
    return "\n".join(p["content"] for p in parts if p.get("type") == "text" and isinstance(p.get("content"), str))


def input_text(messages: list[Message]) -> str | None:
    """The last thing the user asked, in words: the last user message that carries text, else the last message that does."""
    with_text = [m for m in messages if _text_of(m["parts"])]
    users = [m for m in with_text if m["role"] == "user"]
    chosen = users[-1] if users else (with_text[-1] if with_text else None)
    return _text_of(chosen["parts"]) if chosen else None


def output_text(messages: list[Message]) -> str | None:
    """What the model answered, in words; a turn that only asks for tools is those requests, written out."""
    if not messages:
        return None
    first = messages[0]
    text = _text_of(first["parts"])
    if text:
        return text
    calls = [p for p in first["parts"] if p.get("type") == "tool_call"]
    if calls:
        return json.dumps([{"tool": c["name"], "arguments": c.get("arguments") if c.get("arguments") is not None else {}} for c in calls], separators=(",", ":"), ensure_ascii=False)
    return None


# ---------- tools and usage ----------


def _tool_definitions(api: str, body: Mapping[str, Any]) -> list[Json] | None:
    tools = [t for t in body.get("tools") or [] if isinstance(t, Mapping)]
    if not tools:
        return None
    out: list[Json] = []
    for t in tools:
        if api == "chat" and isinstance(t.get("function"), Mapping):
            fn = t["function"]
            d: Json = {"type": "function", "name": fn.get("name")}
            if fn.get("description"):
                d["description"] = fn["description"]
            if fn.get("parameters"):
                d["parameters"] = fn["parameters"]
        elif api == "messages":
            d = {"type": "function", "name": t.get("name") or t.get("type")}
            if t.get("description"):
                d["description"] = t["description"]
            if t.get("input_schema"):
                d["parameters"] = t["input_schema"]
        else:
            d = {"type": t.get("type") or "function", "name": t.get("name") or t.get("type")}
            if t.get("description"):
                d["description"] = t["description"]
            if t.get("parameters"):
                d["parameters"] = t["parameters"]
        out.append(d)
    return out


def _usage(api: str, response: Mapping[str, Any]) -> dict[str, int | float | None]:
    u = response.get("usage")
    if not isinstance(u, Mapping):
        return {}
    details = lambda key, inner: _num(u[key].get(inner)) if isinstance(u.get(key), Mapping) else None  # noqa: E731
    if api == "chat":
        return {
            "input": _num(u.get("prompt_tokens")),
            "output": _num(u.get("completion_tokens")),
            "cache_read": details("prompt_tokens_details", "cached_tokens"),
            "reasoning": details("completion_tokens_details", "reasoning_tokens"),
        }
    if api == "responses":
        return {
            "input": _num(u.get("input_tokens")),
            "output": _num(u.get("output_tokens")),
            "cache_read": details("input_tokens_details", "cached_tokens"),
            "reasoning": details("output_tokens_details", "reasoning_tokens"),
        }
    # Anthropic counts cached tokens beside input_tokens; the conventions count them inside it.
    cache_read = _num(u.get("cache_read_input_tokens"))
    cache_creation = _num(u.get("cache_creation_input_tokens"))
    given = _num(u.get("input_tokens"))
    return {
        "input": None if given is None else given + (cache_read or 0) + (cache_creation or 0),
        "output": _num(u.get("output_tokens")),
        "cache_read": cache_read,
        "cache_creation": cache_creation,
    }


def _request_attributes(api: str, body: Mapping[str, Any]) -> Json:
    a: Json = {}

    def put(key: str, v: Any) -> None:
        if isinstance(v, bool):
            return
        if isinstance(v, (int, float)) or (isinstance(v, str) and v):
            a[key] = v

    put("gen_ai.request.model", body.get("model"))
    if api == "chat":
        put("gen_ai.request.max_tokens", body.get("max_completion_tokens", body.get("max_tokens")))
    elif api == "responses":
        put("gen_ai.request.max_tokens", body.get("max_output_tokens"))
    else:
        put("gen_ai.request.max_tokens", body.get("max_tokens"))
    for key in ("temperature", "top_p", "top_k", "frequency_penalty", "presence_penalty", "seed"):
        put(f"gen_ai.request.{key}", body.get(key))
    n = body.get("n")
    if isinstance(n, int) and not isinstance(n, bool) and n != 1:
        a["gen_ai.request.choice.count"] = n
    stops = body.get("stop_sequences") if api == "messages" else body.get("stop")
    if isinstance(stops, str):
        a["gen_ai.request.stop_sequences"] = [stops]
    elif isinstance(stops, list) and stops and all(isinstance(s, str) for s in stops):
        a["gen_ai.request.stop_sequences"] = list(stops)
    return a


def _without_none(value: Any) -> Any:
    """A key with no value is left out, as JSON.stringify leaves out undefined: the two languages write one shape."""
    if isinstance(value, dict):
        return {k: _without_none(v) for k, v in value.items() if v is not None}
    if isinstance(value, list):
        return [_without_none(v) for v in value]
    return value


def _dumps(value: Any) -> str:
    return json.dumps(_without_none(value), separators=(",", ":"), ensure_ascii=False, default=str)


def genai_span(
    api: str,
    request: Mapping[str, Any],
    response: Mapping[str, Any] | None = None,
    *,
    error: tuple[str, str] | None = None,
    server_address: str | None = None,
    server_port: int | None = None,
    extra: Mapping[str, Any] | None = None,
) -> tuple[str, Json]:
    """The span for one call: its name and its attributes. ``error`` is ``(type, message)`` when the call failed."""
    model = request.get("model") if isinstance(request.get("model"), str) else None
    attrs: Json = {"gen_ai.operation.name": "chat", "gen_ai.provider.name": PROVIDER[api], **_request_attributes(api, request)}
    if server_address:
        attrs["server.address"] = server_address
    if server_port is not None:
        attrs["server.port"] = server_port

    messages = input_messages(api, request)
    if messages:
        attrs["gen_ai.input.messages"] = _dumps(messages)
    system = system_instructions(api, request)
    if system:
        attrs["gen_ai.system_instructions"] = _dumps(system)
    tools = _tool_definitions(api, request)
    if tools:
        attrs["gen_ai.tool.definitions"] = _dumps(tools)
    asked = input_text(messages)
    if asked is not None:
        attrs["iris.input"] = asked

    if response is not None:
        if isinstance(response.get("id"), str):
            attrs["gen_ai.response.id"] = response["id"]
        if isinstance(response.get("model"), str):
            attrs["gen_ai.response.model"] = response["model"]
        reasons = _raw_finish_reasons(api, response)
        if reasons:
            attrs["gen_ai.response.finish_reasons"] = reasons
        usage = _usage(api, response)
        for key, attr in (
            ("input", "gen_ai.usage.input_tokens"),
            ("output", "gen_ai.usage.output_tokens"),
            ("cache_read", "gen_ai.usage.cache_read.input_tokens"),
            ("cache_creation", "gen_ai.usage.cache_creation.input_tokens"),
            ("reasoning", "gen_ai.usage.reasoning.output_tokens"),
        ):
            if usage.get(key) is not None:
                attrs[attr] = usage[key]
        output = output_messages(api, response)
        if output:
            attrs["gen_ai.output.messages"] = _dumps(output)
        answered = output_text(output)
        if answered is not None:
            attrs["iris.output"] = answered
    if error is not None:
        attrs["error.type"] = error[0]
    if extra:
        attrs.update(extra)
    return (f"chat {model}" if model else "chat"), attrs


# ---------- streams, assembled into the body a plain call returns ----------


class ChatAssembler:
    def __init__(self) -> None:
        self.head: Json | None = None
        self.usage: Any = None
        self.choices: dict[int, Json] = {}

    def add(self, chunk: Mapping[str, Any]) -> None:
        if self.head is None:
            self.head = {k: chunk.get(k) for k in ("id", "model", "created", "system_fingerprint")}
            self.head["object"] = "chat.completion"
        if isinstance(chunk.get("usage"), Mapping):
            self.usage = chunk["usage"]
        for c in chunk.get("choices") or []:
            if not isinstance(c, Mapping):
                continue
            index = c.get("index") if isinstance(c.get("index"), int) else 0
            slot = self.choices.setdefault(index, {"content": "", "refusal": "", "role": "assistant", "finish": None, "calls": {}})
            delta = c.get("delta") if isinstance(c.get("delta"), Mapping) else {}
            if isinstance(delta.get("role"), str):
                slot["role"] = delta["role"]
            if isinstance(delta.get("content"), str):
                slot["content"] += delta["content"]
            if isinstance(delta.get("refusal"), str):
                slot["refusal"] += delta["refusal"]
            for tc in delta.get("tool_calls") or []:
                if not isinstance(tc, Mapping):
                    continue
                ti = tc.get("index") if isinstance(tc.get("index"), int) else 0
                call = slot["calls"].setdefault(ti, {"id": None, "name": "", "args": ""})
                if isinstance(tc.get("id"), str):
                    call["id"] = tc["id"]
                fn = tc.get("function")
                if isinstance(fn, Mapping):
                    if isinstance(fn.get("name"), str):
                        call["name"] += fn["name"]
                    if isinstance(fn.get("arguments"), str):
                        call["args"] += fn["arguments"]
            if isinstance(c.get("finish_reason"), str):
                slot["finish"] = c["finish_reason"]

    def result(self) -> Json | None:
        if self.head is None:
            return None
        choices = []
        for index in sorted(self.choices):
            s = self.choices[index]
            message: Json = {"role": s["role"], "content": s["content"] or None}
            if s["refusal"]:
                message["refusal"] = s["refusal"]
            if s["calls"]:
                message["tool_calls"] = [{"id": c["id"], "type": "function", "function": {"name": c["name"], "arguments": c["args"]}} for _, c in sorted(s["calls"].items())]
            choices.append({"index": index, "message": message, "finish_reason": s["finish"]})
        out = {**self.head, "choices": choices}
        if self.usage is not None:
            out["usage"] = self.usage
        return out


class ResponsesAssembler:
    def __init__(self) -> None:
        self.latest: Json | None = None
        self.text = ""

    def add(self, event: Mapping[str, Any]) -> None:
        if isinstance(event.get("response"), Mapping):
            self.latest = dict(event["response"])
        if event.get("type") == "response.output_text.delta" and isinstance(event.get("delta"), str):
            self.text += event["delta"]

    def result(self) -> Json | None:
        if self.latest is None:
            return None
        # A stream cut short has no final response: keep the words that did arrive.
        if self.latest.get("output") or not self.text:
            return self.latest
        return {**self.latest, "output": [{"type": "message", "role": "assistant", "content": [{"type": "output_text", "text": self.text}]}]}


class AnthropicAssembler:
    def __init__(self) -> None:
        self.message: Json | None = None
        self.blocks: dict[int, Json] = {}
        self.partial_json: dict[int, str] = {}
        self.stopped: set[int] = set()

    def add(self, event: Mapping[str, Any]) -> None:
        kind = event.get("type")
        if kind == "message_start" and isinstance(event.get("message"), Mapping):
            self.message = {**event["message"], "content": [], "usage": dict(event["message"].get("usage") or {})}
        elif kind == "content_block_start" and isinstance(event.get("content_block"), Mapping):
            self.blocks[event.get("index", len(self.blocks))] = dict(event["content_block"])
        elif kind == "content_block_delta":
            i = event.get("index", 0)
            block = self.blocks.get(i)
            d = event.get("delta") if isinstance(event.get("delta"), Mapping) else {}
            if block is None:
                return
            if d.get("type") == "text_delta" and isinstance(d.get("text"), str):
                block["text"] = (block.get("text") or "") + d["text"]
            elif d.get("type") == "thinking_delta" and isinstance(d.get("thinking"), str):
                block["thinking"] = (block.get("thinking") or "") + d["thinking"]
            elif d.get("type") == "input_json_delta" and isinstance(d.get("partial_json"), str):
                self.partial_json[i] = self.partial_json.get(i, "") + d["partial_json"]
        elif kind == "content_block_stop":
            i = event.get("index", 0)
            self.stopped.add(i)
            raw = self.partial_json.get(i)
            if raw is not None and i in self.blocks:
                try:
                    self.blocks[i]["input"] = json.loads(raw)
                except ValueError:
                    self.blocks[i]["input"] = raw
        elif kind == "message_delta" and self.message is not None:
            d = event.get("delta")
            if isinstance(d, Mapping):
                if "stop_reason" in d and d["stop_reason"] is not None:
                    self.message["stop_reason"] = d["stop_reason"]
                if "stop_sequence" in d:
                    self.message["stop_sequence"] = d["stop_sequence"]
            if isinstance(event.get("usage"), Mapping):
                for k, v in event["usage"].items():
                    if v is not None:
                        self.message["usage"][k] = v

    def result(self) -> Json | None:
        if self.message is None:
            return None
        # A tool_use block still waiting for its stop keeps whatever JSON arrived.
        for i, raw in self.partial_json.items():
            if i in self.blocks and i not in self.stopped:
                self.blocks[i]["input"] = raw
        return {**self.message, "content": [self.blocks[i] for i in sorted(self.blocks)]}


def assembler_for(api: str) -> ChatAssembler | ResponsesAssembler | AnthropicAssembler:
    if api == "chat":
        return ChatAssembler()
    if api == "responses":
        return ResponsesAssembler()
    return AnthropicAssembler()
