# Dynamic branching and fan-out logic
from typing import List
from langgraph.types import Send
from hands_on.state import GraphState


def dynamic_fan_out(state: GraphState) -> List[Send]:
    #Dynamic dispatcher: inspects the count at runtime and spins up N instances
    n = state["count"]
    print(f"\n[Dispatcher] Generating {n} dynamic Send() payloads...")
    
    #Builds a list of Send objects that tells LangGraph to execute the worker_node N times in parallel with unique inputs
    return [
        # Send(): instructs LangGraph to invoke the 'worker_node' with a separate state payload for each.
        #worker_node is the node selected
        #{"worker_id": i + 1}: isolated payload for each instance => woker state input
        Send("worker_node", {"worker_id": i + 1})
        for i in range(n)
    ]
