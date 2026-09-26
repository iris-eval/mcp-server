"""The wrappers, end to end: the official ``openai`` and ``anthropic`` clients,
wrapped, calling the scripted provider; the recorder sending to a real Iris
server; each call read back from Iris as a trace with its input, output,
token usage, span and verdict.

Every surface a caller reaches for is driven — a plain call, a stream, the
SDK's stream helper, a tool call and its follow-up, a refused call, sync and
async — because each takes its own path through the SDK and the wrapper has
to see all of them.
"""

from __future__ import annotations

import json
from typing import Any, Iterator

import pytest

from iris_eval import IrisRecorder, wrap_anthropic, wrap_openai
from live import REPLIES, Iris, Provider, start_iris, start_provider

openai = pytest.importorskip("openai")
anthropic = pytest.importorskip("anthropic")


@pytest.fixture(scope="module")
def iris() -> Iterator[Iris]:
    yield from start_iris()


@pytest.fixture(scope="module")
def provider() -> Iterator[Provider]:
    yield from start_provider()


@pytest.fixture(scope="module")
def recorder(iris: Iris) -> Iterator[IrisRecorder]:
    r = IrisRecorder(iris.url, api_key=iris.api_key, flush_interval=0.01)
    yield r
    r.close()


def _openai(provider: Provider, recorder: IrisRecorder, cls: Any = None) -> Any:
    cls = cls or openai.OpenAI
    return wrap_openai(cls(api_key="scripted", base_url=f"{provider.url}/v1", max_retries=0), recorder=recorder, agent_name="openai-py-e2e")


def _anthropic(provider: Provider, recorder: IrisRecorder, cls: Any = None) -> Any:
    cls = cls or anthropic.Anthropic
    return wrap_anthropic(cls(api_key="scripted", base_url=provider.url, max_retries=0), recorder=recorder, agent_name="anthropic-py-e2e")


def stored(recorder: IrisRecorder, before: int) -> dict[str, Any]:
    """Send what the call recorded and return what Iris stored for it — exactly one trace."""
    assert recorder.flush(10)
    assert len(recorder.results) == before + 1, f"one trace for one call; stats {recorder.stats}"
    return recorder.results[-1]


def check(iris: Iris, entry: dict[str, Any], *, agent: str, input: str, output: str, tokens: tuple[int, int], provider: str, verdict: str) -> dict[str, Any]:
    """Read the trace back from Iris and hold it to what the call was."""
    assert entry["lacked"] == []
    assert entry["evaluation"]["verdict"]["state"] == verdict
    got = iris.trace(entry["trace_id"])
    trace, spans, evals = got["trace"], got["spans"], got["evals"]
    assert trace["agent_name"] == agent
    assert trace["source"] == "otel"
    assert trace["input"] == input
    assert trace["output"] == output
    assert trace["token_usage"] == {"prompt_tokens": tokens[0], "completion_tokens": tokens[1], "total_tokens": tokens[0] + tokens[1]}
    assert trace["latency_ms"] >= 0
    assert len(spans) == 1
    assert spans[0]["kind"] == "LLM"
    assert spans[0]["status_code"] == "OK"
    assert spans[0]["attributes"]["gen_ai.provider.name"] == provider
    assert spans[0]["attributes"]["gen_ai.operation.name"] == "chat"
    assert [e["id"] for e in evals] == [entry["evaluation"]["id"]]
    return got


ASK = [{"role": "user", "content": "What is the capital of France?"}]


