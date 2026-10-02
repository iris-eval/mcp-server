"""The shapes the server answers with, as typed dictionaries.

They mirror the HTTP API (docs/api-reference.md) key for key, so a reader
of the API reference reads these, and a key the server adds tomorrow is
carried through untouched (``total=False`` everywhere: the server owns the
contract, the client only names what it knows).
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

VerdictState = Literal["pass", "fail", "unknown"]


class VerdictLayer(TypedDict, total=False):
    """A later layer that would have decided the verdict on its own."""

    basis: str
    state: Literal["fail", "unknown"]
    by: list[str]


class Verdict(TypedDict, total=False):
    """Which layer decided, and what it decided on.

    ``basis`` names the first layer with something to say; ``also`` lists
    every later one that would have decided the verdict too, and is absent
    when there is none.
    """

    state: VerdictState
    passed: bool
    basis: str
    by: list[str]
    risk: dict[str, Any] | None
    confidence: str
    also: list[VerdictLayer]


class RuleResult(TypedDict, total=False):
    ruleName: str
    passed: bool
    #: ``pass``, ``fail`` or ``not_checked``. Read this, not ``passed``: a rule
    #: that skipped carries ``passed: False`` as a placeholder (server 0.20.0+).
    state: str
    score: float
    message: str
    skipped: bool
    skipReason: str
    #: On a rule that skipped for missing evidence: the inputs it reads that
    #: the call did not carry.
    lacked: list[str]
    #: On such a rule, when somebody had asked for it: ``config`` (the
    #: deployment) or ``call`` (the call itself). The verdict is then
    #: ``unknown``, not ``pass``.
    asked: str
    evidence: list[dict[str, Any]]
    value: dict[str, Any]


class Evaluation(TypedDict, total=False):
    """One evaluation, as ``evaluate_output`` and ``POST /api/v1/traces`` answer it."""

    id: str
    trace_id: str
    eval_type: str
    score: float
    passed: bool
    verdict: Verdict
    rule_results: list[RuleResult]
    critical_failures: list[str]
    critical_skipped: list[str]
    interpretations: list[dict[str, Any]]
    coverage: dict[str, Any]
    provenance: dict[str, Any]
    note: str


class TokenUsage(TypedDict, total=False):
    input_tokens: int
    output_tokens: int
    total_tokens: int


class ToolCall(TypedDict, total=False):
    name: str
    arguments: dict[str, Any]
    result: Any
    duration_ms: float
    error: str


class MatchFragment(TypedDict):
    text: str
    hit: bool


class MatchSpan(TypedDict):
    span_id: str
    name: str


class TraceMatch(TypedDict, total=False):
    """Where a searched trace matched: the field, an excerpt, and the excerpt split at the matched words."""

    field: Literal["input", "output", "tool_calls", "metadata", "spans"]
    snippet: str
    fragments: list[MatchFragment]
    span: MatchSpan


class SearchInfo(TypedDict, total=False):
    """How a search with ``q`` was read: the terms, and ``fts5`` (the full-text index) or ``scan``."""

    terms: list[str]
    index: Literal["fts5", "scan"]


class Trace(TypedDict, total=False):
    trace_id: str
    agent_name: str
    framework: str
    input: str
    output: str
    tool_calls: list[ToolCall]
    latency_ms: float
    token_usage: TokenUsage
    cost_usd: float
    cost_source: Literal["reported", "estimated"]
    cost_estimate: dict[str, Any]
    metadata: dict[str, Any]
    timestamp: str
    tools: list[dict[str, Any]]
    run_id: str
    case_key: str
    session_id: str
    source: str
    match: TraceMatch


class LoggedTrace(TypedDict, total=False):
    """What ``POST /api/v1/traces`` answers: the id the server minted, the stored cost and where it came from, and the evaluation when one was asked for."""

    trace_id: str
    status: str
    cost_usd: float | None
    cost_source: Literal["reported", "estimated"]
    cost_estimate: dict[str, Any]
    evaluation: Evaluation


class TracePage(TypedDict, total=False):
    traces: list[Trace]
    total: int
    limit: int
    offset: int
    search: SearchInfo


class TraceDetail(TypedDict, total=False):
    trace: Trace
    spans: list[dict[str, Any]]
    evals: list[Evaluation]


class Health(TypedDict, total=False):
    status: str
    version: str
    uptime_seconds: float
    driver: str
    checks: dict[str, Any]
    judge: dict[str, Any]


Capabilities = dict[str, Any]
"""``GET /api/v1/capabilities``: the version, the rules with their proof, the judge state, the limits — see the API reference."""
