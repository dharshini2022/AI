"""graph.py - Assembles and compiles the StateGraph."""
from langgraph.graph import StateGraph, START, END
from agent_spin_up.state import AuditGraphState
from agent_spin_up.nodes import orchestrator_node, specialist_agent_node, synthesizer_node
from agent_spin_up.dispatcher import dynamic_agent_dispatcher


def create_auditor_graph():
    builder = StateGraph(AuditGraphState)

    # 1. Register node blueprints
    builder.add_node("orchestrator", orchestrator_node)
    builder.add_node("specialist_agent", specialist_agent_node)
    builder.add_node("synthesizer", synthesizer_node)

    # 2. Wire entry
    builder.add_edge(START, "orchestrator")

    # 3. Dynamic Fan-out: orchestrator -> [N x Send(specialist_agent)]
    builder.add_conditional_edges(
        "orchestrator",
        dynamic_agent_dispatcher,
        ["specialist_agent"]
    )

    # 4. Synchronization Barrier: all dynamic workers join at synthesizer
    builder.add_edge("specialist_agent", "synthesizer")
    builder.add_edge("synthesizer", END)

    return builder.compile()


app = create_auditor_graph()
