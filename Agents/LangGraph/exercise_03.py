# Agent Loop with Termination Safeguard
from typing import TypedDict
from langgraph.graph import StateGraph, START, END

class State(TypedDict):
    question: str
    research: str
    sufficient: bool
    iterations: int

def research(state: State):
    current_iterations = state.get("iterations", 0) + 1
    new_info = f"\n- Iteration {current_iterations}: Found information about {state['question']}."
    updated_research = state.get("research", "") + new_info
    
    return {
        "research": updated_research,
        "iterations": current_iterations
    }

def evaluate(state: State):
    # Simulate evaluation: e.g., consider sufficient if iterations reached 2 or enough research collected
    # Here we mark sufficient if iterations >= 2 (or based on content length)
    is_sufficient = state.get("iterations", 0) >= 2
    return {
        "sufficient": is_sufficient
    }

def route_evaluation(state: State):
    # Termination Safeguard: Stop if iterations >= 3 or if sufficient info was found
    if state.get("iterations", 0) >= 3 or state.get("sufficient", False):
        return "sufficient"
    return "insufficient"

# Build Graph
builder = StateGraph(State)

# Add Nodes
builder.add_node("research", research)
builder.add_node("evaluate", evaluate)

# Set Flow
builder.add_edge(START, "research")
builder.add_edge("research", "evaluate")

# Add Conditional Edge from evaluate node
builder.add_conditional_edges(
    "evaluate",
    route_evaluation,
    {
        "insufficient": "research",
        "sufficient": END
    }
)

graph = builder.compile()

if __name__ == "__main__":
    initial_state = {
        "question": "What are the benefits of LangGraph?",
        "research": "",
        "sufficient": False,
        "iterations": 0
    }

    result = graph.invoke(initial_state)
    print("--- Final Result ---")
    print(f"Total Iterations: {result['iterations']}")
    print(f"Sufficient: {result['sufficient']}")
    print("Research Gathered:")
    print(result['research'])
