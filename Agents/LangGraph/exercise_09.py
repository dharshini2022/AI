# Exercise 9: Subgraph Modularity (Embedding Subgraphs inside Parent Graph)
from typing import TypedDict
from langgraph.graph import StateGraph, START, END

# ==================================================
# 1. RESEARCH SUBGRAPH (Internal Iterative Process)
# ==================================================

class ResearchState(TypedDict):
    query: str
    findings: list[str]
    search_count: int
    is_enough: bool

def sub_search(state: ResearchState):
    count = state.get("search_count", 0) + 1
    new_finding = f"Finding #{count}: Discovered popular place/activity in {state['query']}"
    print(f"    [Subgraph - Node: Search] Execution #{count} -> Added: '{new_finding}'")
    
    current_findings = state.get("findings", [])
    return {
        "search_count": count,
        "findings": current_findings + [new_finding]
    }

def sub_evaluate(state: ResearchState):
    count = state.get("search_count", 0)
    # Evaluate if we have gathered enough information (e.g. >= 2 iterations)
    enough = count >= 2
    print(f"    [Subgraph - Node: Evaluate] Total findings: {len(state['findings'])}. Is enough? {enough}")
    return {"is_enough": enough}

def sub_evaluate_router(state: ResearchState):
    if state.get("is_enough"):
        return END
    else:
        return "sub_search"

# Build Research Subgraph
sub_builder = StateGraph(ResearchState)
sub_builder.add_node("sub_search", sub_search)
sub_builder.add_node("sub_evaluate", sub_evaluate)

sub_builder.add_edge(START, "sub_search")
sub_builder.add_edge("sub_search", "sub_evaluate")
sub_builder.add_conditional_edges("sub_evaluate", sub_evaluate_router)

research_subgraph = sub_builder.compile()

# ==================================================
# 2. MAIN GRAPH (Parent Workflow)
# ==================================================

class MainState(TypedDict):
    user_request: str
    research: str
    weather: str
    budget: str
    itinerary: str

# Adapter node that runs the Research Subgraph
def run_research_subgraph(state: MainState):
    print("\n  [Main Graph] Step 1: Entering Research Subgraph...")
    subgraph_input = {
        "query": state["user_request"],
        "findings": [],
        "search_count": 0,
        "is_enough": False
    }
    
    subgraph_result = research_subgraph.invoke(subgraph_input)
    combined_findings = " | ".join(subgraph_result["findings"])
    print(f"  [Main Graph] Research Subgraph Completed! Result: {combined_findings}")
    
    return {"research": combined_findings}

def weather_node(state: MainState):
    print("\n  [Main Graph] Step 2: Fetching Weather Data...")
    return {"weather": "Chennai Weather: Sunny, 30°C"}

def budget_node(state: MainState):
    print("\n  [Main Graph] Step 3: Calculating Budget...")
    return {"budget": "Estimated Budget: ₹10,000"}

def planner_node(state: MainState):
    print("\n  [Main Graph] Step 4: Generating Master Plan...")
    plan = (
        "=== Master Travel Plan ===\n"
        f"Request: {state['user_request']}\n"
        f"Research: {state['research']}\n"
        f"Weather: {state['weather']}\n"
        f"Budget: {state['budget']}"
    )
    return {"itinerary": plan}

# Build Main Graph
main_builder = StateGraph(MainState)

main_builder.add_node("research_subgraph", run_research_subgraph)
main_builder.add_node("weather", weather_node)
main_builder.add_node("budget", budget_node)
main_builder.add_node("planner", planner_node)

main_builder.add_edge(START, "research_subgraph")
main_builder.add_edge("research_subgraph", "weather")
main_builder.add_edge("weather", "budget")
main_builder.add_edge("budget", "planner")
main_builder.add_edge("planner", END)

main_graph = main_builder.compile()

if __name__ == "__main__":
    print("==================================================")
    print("  EXERCISE 9: Subgraph Modularity & Hierarchy")
    print("==================================================")
    
    input_data = {
        "user_request": "Explore Chennai Heritage",
        "research": "",
        "weather": "",
        "budget": "",
        "itinerary": ""
    }
    
    final_output = main_graph.invoke(input_data)
    
    print("\n==================================================")
    print("  FINAL RESULT FROM MAIN GRAPH")
    print("==================================================")
    print(final_output["itinerary"])
    print("==================================================")
