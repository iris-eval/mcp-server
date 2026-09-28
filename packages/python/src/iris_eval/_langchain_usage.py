"""One model call's usage → the span's GenAI usage attributes.

LangChain's ``usage_metadata`` is the same shape in every integration, but the
prompt-cache details are not. langchain-anthropic (Python) moves Anthropic's
cache-write lifetimes into ``input_token_details`` (``ephemeral_5m_input_tokens``,
``ephemeral_1h_input_tokens``) and then sets ``cache_creation`` to 0 so the writes
are not counted twice; @langchain/anthropic (JavaScript) keeps ``cache_creation``
and leaves the lifetimes in the raw Anthropic usage under
``response_metadata["usage"]``. Both shapes are read here, and by the JavaScript
handler's twin (packages/langchain/src/usage.ts): tests/fixtures/langchain-usage-parity
holds the two to the same attributes.

The cache counts are a part of ``input_tokens``, which LangChain already totals
with them, as the GenAI conventions count them. The 1-hour writes go out as
``iris.usage.cache_creation.ephemeral_1h_input_tokens``, the name the provider
wrappers use; no GenAI convention names the lifetime yet.

No LangChain import: the mapping is testable without ``langchain-core``.
"""

from __future__ import annotations

from typing import Any, Mapping


def _int(v: Any) -> int | None:
    return v if isinstance(v, int) and not isinstance(v, bool) and v >= 0 else None


def _mapping(v: Any) -> Mapping[str, Any]:
    return v if isinstance(v, Mapping) else {}


def usage_attributes(usage_metadata: Any, response_metadata: Any) -> dict[str, int]:
    out: dict[str, int] = {}
    if not isinstance(usage_metadata, Mapping):
        return out

    def put(key: str, v: int | None) -> None:
        if v is not None:
            out[key] = v

    put("gen_ai.usage.input_tokens", _int(usage_metadata.get("input_tokens")))
    put("gen_ai.usage.output_tokens", _int(usage_metadata.get("output_tokens")))

    details = _mapping(usage_metadata.get("input_token_details"))
    raw = _mapping(_mapping(_mapping(response_metadata).get("usage")).get("cache_creation"))
    put("gen_ai.usage.cache_read.input_tokens", _int(details.get("cache_read")))

    # The lifetimes: in input_token_details (Python), else in the raw usage (JavaScript).
    write_5m = _int(details.get("ephemeral_5m_input_tokens"))
    if write_5m is None:
        write_5m = _int(raw.get("ephemeral_5m_input_tokens"))
    write_1h = _int(details.get("ephemeral_1h_input_tokens"))
    if write_1h is None:
        write_1h = _int(raw.get("ephemeral_1h_input_tokens"))
    creation = _int(details.get("cache_creation"))
    split = (write_5m or 0) + (write_1h or 0) if write_5m is not None or write_1h is not None else None
    # When the lifetimes carry the writes, cache_creation may have been zeroed to avoid counting them twice.
    writes = split if creation is None else creation if split is None else max(creation, split)
    put("gen_ai.usage.cache_creation.input_tokens", writes)
    put("iris.usage.cache_creation.ephemeral_1h_input_tokens", write_1h)

    put("gen_ai.usage.reasoning.output_tokens", _int(_mapping(usage_metadata.get("output_token_details")).get("reasoning")))
    return out
