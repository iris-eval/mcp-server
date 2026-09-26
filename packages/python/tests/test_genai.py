"""One mapping, two languages: every case in tests/fixtures/genai-parity (at
the repository root) becomes the span in expected.json — here, and in the
JavaScript package's own test — so a call recorded from either language reads
the same in Iris. Then the edges the end-to-end run does not reach.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from iris_eval._genai import assembler_for, genai_span, input_messages

PARITY = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "genai-parity"
CASES = json.loads((PARITY / "cases.json").read_text(encoding="utf-8"))["cases"]
EXPECTED = {e["name"]: e["span"] for e in json.loads((PARITY / "expected.json").read_text(encoding="utf-8"))}


def test_the_expectation_covers_every_case() -> None:
    assert list(EXPECTED) == [c["name"] for c in CASES]


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_the_span_matches_the_javascript_mapping(case: dict) -> None:
    error = tuple(case["error"]) if case.get("error") else None
    name, attrs = genai_span(case["api"], case["request"], case.get("response"), error=error)  # type: ignore[arg-type]
    assert {"name": name, "attributes": attrs} == EXPECTED[case["name"]]


def test_an_image_is_named_by_its_type_and_its_bytes_never_leave() -> None:
    messages = input_messages("chat", {"messages": [{"role": "user", "content": [{"type": "text", "text": "What is this?"}, {"type": "image_url", "image_url": {"url": "data:image/png;base64,AAAA"}}]}]})
    assert messages[0]["parts"] == [{"type": "text", "content": "What is this?"}, {"type": "image_url"}]


def test_a_long_text_part_is_cut_and_says_how_much_was_left_out() -> None:
    _, attrs = genai_span("chat", {"model": "m", "messages": [{"role": "user", "content": "x" * 20_000}]})
    assert attrs["iris.input"].endswith("… [3616 more characters not recorded]")
    assert len(attrs["iris.input"]) < 17_000


def test_a_stream_cut_short_keeps_what_arrived() -> None:
    chat = assembler_for("chat")
    chat.add({"id": "c1", "model": "m", "choices": [{"index": 0, "delta": {"role": "assistant", "content": "The capital"}}]})
    assert chat.result()["choices"][0]["message"]["content"] == "The capital"

    anthropic = assembler_for("messages")
    anthropic.add({"type": "message_start", "message": {"id": "m1", "model": "c", "usage": {"input_tokens": 3, "output_tokens": 1}}})
    anthropic.add({"type": "content_block_start", "index": 0, "content_block": {"type": "tool_use", "id": "t", "name": "get_weather", "input": {}}})
    anthropic.add({"type": "content_block_delta", "index": 0, "delta": {"type": "input_json_delta", "partial_json": '{"city": "Pa'}})
    assert anthropic.result()["content"][0]["input"] == '{"city": "Pa'

    responses = assembler_for("responses")
    responses.add({"type": "response.created", "response": {"id": "r", "model": "m", "status": "in_progress", "output": []}})
    responses.add({"type": "response.output_text.delta", "delta": "Half an ans"})
    _, attrs = genai_span("responses", {"model": "m", "input": "q"}, responses.result())
    assert attrs["iris.output"] == "Half an ans"
