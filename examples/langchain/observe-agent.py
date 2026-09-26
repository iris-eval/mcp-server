"""
Iris + LangGraph: every run of an agent, scored, with its tool calls.

A real LangGraph agent (a model node, LangGraph's ToolNode, and
tools_condition between them) with Iris's callback handler in its callbacks.
Each run arrives in Iris as one trace: the question, the answer, each tool
call with its arguments and result, the token usage and a verdict. CI runs
this same graph with a scripted model in place of Claude
(packages/python/tests/langgraph_app.py and test_langchain_e2e.py).

Prerequisites:
  pip install "iris-eval @ git+https://github.com/iris-eval/mcp-server#subdirectory=packages/python" \
      langgraph langchain-anthropic
  export ANTHROPIC_API_KEY=...
  Start Iris with its dashboard:  npx -y @iris-eval/mcp-server --dashboard
  (started with --api-key? set IRIS_API_KEY in this shell)

Then:  python observe-agent.py
"""

from langchain_anthropic import ChatAnthropic
from langchain_core.tools import tool
from langgraph.graph import START, MessagesState, StateGraph
from langgraph.prebuilt import ToolNode, tools_condition

from iris_eval import IrisRecorder
from iris_eval.langchain import IrisCallbackHandler


@tool
def get_weather(city: str) -> str:
    """The current weather in a city."""
    return f"18C and sunny in {city}"


def build_graph():
    model = ChatAnthropic(model="claude-sonnet-5").bind_tools([get_weather])

    def call_model(state: MessagesState):
        return {"messages": [model.invoke(state["messages"])]}

    graph = StateGraph(MessagesState)
    graph.add_node("agent", call_model)
    graph.add_node("tools", ToolNode([get_weather]))
    graph.add_edge(START, "agent")
    graph.add_conditional_edges("agent", tools_condition)
    graph.add_edge("tools", "agent")
    return graph.compile()


def main():
    # The recorder finds Iris from IRIS_URL, or the runtime.json a running dashboard wrote.
    recorder = IrisRecorder()
    iris = IrisCallbackHandler(recorder=recorder, agent_name="weather-agent")

    result = build_graph().invoke({"messages": [("user", "What is the weather in Paris?")]}, config={"callbacks": [iris]})
    print("Answer:", result["messages"][-1].content)

    # Delivery is in the background; a short script waits for it before reading what Iris said.
    recorder.flush()
    for stored in recorder.results:
        evaluation = stored.get("evaluation") or {}
        verdict = evaluation.get("verdict", {})
        print(f"Iris trace {stored['trace_id']}: {stored['steps']} tool step(s), verdict {verdict.get('state')} ({verdict.get('basis')})")
    recorder.close()


if __name__ == "__main__":
    main()
