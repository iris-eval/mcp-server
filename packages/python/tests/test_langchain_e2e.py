"""The LangChain / LangGraph handler, end to end: a real LangGraph app (the
tool loop in ``langgraph_app.py``, a scripted model), ``IrisCallbackHandler``
in its callbacks, the recorder sending to a real Iris server, and each run
read back from Iris as one trace — its input, output, tool calls, token
usage, latency and verdict.
"""

from __future__ import annotations

import json
from typing import Any, Iterator

import pytest

from iris_eval import IrisRecorder
from live import Iris, start_iris

pytest.importorskip("langchain_core")
pytest.importorskip("langgraph")

from langchain_core.messages import HumanMessage  # noqa: E402
from langchain_core.output_parsers import StrOutputParser  # noqa: E402
from langchain_core.prompts import ChatPromptTemplate  # noqa: E402
from langgraph.checkpoint.memory import InMemorySaver  # noqa: E402

from iris_eval.langchain import IrisCallbackHandler  # noqa: E402
from langgraph_app import AFTER_TOOL, ANSWER, SSN, ScriptedChatModel, broken_weather, build_graph  # noqa: E402

WEATHER = "What is the weather in Paris?"


@pytest.fixture(scope="module")
def iris() -> Iterator[Iris]:
    yield from start_iris()


@pytest.fixture(scope="module")
def recorder(iris: Iris) -> Iterator[IrisRecorder]:
    r = IrisRecorder(iris.url, api_key=iris.api_key, flush_interval=0.01)
    yield r
    r.close()


def stored(recorder: IrisRecorder, before: int) -> dict[str, Any]:
    """Send what the run recorded and return what Iris stored for it — exactly one trace."""
    assert recorder.flush(10)
    assert len(recorder.results) == before + 1, f"one trace for one run; stats {recorder.stats}"
    return recorder.results[-1]


def by_kind(spans: list[dict[str, Any]], kind: str) -> list[dict[str, Any]]:
    return [s for s in spans if s["kind"] == kind]


