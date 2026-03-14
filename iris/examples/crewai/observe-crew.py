"""
Iris + CrewAI Integration Example

Logs CrewAI crew task executions to Iris for observability.

Prerequisites:
  pip install crewai mcp
  Start Iris: npx @iris-eval/mcp-server --transport http --dashboard

Note: This is a conceptual example showing how to instrument
a CrewAI crew with Iris trace logging.
"""

import time


def log_crew_trace(crew_name, task_description, result, latency_ms, agents_used=None):
    """Log a CrewAI crew execution trace to Iris."""
    trace = {
        "agent_name": crew_name,
        "framework": "crewai",
        "input": task_description,
        "output": result,
        "latency_ms": latency_ms,
        "metadata": {
            "agents_used": agents_used or [],
            "framework_version": "crewai",
        },
    }

    print(f"Logged crew trace for '{crew_name}': {result[:50]}...")
    print(f"  Task: {task_description[:50]}...")
    print(f"  Latency: {latency_ms}ms")
    if agents_used:
        print(f"  Agents: {', '.join(agents_used)}")


def main():
    """Example: instrument a CrewAI crew run."""
    # --- Your CrewAI code goes here ---
    # from crewai import Crew, Agent, Task
    # researcher = Agent(role="Researcher", ...)
    # writer = Agent(role="Writer", ...)
    # task = Task(description="Research and write about AI observability", ...)
    # crew = Crew(agents=[researcher, writer], tasks=[task])
    # result = crew.kickoff()
    # ---

    # Simulated output for this example
    start = time.time()
    task_description = "Research and write a summary about AI agent observability best practices"
    result = "AI agent observability requires three pillars: trace logging for execution flow, quality evaluation for output scoring, and drift detection for monitoring changes over time."
    latency_ms = (time.time() - start) * 1000 + 8500  # simulated

    log_crew_trace(
        crew_name="research-crew",
        task_description=task_description,
        result=result,
        latency_ms=latency_ms,
        agents_used=["researcher", "writer"],
    )


if __name__ == "__main__":
    main()
