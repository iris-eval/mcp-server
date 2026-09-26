"""iris-eval — the Python client for Iris, the open-source agent-evaluation MCP server.

    from iris_eval import IrisClient

    iris = IrisClient()                     # finds the server: IRIS_URL, or the runtime.json a running server wrote
    logged = iris.log_trace("support-bot", input="Was the refund approved?", output="Yes, it posts within five days.")
    evaluation = iris.evaluate_output("The refund was approved.", input="Was the refund approved?", agent_name="support-bot")
    evaluation["verdict"]["state"]          # "pass" | "fail" | "unknown"

A thin client over the HTTP API (docs/sdk-spec.md rules it so): the rules, the
composer and the storage live in the server; this package speaks to them. The
pytest plugin (``iris`` fixture, ``assert_iris``) rides on it.

To record every model call an application makes, wrap its provider client:

    from openai import OpenAI
    from iris_eval import wrap_openai

    client = wrap_openai(OpenAI(), agent_name="support-bot")   # each call → an OTLP span → a scored Iris trace
"""

from .client import (
    DEFAULT_TIMEOUT,
    AsyncIrisClient,
    IrisClient,
    IrisConnectionError,
    IrisError,
)
from .discovery import ServerLocation, find_server
from .recorder import IrisRecorder, Span, TraceRecord, default_recorder
from .types import (
    Capabilities,
    Evaluation,
    Health,
    LoggedTrace,
    MatchFragment,
    RuleResult,
    SearchInfo,
    TokenUsage,
    ToolCall,
    Trace,
    TraceDetail,
    TraceMatch,
    TracePage,
    Verdict,
    VerdictState,
)
from .wrappers import wrap_anthropic, wrap_openai

__version__ = "0.1.0"

__all__ = [
    "AsyncIrisClient",
    "Capabilities",
    "DEFAULT_TIMEOUT",
    "Evaluation",
    "Health",
    "IrisClient",
    "IrisConnectionError",
    "IrisError",
    "IrisRecorder",
    "LoggedTrace",
    "MatchFragment",
    "RuleResult",
    "SearchInfo",
    "ServerLocation",
    "Span",
    "TokenUsage",
    "ToolCall",
    "Trace",
    "TraceDetail",
    "TraceMatch",
    "TraceRecord",
    "TracePage",
    "Verdict",
    "VerdictState",
    "__version__",
    "default_recorder",
    "find_server",
    "wrap_anthropic",
    "wrap_openai",
]
