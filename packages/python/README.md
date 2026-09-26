# iris-eval — the Python client

[Iris](https://iris-eval.com) is an open-source agent-evaluation MCP server: it stores your agent's traces and judges each one under its built-in rules — PII, injection, hallucination markers, tool loops, cost outliers, a regression watcher — with a verdict that says which layer decided and why. This package is the Python door to a running server: log a trace, get its verdict, gate a test on it.

```bash
pip install iris-eval
npx -y @iris-eval/mcp-server --dashboard      # the server, in another terminal (Node 22.13+)
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
found = iris.get_traces(q='"refund approved"')   # full-text search, best match first
found["traces"][0]["match"]["snippet"]          # the words around the match
iris.health()["status"]          # "ok" | "degraded"
iris.capabilities()["rules"]     # every rule, what it needs, its published accuracy
```

A thin client over the HTTP API: the rules, the composer and the storage live in the server, and this package speaks to them — the same verdict the MCP tools, the dashboard and the CI gate read. `AsyncIrisClient` has the same methods, awaited.

## The methods

| Method | Route | What it answers |
|---|---|---|
| `log_trace(agent_name, *, input, output, tool_calls, latency_ms, token_usage, cost_usd, metadata, tools, run, case_key, session_id, spans, timestamp, evaluate, eval_type)` | `POST /api/v1/traces` | `{"trace_id", "status"}` — with `evaluate=True`, `"evaluation"` too |
| `evaluate_output(output, *, input, agent_name, eval_type, …)` | `POST /api/v1/traces` with `evaluate: true` | The evaluation: `verdict` (`state`, `basis`, `by`), `score`, `rule_results`, `critical_failures`, `coverage`, `provenance`. Over HTTP the evaluate door is the ingest door, so the output is stored as a trace of `agent_name` and shows on the dashboard |
| `get_traces(*, agent_name, framework, session, q, since, until, min_score, max_score, limit, offset, sort_by, sort_order, **extra)` | `GET /api/v1/traces` | `{"traces", "total", "limit", "offset"}` — with `q` (full-text search over input, output, tool-call values and metadata; every word must appear, `"a phrase"` in order, `word*` as a prefix), ranked by relevance, each trace with `match` (`field`, `snippet`, `fragments`) and the page with `search`. Any other keyword is sent as a query parameter as it is; one the server does not read is a 400 naming it |
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

## Record every OpenAI and Anthropic call

Wrap the provider client once and every model call it makes is recorded and scored, without the model having to call a tool and without changing the calls:

```python
from openai import OpenAI
from anthropic import Anthropic
from iris_eval import wrap_openai, wrap_anthropic

client = wrap_openai(OpenAI(), agent_name="support-bot")
client.chat.completions.create(model="gpt-5.2", messages=[{"role": "user", "content": "Was the refund approved?"}])

claude = wrap_anthropic(Anthropic(), agent_name="support-bot")
```

`wrap_openai` and `wrap_anthropic` arrive in the release after 0.1.0 and are not yet published to PyPI. Until then, install the client from the repository: `pip install "iris-eval @ git+https://github.com/iris-eval/mcp-server#subdirectory=packages/python"`.

Each call becomes one standard OpenTelemetry GenAI span (`gen_ai.*`) sent to Iris's OTLP ingest, `POST /v1/traces` on the dashboard port; Iris stores it as a trace with the input, the output, the token usage and the tool calls, and scores it. The span is the one the JavaScript package, `@iris-eval/sdk`, sends for the same call: both are held to one fixture, `tests/fixtures/genai-parity` at the repository root.

| Covered | Calls |
|---|---|
| `OpenAI`, `AsyncOpenAI` | `chat.completions.create` (plain and `stream=True`), `parse`, `stream`; `responses.create` (plain and `stream=True`), `stream` |
| `Anthropic`, `AsyncAnthropic` | `messages.create` (plain and `stream=True`), `stream` |

How it works: both SDKs send every request through one method on the client, `post()`. The wrapper takes `client.copy()`, a real client of the same class sharing the original's connection pool, and gives the copy a `post` that watches the three model endpoints and passes every other request through. The original client is not changed; `with_options()` on the wrapped client stays wrapped. `with_raw_response` and `with_streaming_response` calls pass through unrecorded.

- **Never in the way.** A response is recorded after it has been read, a stream as it ends or is closed. The trace goes onto a bounded queue (1,000 traces, oldest dropped first) and a background thread sends it; nothing raises into your code, each kind of delivery failure is logged once on the `iris_eval` logger, and at exit the queue gets up to two seconds to deliver.
- **A refused call** raises the provider's own exception, unchanged, and is recorded with `error.type` and the provider's message.
- **One change you can turn off.** OpenAI Chat Completions streams carry no token usage unless asked. When a streamed call does not set `stream_options`, the wrapper asks and removes the usage-only final chunk before your code reads the stream. `wrap_openai(client, stream_usage=False)` sends the request as written, for an OpenAI-compatible server that refuses the option.
- **A verdict per trace.** The recorder sets `iris.evaluate` on each trace, so Iris scores these without scoring the rest of an OTLP feed. `evaluate=False` stores without scoring; `eval_type="safety"` runs one bundle.
- **What is never recorded:** the bytes of an image, audio or file part (it is named by its type only). A text part longer than 16,384 characters is cut, with a note of how much was left out.

The options: `recorder` (default: one process-wide `IrisRecorder`, which finds the server as `IrisClient` does and reads `IRIS_API_KEY`), `agent_name` (default: the running program's name), `session_id` (`gen_ai.conversation.id`, which Iris reads as the session), `run` (`iris.run`), `evaluate`, `eval_type`. What Iris answered is on the recorder:

```python
from iris_eval import IrisRecorder, wrap_openai

recorder = IrisRecorder("http://127.0.0.1:6920", api_key="…", on_result=lambda r: print(r["trace_id"], r["evaluation"]["verdict"]["state"]))
client = wrap_openai(OpenAI(), recorder=recorder, agent_name="support-bot")
# … at the end of a script or a test:
recorder.flush()
recorder.results[-1]["evaluation"]["verdict"]   # the last call's verdict
```

Proven in CI on every Python the package supports, and once more on the oldest provider SDKs the test extras allow (`openai` 1.66.0, `anthropic` 0.43.0): the official clients, wrapped, against a scripted provider that answers in each API's own JSON and Server-Sent Events, each call required to arrive in a real Iris server built from the same commit with its input, output, token usage and verdict, and an answer carrying an SSN required to fail.

A framework that already emits OpenTelemetry (Pydantic AI, Google ADK, LangGraph, CrewAI, Semantic Kernel and the others) needs no wrapper: point its exporter at the same door ([docs/otel-recipes.md](https://github.com/iris-eval/mcp-server/blob/main/docs/otel-recipes.md)).

## Versions

The client follows the HTTP API, which the server versions; `iris_eval.__version__` is this package's own. Python 3.10+, `httpx` the only dependency; the wrappers import no provider SDK themselves. Source: [packages/python](https://github.com/iris-eval/mcp-server/tree/main/packages/python).