class TestOpenAIChat:
    def test_a_plain_call_arrives_with_input_output_usage_and_a_pass(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        res = _openai(provider, recorder).chat.completions.create(model="gpt-scripted", messages=ASK)
        assert res.choices[0].message.content == REPLIES["default"]
        got = check(iris, stored(recorder, n), agent="openai-py-e2e", input=ASK[0]["content"], output=REPLIES["default"], tokens=(10, 6), provider="openai", verdict="pass")
        attrs = got["spans"][0]["attributes"]
        assert attrs["gen_ai.response.id"] == res.id
        assert attrs["gen_ai.request.model"] == "gpt-scripted"
        assert attrs["gen_ai.response.finish_reasons"] == ["stop"]

    def test_an_answer_that_leaks_an_ssn_is_failed(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        _openai(provider, recorder).chat.completions.create(model="gpt-scripted", messages=[{"role": "system", "content": "You are a clerk."}, {"role": "user", "content": "What is her SSN?"}])
        entry = stored(recorder, n)
        check(iris, entry, agent="openai-py-e2e", input="What is her SSN?", output=REPLIES["ssn"], tokens=(15, 4), provider="openai", verdict="fail")
        assert any(r["ruleName"] == "no_pii" and not r["passed"] for r in entry["evaluation"]["rule_results"])

    def test_a_stream_reads_as_it_would_unwrapped_and_is_recorded_with_usage(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        plain = openai.OpenAI(api_key="scripted", base_url=f"{provider.url}/v1", max_retries=0)
        unwrapped = [c.choices[0].delta.content for c in plain.chat.completions.create(model="gpt-scripted", messages=ASK, stream=True)]
        n = len(recorder.results)
        seen = list(_openai(provider, recorder).chat.completions.create(model="gpt-scripted", messages=ASK, stream=True))
        # The wrapper asked for usage the caller did not; the usage-only chunk it brought is not passed on.
        assert all(len(c.choices) == 1 for c in seen)
        assert [c.choices[0].delta.content for c in seen] == unwrapped
        assert provider.requests()[-1]["body"]["stream_options"] == {"include_usage": True}
        check(iris, stored(recorder, n), agent="openai-py-e2e", input=ASK[0]["content"], output=REPLIES["default"], tokens=(10, 6), provider="openai", verdict="pass")

    def test_a_stream_that_asked_for_usage_itself_gets_the_usage_chunk(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        seen = list(_openai(provider, recorder).chat.completions.create(model="gpt-scripted", messages=ASK, stream=True, stream_options={"include_usage": True}))
        assert seen[-1].choices == [] and seen[-1].usage.total_tokens == 16
        check(iris, stored(recorder, n), agent="openai-py-e2e", input=ASK[0]["content"], output=REPLIES["default"], tokens=(10, 6), provider="openai", verdict="pass")

    def test_the_stream_helper_is_recorded(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        client = _openai(provider, recorder)
        if not hasattr(client.chat.completions, "stream"):
            pytest.skip(f"openai {openai.__version__} has no chat.completions.stream (it arrived out of beta later)")
        n = len(recorder.results)
        with client.chat.completions.stream(model="gpt-scripted", messages=ASK) as stream:
            final = stream.get_final_completion()
        assert final.choices[0].message.content == REPLIES["default"]
        check(iris, stored(recorder, n), agent="openai-py-e2e", input=ASK[0]["content"], output=REPLIES["default"], tokens=(10, 6), provider="openai", verdict="pass")

    def test_parse_is_recorded(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        client = _openai(provider, recorder)
        completions = client.chat.completions if hasattr(client.chat.completions, "parse") else client.beta.chat.completions
        n = len(recorder.results)
        parsed = completions.parse(model="gpt-scripted", messages=ASK)
        assert parsed.choices[0].message.content == REPLIES["default"]
        check(iris, stored(recorder, n), agent="openai-py-e2e", input=ASK[0]["content"], output=REPLIES["default"], tokens=(10, 6), provider="openai", verdict="pass")

    def test_a_tool_call_and_its_follow_up(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        tools = [{"type": "function", "function": {"name": "get_weather", "description": "The weather in a city", "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]}}}]
        client = _openai(provider, recorder)
        ask = [{"role": "user", "content": "What is the weather in Paris?"}]
        n = len(recorder.results)
        first = client.chat.completions.create(model="gpt-scripted", tools=tools, messages=ask)
        call = first.choices[0].message.tool_calls[0]
        got = iris.trace(stored(recorder, n)["trace_id"])
        assert got["trace"]["output"] == json.dumps([{"tool": "get_weather", "arguments": {"city": "Paris"}}], separators=(",", ":"))
        assert [t["name"] for t in got["trace"]["tools"]] == ["get_weather"]
        output = json.loads(got["spans"][0]["attributes"]["gen_ai.output.messages"])
        assert output[0]["parts"][0] == {"type": "tool_call", "id": call.id, "name": "get_weather", "arguments": {"city": "Paris"}}
        assert output[0]["finish_reason"] == "tool_call"

        client.chat.completions.create(
            model="gpt-scripted",
            tools=tools,
            messages=[*ask, first.choices[0].message.model_dump(exclude_none=True), {"role": "tool", "tool_call_id": call.id, "content": "18C, sunny"}],
        )
        check(iris, stored(recorder, n + 1), agent="openai-py-e2e", input=ask[0]["content"], output=REPLIES["after_tool"], tokens=(30, 8), provider="openai", verdict="pass")

    def test_a_refused_call_raises_the_providers_own_error_and_is_recorded_as_an_error(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        with pytest.raises(openai.BadRequestError) as caught:
            _openai(provider, recorder).chat.completions.create(model="gpt-scripted", messages=[{"role": "user", "content": "Trigger a provider error."}])
        assert caught.value.status_code == 400
        entry = stored(recorder, n)
        assert entry["evaluation"] is None
        got = iris.trace(entry["trace_id"])
        assert got["trace"].get("output") is None
        assert got["spans"][0]["status_code"] == "ERROR"
        assert got["spans"][0]["attributes"]["error.type"] == "400"
        assert "scripted provider refused" in got["spans"][0]["status_message"]


class TestOpenAIResponses:
    def test_a_plain_call_with_instructions(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        res = _openai(provider, recorder).responses.create(model="gpt-scripted", instructions="Answer briefly.", input="What is the capital of France?")
        assert res.output_text == REPLIES["default"]
        got = check(iris, stored(recorder, n), agent="openai-py-e2e", input="What is the capital of France?", output=REPLIES["default"], tokens=(15, 6), provider="openai", verdict="pass")
        assert json.loads(got["spans"][0]["attributes"]["gen_ai.system_instructions"]) == [{"type": "text", "content": "Answer briefly."}]

    def test_a_stream_and_the_stream_helper(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        text = "".join(e.delta for e in _openai(provider, recorder).responses.create(model="gpt-scripted", input="What is her SSN?", stream=True) if e.type == "response.output_text.delta")
        assert text == REPLIES["ssn"]
        check(iris, stored(recorder, n), agent="openai-py-e2e", input="What is her SSN?", output=REPLIES["ssn"], tokens=(10, 4), provider="openai", verdict="fail")

        n = len(recorder.results)
        with _openai(provider, recorder).responses.stream(model="gpt-scripted", input="What is the capital of France?") as stream:
            final = stream.get_final_response()
        assert final.output_text == REPLIES["default"]
        check(iris, stored(recorder, n), agent="openai-py-e2e", input="What is the capital of France?", output=REPLIES["default"], tokens=(10, 6), provider="openai", verdict="pass")


class TestAnthropicMessages:
    def test_a_plain_call_with_the_system_prompt_kept_apart(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        res = _anthropic(provider, recorder).messages.create(model="claude-scripted", max_tokens=256, system="You are terse.", messages=ASK)
        assert res.content[0].text == REPLIES["default"]
        got = check(iris, stored(recorder, n), agent="anthropic-py-e2e", input=ASK[0]["content"], output=REPLIES["default"], tokens=(15, 6), provider="anthropic", verdict="pass")
        attrs = got["spans"][0]["attributes"]
        assert attrs["gen_ai.request.max_tokens"] == 256
        assert attrs["gen_ai.response.finish_reasons"] == ["end_turn"]
        assert json.loads(attrs["gen_ai.system_instructions"]) == [{"type": "text", "content": "You are terse."}]

    def test_stream_true_and_the_stream_helper(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        events = _anthropic(provider, recorder).messages.create(model="claude-scripted", max_tokens=64, stream=True, messages=[{"role": "user", "content": "What is her SSN?"}])
        text = "".join(e.delta.text for e in events if e.type == "content_block_delta" and e.delta.type == "text_delta")
        assert text == REPLIES["ssn"]
        check(iris, stored(recorder, n), agent="anthropic-py-e2e", input="What is her SSN?", output=REPLIES["ssn"], tokens=(10, 4), provider="anthropic", verdict="fail")

        n = len(recorder.results)
        with _anthropic(provider, recorder).messages.stream(model="claude-scripted", max_tokens=64, messages=ASK) as stream:
            message = stream.get_final_message()
        assert message.content[0].text == REPLIES["default"]
        check(iris, stored(recorder, n), agent="anthropic-py-e2e", input=ASK[0]["content"], output=REPLIES["default"], tokens=(10, 6), provider="anthropic", verdict="pass")

    def test_a_streamed_tool_call_has_its_arguments_reassembled(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        n = len(recorder.results)
        tools = [{"name": "get_weather", "description": "The weather in a city", "input_schema": {"type": "object", "properties": {"city": {"type": "string"}}}}]
        with _anthropic(provider, recorder).messages.stream(model="claude-scripted", max_tokens=64, tools=tools, messages=[{"role": "user", "content": "What is the weather in Paris?"}]) as stream:
            message = stream.get_final_message()
        assert message.stop_reason == "tool_use"
        got = iris.trace(stored(recorder, n)["trace_id"])
        assert got["trace"]["output"] == "Let me check the weather."
        output = json.loads(got["spans"][0]["attributes"]["gen_ai.output.messages"])
        assert output[0]["parts"][1] == {"type": "tool_call", "id": message.content[1].id, "name": "get_weather", "arguments": {"city": "Paris"}}


class TestAsync:
    async def test_async_openai_plain_and_streamed(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        client = _openai(provider, recorder, openai.AsyncOpenAI)
        n = len(recorder.results)
        res = await client.chat.completions.create(model="gpt-scripted", messages=ASK)
        assert res.choices[0].message.content == REPLIES["default"]
        check(iris, stored(recorder, n), agent="openai-py-e2e", input=ASK[0]["content"], output=REPLIES["default"], tokens=(10, 6), provider="openai", verdict="pass")

        n = len(recorder.results)
        chunks = [c async for c in await client.chat.completions.create(model="gpt-scripted", messages=[{"role": "user", "content": "What is her SSN?"}], stream=True)]
        assert "".join(c.choices[0].delta.content or "" for c in chunks) == REPLIES["ssn"]
        check(iris, stored(recorder, n), agent="openai-py-e2e", input="What is her SSN?", output=REPLIES["ssn"], tokens=(10, 4), provider="openai", verdict="fail")

    async def test_async_anthropic_stream_helper(self, iris: Iris, provider: Provider, recorder: IrisRecorder) -> None:
        client = _anthropic(provider, recorder, anthropic.AsyncAnthropic)
        n = len(recorder.results)
        async with client.messages.stream(model="claude-scripted", max_tokens=64, messages=ASK) as stream:
            message = await stream.get_final_message()
        assert message.content[0].text == REPLIES["default"]
        check(iris, stored(recorder, n), agent="anthropic-py-e2e", input=ASK[0]["content"], output=REPLIES["default"], tokens=(10, 6), provider="anthropic", verdict="pass")


class TestWrapping:
    def test_same_class_original_untouched_no_double_wrap_and_with_options_stays_wrapped(self, provider: Provider, recorder: IrisRecorder) -> None:
        original = openai.OpenAI(api_key="scripted", base_url=f"{provider.url}/v1", max_retries=0)
        wrapped = wrap_openai(original, recorder=recorder)
        assert isinstance(wrapped, openai.OpenAI)
        assert wrapped is not original
        assert wrap_openai(wrapped, recorder=recorder) is wrapped

        n = len(recorder.results)
        original.chat.completions.create(model="gpt-scripted", messages=ASK)
        recorder.flush()
        assert len(recorder.results) == n, "the original client records nothing"
        wrapped.with_options(timeout=5).chat.completions.create(model="gpt-scripted", messages=ASK)
        stored(recorder, n)

    def test_other_endpoints_and_raw_responses_pass_through_unrecorded(self, provider: Provider, recorder: IrisRecorder) -> None:
        client = _openai(provider, recorder)
        n = len(recorder.results)
        with pytest.raises(openai.NotFoundError):
            client.models.list()
        raw = client.chat.completions.with_raw_response.create(model="gpt-scripted", messages=ASK)
        assert raw.parse().choices[0].message.content == REPLIES["default"]
        recorder.flush()
        assert len(recorder.results) == n

    def test_not_a_provider_client_is_refused_by_name(self) -> None:
        with pytest.raises(TypeError, match="wrap_openai: expected a client"):
            wrap_openai(object())
