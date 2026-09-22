"""iris-eval — the Python client for Iris, the open-source agent-evaluation MCP server.

    from iris_eval import IrisClient

    iris = IrisClient()                     # finds the server: IRIS_URL, or the runtime.json a running server wrote
    logged = iris.log_trace("support-bot", input="Was the refund approved?", output="Yes, it posts within five days.")
    evaluation = iris.evaluate_output("The refund was approved.", input="Was the refund approved?", agent_name="support-bot")
    evaluation["verdict"]["state"]          # "pass" | "fail" | "unknown"

A thin client over the HTTP API (docs/sdk-spec.md rules it so): the rules, the
composer and the storage live in the server; this package speaks to them. The
pytest plugin (``iris`` fixture, ``assert_iris``) rides on it.
"""

from .client import (
    DEFAULT_TIMEOUT,
    AsyncIrisClient,
    IrisClient,
    IrisConnectionError,
    IrisError,
)
from .discovery import ServerLocation, find_server
from .types import (
    Capabilities,
    Evaluation,
    Health,
    LoggedTrace,
    RuleResult,
    TokenUsage,
    ToolCall,
    Trace,
    TraceDetail,
    TracePage,
    Verdict,
    VerdictState,
)

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
    "LoggedTrace",
    "RuleResult",
    "ServerLocation",
    "TokenUsage",
    "ToolCall",
    "Trace",
    "TraceDetail",
    "TracePage",
    "Verdict",
    "VerdictState",
    "__version__",
    "find_server",
]
