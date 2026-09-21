"""The shapes the server answers with, as typed dictionaries.

They mirror the HTTP API (docs/api-reference.md) key for key, so a reader
of the API reference reads these, and a key the server adds tomorrow is
carried through untouched (``total=False`` everywhere: the server owns the
contract, the client only names what it knows).
"""

from __future__ import annotations

from typing import Any, Literal, TypedDict

VerdictState = Literal["pass", "fail", "unknown"]


class Verdict(TypedDict, total=False):
    """Which layer decided, and what it decided on."""

    state: VerdictState
    passed: bool
    basis: str
    by: list[str]
    risk: dict[str, Any] | None
    confidence: str


class RuleResult(TypedDict, total=False):
    ruleName: str
    passed: bool
    score: float
    message: str
    skipped: bool
    skipReason: str
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
    metadata: dict[str, Any]
    timestamp: str
    tools: list[dict[str, Any]]
    run_id: str
    case_key: str
    session_id: str
    source: str


class LoggedTrace(TypedDict, total=False):
    """What ``POST /api/v1/traces`` answers: the id the server minted, and the evaluation when one was asked for."""

    trace_id: str
    status: str
    evaluation: Evaluation


class TracePage(TypedDict, total=False):
    traces: list[Trace]
    total: int
    limit: int
    offset: int


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