def model_calls(spans: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """The ``chat`` spans. Iris also files the ``invoke_agent`` root under LLM, as it does for every framework that emits one."""
    return [s for s in by_kind(spans, "LLM") if s["attributes"].get("gen_ai.operation.name") == "chat"]


class TestLangGraph:
    def test_a_tool_loop_arrives_as_one_trace_with_its_tool_call_usage_and_a_pass(self, iris: Iris, recorder: IrisRecorder) -> None:
        handler = IrisCallbackHandler(recorder=recorder, agent_name="weather-graph")
        n = len(recorder.results)
        out = build_graph().invoke({"messages": [HumanMessage(WEATHER)]}, config={"callbacks": [handler]})
        assert out["messages"][-1].content == AFTER_TOOL
        entry = stored(recorder, n)
        assert entry["lacked"] == []
        assert entry["steps"] == 1
        assert entry["evaluation"]["verdict"]["state"] == "pass"

        got = iris.trace(entry["trace_id"])
        trace, spans = got["trace"], got["spans"]
        assert trace["agent_name"] == "weather-graph"
        assert trace["framework"] == "langgraph"
        assert trace["input"] == WEATHER
        assert trace["output"] == AFTER_TOOL
        # Summed over the two model calls: the tool request (10 in, 12 out) and the answer (30 in, 8 out).
        assert trace["token_usage"] == {"prompt_tokens": 40, "completion_tokens": 20, "total_tokens": 60}
        assert trace["latency_ms"] >= 0
        assert [t["name"] for t in trace["tools"]] == ["get_weather"]
        assert [e["id"] for e in got["evals"]] == [entry["evaluation"]["id"]]

        # The root, both model calls, the tool call, and the graph's nodes under the root.
        root = next(s for s in spans if s.get("parent_span_id") is None)
        assert root["name"] == "invoke_agent weather-graph"
        assert root["attributes"]["gen_ai.operation.name"] == "invoke_agent"
        assert len(model_calls(spans)) == 2
        (tool,) = by_kind(spans, "TOOL")
        assert tool["name"] == "execute_tool get_weather"
        assert tool["attributes"]["gen_ai.tool.call.id"] == "call_weather_1"
        assert json.loads(tool["attributes"]["gen_ai.tool.call.arguments"]) == {"city": "Paris"}
        assert tool["attributes"]["gen_ai.tool.call.result"] == "18C, sunny in Paris"
        nodes = sorted(s["attributes"].get("langgraph.node") for s in spans if s["attributes"].get("langgraph.node") and s["name"] in ("agent", "tools"))
        assert nodes == ["agent", "agent", "tools"]
        first_call = min(model_calls(spans), key=lambda s: s["start_time"])
        assert first_call["attributes"]["gen_ai.request.model"] == "scripted-model"
        assert first_call["attributes"]["gen_ai.provider.name"] == "scripted"
        assert json.loads(first_call["attributes"]["gen_ai.output.messages"])[0]["parts"][0] == {"type": "tool_call", "id": "call_weather_1", "name": "get_weather", "arguments": {"city": "Paris"}}
        # Every span is in the one trace, parented inside it.
        ids = {s["span_id"] for s in spans}
        assert all(s.get("parent_span_id") in ids for s in spans if s is not root)

    def test_an_answer_that_leaks_an_ssn_is_failed(self, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        build_graph().invoke({"messages": [HumanMessage("What is her SSN?")]}, config={"callbacks": [IrisCallbackHandler(recorder=recorder, agent_name="weather-graph")]})
        entry = stored(recorder, n)
        assert entry["evaluation"]["verdict"]["state"] == "fail"
        assert any(r["ruleName"] == "no_pii" and not r["passed"] for r in entry["evaluation"]["rule_results"])

    def test_a_run_that_fails_raises_as_it_would_and_still_arrives_with_its_error(self, iris: Iris, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        with pytest.raises(RuntimeError, match="the weather service is down"):
            build_graph([broken_weather]).invoke({"messages": [HumanMessage(WEATHER)]}, config={"callbacks": [IrisCallbackHandler(recorder=recorder)]})
        entry = stored(recorder, n)
        # No answer, so nothing to score: stored with its error and not evaluated.
        assert "evaluation" not in entry
        got = iris.trace(entry["trace_id"])
        (tool,) = by_kind(got["spans"], "TOOL")
        assert tool["status_code"] == "ERROR"
        assert "the weather service is down" in tool["attributes"]["gen_ai.tool.call.result"]
        root = next(s for s in got["spans"] if s.get("parent_span_id") is None)
        assert root["status_code"] == "ERROR"

    def test_a_thread_id_is_the_session(self, iris: Iris, recorder: IrisRecorder) -> None:
        app = build_graph(checkpointer=InMemorySaver())
        handler = IrisCallbackHandler(recorder=recorder, agent_name="weather-graph")
        n = len(recorder.results)
        config = {"callbacks": [handler], "configurable": {"thread_id": "thread-7"}}
        app.invoke({"messages": [HumanMessage("What is the capital of France?")]}, config=config)
        app.invoke({"messages": [HumanMessage("What is her SSN?")]}, config=config)
        assert recorder.flush(10)
        first, second = recorder.results[n], recorder.results[n + 1]
        assert iris.trace(first["trace_id"])["trace"]["session_id"] == "thread-7"
        assert iris.trace(second["trace_id"])["trace"]["session_id"] == "thread-7"
        # The second turn's input is its own question, not the first one.
        assert iris.trace(second["trace_id"])["trace"]["input"] == "What is her SSN?"

    async def test_async_invoke(self, iris: Iris, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        out = await build_graph().ainvoke({"messages": [HumanMessage(WEATHER)]}, config={"callbacks": [IrisCallbackHandler(recorder=recorder, agent_name="weather-graph")]})
        assert out["messages"][-1].content == AFTER_TOOL
        entry = stored(recorder, n)
        assert entry["steps"] == 1
        assert entry["evaluation"]["verdict"]["state"] == "pass"


class TestLangChain:
    def test_a_chain_arrives_with_its_question_and_its_answer(self, iris: Iris, recorder: IrisRecorder) -> None:
        chain = ChatPromptTemplate.from_messages([("system", "Answer briefly."), ("human", "{question}")]) | ScriptedChatModel() | StrOutputParser()
        n = len(recorder.results)
        answer = chain.invoke({"question": "What is the capital of France?"}, config={"callbacks": [IrisCallbackHandler(recorder=recorder, agent_name="qa-chain", run="nightly-1")]})
        assert answer == ANSWER
        entry = stored(recorder, n)
        got = iris.trace(entry["trace_id"])
        assert got["trace"]["framework"] == "langchain"
        assert got["trace"]["input"] == "What is the capital of France?"
        assert got["trace"]["output"] == ANSWER
        assert got["trace"]["run_id"] == "nightly-1"
        assert got["trace"]["token_usage"] == {"prompt_tokens": 10, "completion_tokens": 6, "total_tokens": 16}
        (llm,) = model_calls(got["spans"])
        assert json.loads(llm["attributes"]["gen_ai.system_instructions"]) == [{"type": "text", "content": "Answer briefly."}]
        assert entry["evaluation"]["verdict"]["state"] == "pass"

    def test_a_model_called_on_its_own_is_its_own_trace(self, iris: Iris, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        ScriptedChatModel().invoke("What is her SSN?", config={"callbacks": [IrisCallbackHandler(recorder=recorder, agent_name="bare-model")]})
        entry = stored(recorder, n)
        got = iris.trace(entry["trace_id"])
        assert len(got["spans"]) == 1 and got["spans"][0]["kind"] == "LLM"
        assert got["trace"]["input"] == "What is her SSN?"
        assert got["trace"]["output"] == SSN
        assert entry["evaluation"]["verdict"]["state"] == "fail"


def test_without_a_server_the_run_is_untouched() -> None:
    errors: list[Exception] = []
    recorder = IrisRecorder("http://127.0.0.1:9", flush_interval=0, on_error=errors.append)
    out = build_graph().invoke({"messages": [HumanMessage(WEATHER)]}, config={"callbacks": [IrisCallbackHandler(recorder=recorder)]})
    assert out["messages"][-1].content == AFTER_TOOL
    recorder.flush(5)
    assert recorder.stats == {"recorded": 1, "sent": 0, "dropped": 1}
    assert errors
    recorder.close()
