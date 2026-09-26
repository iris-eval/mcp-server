"""The client against a fake server (httpx.MockTransport) — every method's
request shape, the Bearer header, the server's sentence on a refusal, the
connection error — and, when IRIS_URL names one, against a live server.
"""

from __future__ import annotations

import json
import os

import httpx
import pytest

from iris_eval import AsyncIrisClient, IrisClient, IrisConnectionError, IrisError

LEAKY = "The customer record shows SSN 123-45-6789 and the refund was approved for the order."
CLEAN = "The refund was approved for the order and will post within five business days."


class FakeIris:
    """Answers like the dashboard API; records what it was asked."""

    def __init__(self) -> None:
        self.requests: list[httpx.Request] = []

    def handle(self, request: httpx.Request) -> httpx.Response:
        self.requests.append(request)
        path = request.url.path
        if path == "/api/v1/health":
            return httpx.Response(200, json={"status": "ok", "version": "0.16.0", "checks": {}})
        if path == "/api/v1/capabilities":
            return httpx.Response(200, json={"version": "0.16.0", "rules": [], "tools": []})
        if path == "/api/v1/traces" and request.method == "POST":
            body = json.loads(request.content)
            if "agent_name" not in body:
                return httpx.Response(400, json={"error": "Invalid trace payload", "details": [{"path": ["agent_name"], "message": "Required"}]})
            answer = {"trace_id": "trace_1", "status": "stored"}
            if body.get("evaluate"):
                leaky = "123-45-6789" in (body.get("output") or "")
                answer["evaluation"] = {
                    "id": "eval_1",
                    "trace_id": "trace_1",
                    "eval_type": body.get("eval_type") or "all",
                    "score": 0.4 if leaky else 0.9,
                    "passed": not leaky,
                    "verdict": {"state": "fail", "basis": "detector_veto", "by": ["no_pii"]} if leaky else {"state": "pass", "basis": "clean", "by": []},
                    "rule_results": [],
                }
            return httpx.Response(201, json=answer)
        if path == "/api/v1/traces" and request.method == "GET":
            if "sesion" in request.url.params:
                return httpx.Response(400, json={"error": "Invalid query parameters", "details": [{"path": ["sesion"], "message": "Unrecognized key"}]})
            return httpx.Response(200, json={"traces": [{"trace_id": "trace_1", "agent_name": "bot"}], "total": 1, "limit": 50, "offset": 0})
        if path == "/api/v1/traces/missing":
            return httpx.Response(404, json={"error": "Trace not found"})
        if path.startswith("/api/v1/traces/"):
            return httpx.Response(200, json={"trace": {"trace_id": path.rsplit("/", 1)[1], "agent_name": "bot"}, "spans": [], "evals": []})
        return httpx.Response(404, json={"error": f"no route {path}"})


@pytest.fixture
def fake() -> FakeIris:
    return FakeIris()


@pytest.fixture
def client(fake: FakeIris) -> IrisClient:
    with IrisClient("http://iris.test", api_key="k-1", transport=httpx.MockTransport(fake.handle)) as c:
        yield c


def test_log_trace_posts_the_body_the_route_reads_and_carries_the_bearer_key(client: IrisClient, fake: FakeIris) -> None:
    logged = client.log_trace("bot", input="q", output="a", run="nightly-1", case_key="k1", session_id="s1", cost_usd=0.01, metadata={"m": 1})
    assert logged == {"trace_id": "trace_1", "status": "stored"}
    req = fake.requests[-1]
    assert req.method == "POST" and req.url.path == "/api/v1/traces"
    assert req.headers["authorization"] == "Bearer k-1"
    assert req.headers["user-agent"].startswith("iris-eval-python/")
    body = json.loads(req.content)
    assert body == {"agent_name": "bot", "input": "q", "output": "a", "run": "nightly-1", "case_key": "k1", "session_id": "s1", "cost_usd": 0.01, "metadata": {"m": 1}}
    assert "evaluate" not in body and "framework" not in body


def test_evaluate_output_goes_through_the_ingest_door_with_evaluate_true_and_returns_the_evaluation(client: IrisClient, fake: FakeIris) -> None:
    evaluation = client.evaluate_output(LEAKY, input="q", agent_name="support-bot", eval_type="safety", case_key="k1")
    body = json.loads(fake.requests[-1].content)
    assert body["evaluate"] is True and body["eval_type"] == "safety" and body["agent_name"] == "support-bot" and body["case_key"] == "k1"
    assert evaluation["verdict"] == {"state": "fail", "basis": "detector_veto", "by": ["no_pii"]}
    assert client.evaluate_output(CLEAN)["verdict"]["state"] == "pass"


def test_get_traces_sends_only_the_filters_given_and_get_trace_reads_one(client: IrisClient, fake: FakeIris) -> None:
    page = client.get_traces(agent_name="bot", session="s1", limit=5, sort_order="asc")
    assert page["total"] == 1 and page["traces"][0]["trace_id"] == "trace_1"
    assert dict(fake.requests[-1].url.params) == {"agent_name": "bot", "session": "s1", "limit": "5", "sort_order": "asc"}
    detail = client.get_trace("trace_9")
    assert detail["trace"]["trace_id"] == "trace_9" and detail["evals"] == []


