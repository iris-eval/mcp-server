# iris-eval — the Python client

[Iris](https://iris-eval.dev) is an open-source agent-evaluation MCP server: it stores your agent's traces and judges each one under 25 built-in rules — PII, injection, hallucination markers, tool loops, cost outliers, a regression watcher — with a verdict that says which layer decided and why. This package is the Python door to a running server: log a trace, get its verdict, gate a test on it.

```bash
pip install iris-eval
npx -y @iris-eval/mcp-server --dashboard      # the server, in another terminal (Node 20+)
```

```python
from iris_eval import IrisClient

iris = IrisClient()   # finds the server: IRIS_URL, or the runtime.json a running dashboard wrote

evaluation = iris.evaluate_output(
    "The refund was approved and posts within five business days.",
    input="Was the refund approved?",
    agent_name="support-bot",
)
evaluation["verdict"]            # {"state": "pass", "basis": "clean", "by": []}

logged = iris.log_trace("support-bot", input="…", output="…", run="nightly-42", case_key="refund-policy")
page = iris.get_traces(agent_name="support-bot", limit=20)
iris.health()["status"]          # "ok" | "degraded"
iris.capabilities()["rules"]     # every rule, what it needs, its published accuracy
```

A thin client over the HTTP API: the rules, the composer and the storage live in the server, and this package speaks to them — the same verdict the MCP tools, the dashboard and the CI gate read. `AsyncIrisClient` has the same methods, awaited.

## The methods

| Method | Route | What it answers |
|---|---|---|
| `log_trace(agent_name, *, input, output, tool_calls, latency_ms, token_usage, cost_usd, metadata, tools, run, case_key, session_id, spans, timestamp, evaluate, eval_type)` | `POST /api/v1/traces` | `{"trace_id", "status"}` — with `evaluate=True`, `"evaluation"` too |
| `evaluate_output(output, *, input, agent_name, eval_type, …)` | `POST /api/v1/traces` with `evaluate: true` | The evaluation: `verdict` (`state`, `basis`, `by`), `score`, `rule_results`, `critical_failures`, `coverage`, `provenance`. Over HTTP the evaluate door is the ingest door, so the output is stored as a trace of `agent_name` and shows on the dashboard |
| `get_traces(*, agent_name, framework, session, since, until, min_score, max_score, limit, offset, sort_by, sort_order, **extra)` | `GET /api/v1/traces` | `{"traces", "total", "limit", "offset"}` — any other keyword is sent as a query parameter as it is; one the server does not read is a 400 naming it |
| `get_trace(trace_id)` | `GET /api/v1/traces/:id` | `{"trace", "spans", "evals"}` |
| `health()` | `GET /api/v1/health` | Open, unkeyed; `status`, `version`, `checks` |
| `capabilities()` | `GET /api/v1/capabilities` | What this server can do |

Every answer is the route's JSON as a typed dictionary (`iris_eval.types`): the keys the [API reference](https://github.com/iris-eval/mcp-server/blob/main/docs/api-reference.md) documents, and any key the server adds later carried through.

**Errors.** A refusal raises `IrisError` with the server's own sentence, the status and the validation details: `IrisError: Invalid query parameters (GET /api/v1/traces → 400)`. A server that cannot be reached raises `IrisConnectionError` naming the URL and how to start one.

**Auth.** `IrisClient(api_key="…")` sends `Authorization: Bearer` — a server bound beyond loopback requires it; `IRIS_API_KEY` is read by the pytest fixture.

**Finding the server.** `IrisClient(base_url=None)`: `IRIS_URL` first (`http://host:port`), then the port the running dashboard recorded in `runtime.json` under `IRIS_HOME` (or `~/.iris`), verified with the health route before it is trusted. Nothing named: `IrisConnectionError` with the recipe.

## pytest

Installing the package registers a plugin. An `iris` fixture finds the server; `assert_iris` evaluates an output and asserts on the **verdict's state** — the composed verdict, never the score alone.

```python
from iris_eval.pytest_plugin import assert_iris

def test_refund_answer(iris):
    evaluation = assert_iris(
        agent("Was the refund approved?"),
        input="Was the refund approved?",
        agent_name="support-bot",
        client=iris,
    )
    assert evaluation["verdict"]["basis"] == "clean"

def test_the_leak_is_caught(iris):
    assert_iris("The SSN is 123-45-6789.", input="q", expect="fail", client=iris)
```

A failing assertion reads like the dashboard: `Iris verdict fail on detector_veto by no_pii (expected pass); score 0.4; evaluation eval_… on trace trace_…`. Without a server the tests are **skipped** with the sentence that says how to start one; set `IRIS_REQUIRE=1` in a CI job that must not pass green because no server ran. `--iris-url` and `--iris-api-key` override the environment.

In CI, start the server in the job and point the tests at it:

```yaml
- run: npx -y @iris-eval/mcp-server --dashboard --dashboard-port 6920 --api-key "$IRIS_API_KEY" &
- run: pip install iris-eval && pytest
  env:
    IRIS_URL: http://127.0.0.1:6920
    IRIS_API_KEY: ${{ secrets.IRIS_API_KEY }}
    IRIS_REQUIRE: "1"
```

Or gate a traces file without a server at all — the [CI gate](https://github.com/iris-eval/mcp-server/blob/main/docs/ci-gate.md) and its GitHub Action.

## Tracing from Python

This package does not instrument your code. Iris reads the OpenTelemetry traces your framework already emits — Pydantic AI, Google ADK, LangGraph, CrewAI, Semantic Kernel and the others — through `POST /v1/traces` on the dashboard port ([docs/otel-integration.md](https://github.com/iris-eval/mcp-server/blob/main/docs/otel-integration.md)); a decorator SDK that built a second trace model is a maintenance surface Iris chose not to carry.

## Versions

The client follows the HTTP API, which the server versions; `iris_eval.__version__` is this package's own. Python 3.10+, `httpx` the only dependency. Source: [packages/python](https://github.com/iris-eval/mcp-server/tree/main/packages/python).
