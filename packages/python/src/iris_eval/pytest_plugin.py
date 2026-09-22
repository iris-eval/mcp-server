"""The pytest plugin: an ``iris`` fixture and ``assert_iris``.

Registered by the ``pytest11`` entry point when ``iris-eval`` is installed,
so a test file needs no ``conftest``::

    from iris_eval.pytest_plugin import assert_iris

    def test_refund_answer(iris):
        evaluation = assert_iris("The refund was approved and posts within five days.",
                                 input="Was the refund approved?", agent_name="support-bot", client=iris)
        assert evaluation["verdict"]["basis"] == "clean"

The fixture finds the server the way the client does (``IRIS_URL``, then
``runtime.json``). With none, the test is **skipped** with a sentence that
says how to start one — unless ``IRIS_REQUIRE=1``, when it fails instead
(the setting for a CI job that must not pass green because no server ran).
``assert_iris`` evaluates the output and asserts on ``verdict.state``, the
composed verdict — never on the score alone.
"""

from __future__ import annotations

import os
from typing import Any, Mapping

import pytest

from .client import IrisClient, IrisConnectionError, IrisError
from .discovery import find_server
from .types import Evaluation, VerdictState

SKIP_REASON = (
    "no Iris server: set IRIS_URL, or start one — `npx -y @iris-eval/mcp-server --dashboard` — "
    "and the client reads its port from runtime.json; set IRIS_REQUIRE=1 to fail instead of skipping"
)


def pytest_addoption(parser: pytest.Parser) -> None:
    group = parser.getgroup("iris", "Iris agent evaluation")
    group.addoption("--iris-url", action="store", default=None, help="The Iris server's base URL (overrides IRIS_URL and runtime.json).")
    group.addoption("--iris-api-key", action="store", default=None, help="The API key (overrides IRIS_API_KEY).")


@pytest.fixture(scope="session")
def iris(request: pytest.FixtureRequest) -> IrisClient:
    """A client for the Iris server this session can reach; skipped (or failed with IRIS_REQUIRE=1) when there is none."""
    url = request.config.getoption("--iris-url") or None
    key = request.config.getoption("--iris-api-key") or os.environ.get("IRIS_API_KEY") or None
    required = os.environ.get("IRIS_REQUIRE", "").strip() in ("1", "true", "yes")
    if url is None and find_server() is None:
        if required:
            pytest.fail(SKIP_REASON, pytrace=False)
        pytest.skip(SKIP_REASON)
    try:
        client = IrisClient(url, api_key=key)
        client.health()
    except (IrisConnectionError, IrisError) as err:
        if required:
            pytest.fail(f"the Iris server did not answer: {err}", pytrace=False)
        pytest.skip(f"the Iris server did not answer: {err}")
    request.addfinalizer(client.close)
    return client


def assert_iris(
    output: str,
    *,
    input: str | None = None,
    agent_name: str = "pytest",
    eval_type: str | None = None,
    expect: VerdictState = "pass",
    client: IrisClient | None = None,
    **trace: Any,
) -> Evaluation:
    """Evaluate ``output`` and assert the verdict's state is ``expect`` (``pass`` by default).

    The message names the basis and the rules that decided, so a failing
    test reads like the dashboard: ``verdict fail on detector_veto by no_pii``.
    Extra keyword arguments (``tool_calls``, ``tools``, ``cost_usd``,
    ``token_usage``, ``run``, ``case_key``, ``session_id``, ``metadata``) go on
    the trace. Returns the evaluation for further assertions.
    """
    own = client is None
    c = client or IrisClient()
    try:
        evaluation = c.evaluate_output(output, input=input, agent_name=agent_name, eval_type=eval_type, **_trace_fields(trace))
    finally:
        if own:
            c.close()
    verdict = evaluation.get("verdict") or {}
    state = verdict.get("state")
    if state != expect:
        by = ", ".join(verdict.get("by") or []) or "—"
        raise AssertionError(
            f"Iris verdict {state} on {verdict.get('basis')} by {by} (expected {expect}); "
            f"score {evaluation.get('score')}; evaluation {evaluation.get('id')} on trace {evaluation.get('trace_id')}"
        )
    return evaluation


def _trace_fields(fields: Mapping[str, Any]) -> dict[str, Any]:
    allowed = {"tool_calls", "tools", "cost_usd", "token_usage", "run", "case_key", "session_id", "metadata"}
    unknown = sorted(set(fields) - allowed)
    if unknown:
        raise TypeError(f"assert_iris got unexpected keyword(s): {', '.join(unknown)} — the trace fields are {', '.join(sorted(allowed))}")
    return dict(fields)