def test_get_traces_sends_the_search_text_as_q(client: IrisClient, fake: FakeIris) -> None:
    client.get_traces(q='"refund approved" escal*', agent_name="bot")
    assert dict(fake.requests[-1].url.params) == {"q": '"refund approved" escal*', "agent_name": "bot"}


def test_health_and_capabilities(client: IrisClient) -> None:
    assert client.health()["status"] == "ok"
    assert client.capabilities()["version"] == "0.16.0"


def test_a_refusal_raises_the_servers_sentence_with_the_status_and_the_details(client: IrisClient) -> None:
    with pytest.raises(IrisError) as err:
        client.get_traces(sesion="x")
    assert err.value.status == 400
    assert err.value.message == "Invalid query parameters"
    assert err.value.details == [{"path": ["sesion"], "message": "Unrecognized key"}]
    assert "GET /api/v1/traces → 400" in str(err.value)
    with pytest.raises(IrisError, match="Trace not found") as nf:
        client.get_trace("missing")
    assert nf.value.status == 404


def test_no_server_is_a_connection_error_that_says_how_to_start_one() -> None:
    def refuse(_request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("connection refused")

    with IrisClient("http://127.0.0.1:1", transport=httpx.MockTransport(refuse)) as c:
        with pytest.raises(IrisConnectionError) as err:
            c.health()
    assert "http://127.0.0.1:1" in str(err.value)
    assert "npx -y @iris-eval/mcp-server --dashboard" in str(err.value)


def test_without_a_url_and_without_a_server_the_client_refuses_to_construct(monkeypatch: pytest.MonkeyPatch, tmp_path) -> None:
    monkeypatch.delenv("IRIS_URL", raising=False)
    monkeypatch.setenv("IRIS_HOME", str(tmp_path))
    with pytest.raises(IrisConnectionError, match="set IRIS_URL"):
        IrisClient()


async def test_the_async_client_has_the_same_methods(fake: FakeIris) -> None:
    async with AsyncIrisClient("http://iris.test", api_key="k-1", transport=httpx.MockTransport(fake.handle)) as c:
        assert (await c.health())["status"] == "ok"
        logged = await c.log_trace("bot", output="a")
        assert logged["trace_id"] == "trace_1"
        evaluation = await c.evaluate_output(CLEAN, input="q")
        assert evaluation["verdict"]["basis"] == "clean"
        page = await c.get_traces(limit=1)
        assert page["total"] == 1
        assert (await c.get_trace("trace_2"))["trace"]["trace_id"] == "trace_2"
        assert (await c.capabilities())["version"] == "0.16.0"
        with pytest.raises(IrisError, match="Trace not found"):
            await c.get_trace("missing")
    assert fake.requests[1].headers["authorization"] == "Bearer k-1"


# ── the contract against a live server, when one is named ──────────────────

live = pytest.mark.skipif(not os.environ.get("IRIS_URL"), reason="IRIS_URL names no live server")


@live
def test_live_the_five_doors_round_trip() -> None:
    with IrisClient(os.environ["IRIS_URL"], api_key=os.environ.get("IRIS_API_KEY")) as c:
        health = c.health()
        assert health["status"] in ("ok", "degraded") and isinstance(health.get("version"), str)
        caps = c.capabilities()
        assert isinstance(caps.get("rules"), list) and len(caps["rules"]) > 0
        logged = c.log_trace("python-contract", input="Was the refund approved?", output=CLEAN, run="py-contract", case_key="refund-clean")
        assert logged["status"] == "stored" and isinstance(logged["trace_id"], str)
        evaluation = c.evaluate_output(LEAKY, input="Was the refund approved?", agent_name="python-contract", run="py-contract", case_key="refund-leak")
        assert evaluation["verdict"]["state"] == "fail"
        assert evaluation["verdict"]["basis"] == "detector_veto"
        assert "no_pii" in evaluation["verdict"]["by"]
        clean = c.evaluate_output(CLEAN, input="Was the refund approved?", agent_name="python-contract")
        assert clean["verdict"]["state"] == "pass"
        page = c.get_traces(agent_name="python-contract", limit=10)
        assert page["total"] >= 3
        found = c.get_traces(q="refund approved", agent_name="python-contract")
        assert found["search"]["terms"] == ["refund", "approved"] and found["search"]["index"] == "fts5"
        assert found["total"] >= 1
        assert all(t["match"]["fragments"] for t in found["traces"])
        assert {"refund", "approved"} <= {f["text"].lower() for t in found["traces"] for f in t["match"]["fragments"] if f["hit"]}
        with pytest.raises(IrisError) as nothing:
            c.get_traces(q="(*)")
        assert nothing.value.status == 400
        detail = c.get_trace(logged["trace_id"])
        assert detail["trace"]["agent_name"] == "python-contract"
        with pytest.raises(IrisError) as err:
            c.get_traces(sesion="x")
        assert err.value.status == 400
        with pytest.raises(IrisError) as nf:
            c.get_trace("no-such-trace")
        assert nf.value.status == 404


@live
def test_live_a_wrong_key_is_refused_with_the_servers_sentence() -> None:
    if not os.environ.get("IRIS_API_KEY"):
        pytest.skip("the live server runs without a key")
    with IrisClient(os.environ["IRIS_URL"], api_key="not-the-key") as c:
        with pytest.raises(IrisError) as err:
            c.get_traces(limit=1)
        assert err.value.status == 403
        assert err.value.message == "Invalid API key"
        assert c.health()["status"] in ("ok", "degraded")  # health is open by design
