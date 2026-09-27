"""A real LangGraph app with a scripted model, for the end-to-end tests.

The graph is the canonical tool loop — a model node, LangGraph's own
``ToolNode``, and ``tools_condition`` between them — built from
``langgraph`` and ``langchain-core`` as an application would build it. Only
the model is scripted, so the run needs no key and gives the same result
every time:

- asked about the weather, it calls the first tool it was given (the
  graph's ``get_weather``) and then answers from the tool's result: "It is
  18 degrees and sunny in Paris."
- asked for an SSN, it answers "Her SSN is 123-45-6789." without a tool
- anything else: "The capital of France is Paris."

Token usage is fixed per turn (10 in and 12 out for the tool request, 30 in
and 8 out for the answer after it; 10 in and 4 or 6 out for a direct answer)
so a test can hold the trace to exact numbers.
"""

from __future__ import annotations

from typing import Any

from langchain_core.language_models.chat_models import BaseChatModel
from langchain_core.messages import AIMessage, BaseMessage, ToolMessage
from langchain_core.outputs import ChatGeneration, ChatResult
from langchain_core.tools import tool
from langchain_core.utils.function_calling import convert_to_openai_tool
from langgraph.graph import END, START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

ANSWER = "The capital of France is Paris."
SSN = "Her SSN is 123-45-6789."
AFTER_TOOL = "It is 18 degrees and sunny in Paris."
MODEL = "scripted-model"


def _text(message: BaseMessage) -> str:
    content = message.content
    return content if isinstance(content, str) else " ".join(b.get("text", "") for b in content if isinstance(b, dict))


class ScriptedChatModel(BaseChatModel):
    """A chat model that answers from a script, with tool calls and token usage like a real one."""

    model_name: str = MODEL

    @property
    def _llm_type(self) -> str:
        return "scripted"

    def _get_ls_params(self, stop: list[str] | None = None, **kwargs: Any) -> Any:
        params = super()._get_ls_params(stop=stop, **kwargs)
        params["ls_provider"] = "scripted"
        params["ls_model_name"] = self.model_name
        return params

    def bind_tools(self, tools: Any, **kwargs: Any) -> Any:
        return self.bind(tools=[convert_to_openai_tool(t) for t in tools], **kwargs)

    def _generate(self, messages: list[BaseMessage], stop: list[str] | None = None, run_manager: Any = None, **kwargs: Any) -> ChatResult:
        last = messages[-1]
        asked = next((_text(m) for m in reversed(messages) if m.type == "human"), "")
        meta = {"model_name": self.model_name}
        if isinstance(last, ToolMessage):
            msg = AIMessage(content=AFTER_TOOL, usage_metadata={"input_tokens": 30, "output_tokens": 8, "total_tokens": 38}, response_metadata={**meta, "finish_reason": "stop"})
        elif kwargs.get("tools") and "weather" in asked.lower():
            msg = AIMessage(
                content="",
                tool_calls=[{"id": "call_weather_1", "name": kwargs["tools"][0]["function"]["name"], "args": {"city": "Paris"}}],
                usage_metadata={"input_tokens": 10, "output_tokens": 12, "total_tokens": 22},
                response_metadata={**meta, "finish_reason": "tool_calls"},
            )
        elif "ssn" in asked.lower():
            msg = AIMessage(content=SSN, usage_metadata={"input_tokens": 10, "output_tokens": 4, "total_tokens": 14}, response_metadata={**meta, "finish_reason": "stop"})
        else:
            msg = AIMessage(content=ANSWER, usage_metadata={"input_tokens": 10, "output_tokens": 6, "total_tokens": 16}, response_metadata={**meta, "finish_reason": "stop"})
        return ChatResult(generations=[ChatGeneration(message=msg)])


@tool
def get_weather(city: str) -> str:
    """The weather in a city."""
    return f"18C, sunny in {city}"


@tool
def broken_weather(city: str) -> str:
    """The weather in a city, from a service that is down."""
    raise RuntimeError(f"the weather service is down for {city}")


def build_graph(tools: list[Any] | None = None, **compile_kwargs: Any) -> Any:
    """The tool loop: model → tools → model, until the model answers without a tool call."""
    tools = tools if tools is not None else [get_weather]
    model = ScriptedChatModel().bind_tools(tools)

    def call_model(state: MessagesState) -> dict[str, list[BaseMessage]]:
        return {"messages": [model.invoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("agent", call_model)
    graph.add_node("tools", ToolNode(tools))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", tools_condition)
    graph.add_edge("tools", "agent")
    return graph.compile(**compile_kwargs)


__all__ = ["AFTER_TOOL", "ANSWER", "END", "MODEL", "SSN", "ScriptedChatModel", "broken_weather", "build_graph", "get_weather"]
