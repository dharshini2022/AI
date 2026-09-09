#Assembles and compiles the StateGraph
from langgraph.graph import StateGraph, START, END
from hands_on.state import GraphState
from hands_on.nodes import worker_node
from hands_on.dispatcher import dynamic_fan_out


def create_dynamic_graph():
    #Builds and compiles the dynamic multi-instance graph
    builder = StateGraph(GraphState)

    # 1. Register worker node blueprint
    builder.add_node("worker_node", worker_node)

    # 2. Dynamic Fan-Out directly from START: START -> [Send(worker_node)]
    builder.add_conditional_edges(
        START,              # Start directly here
        dynamic_fan_out,    # Function generating Send() instances
        ["worker_node"]     # Target node whitelist
    )

    # 3. Once all dynamic workers finish and merge, graph ends
    builder.add_edge("worker_node", END)

    return builder.compile()


# Compiled singleton ready for use
app = create_dynamic_graph()
