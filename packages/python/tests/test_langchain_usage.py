"""One usage mapping, two handlers.

Every case in tests/fixtures/langchain-usage-parity (at the repository root)
becomes the attributes it names, here and in the JavaScript handler's own test
(packages/langchain/test/usage.test.ts), so a LangChain run reads the same in
Iris from either language and either Anthropic integration.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from iris_eval._langchain_usage import usage_attributes

FIXTURE = Path(__file__).resolve().parents[3] / "tests" / "fixtures" / "langchain-usage-parity" / "cases.json"
CASES = json.loads(FIXTURE.read_text(encoding="utf-8"))["cases"]


def test_there_are_cases() -> None:
    assert len(CASES) >= 6


@pytest.mark.parametrize("case", CASES, ids=[c["name"] for c in CASES])
def test_the_attributes_match_the_shared_expectation(case: dict) -> None:
    assert usage_attributes(case["usage_metadata"], case["response_metadata"]) == case["attributes"]


def test_nothing_to_read_is_no_attributes() -> None:
    assert usage_attributes(None, None) == {}
    assert usage_attributes({"input_tokens": -1, "output_tokens": 1.5}, None) == {}
    assert usage_attributes({"input_tokens": True}, None) == {}
