# Exercise 10: Complete Multi-Agent Trip Planner Architecture with Deterministic Validation & Replanning
from typing import TypedDict, Literal
from langgraph.graph import StateGraph, START, END

# 1. Comprehensive State Schema
class TripPlannerState(TypedDict):
    user_request: str
    destination: str
    budget_limit: float
    next_step: str
    research_data: str
    weather_data: str
    calculated_cost: float
    budget_status: str
    itinerary: str
    validation_passed: bool
    replanning_count: int

# 2. Intake Node (Deterministic User Request Parsing)
def intake_node(state: TripPlannerState):
    print("\n  [Intake Node] Processing user input...")
    # Extract destination and budget limit deterministically from input
    request = state["user_request"]
    destination = "Chennai" if "Chennai" in request else "Destination"
    budget_limit = 15000.0  # ₹15,000 budget constraint
    
    print(f"  --> Extracted Destination: {destination}, Budget Limit: ₹{budget_limit:,.2f}")
    return {
        "destination": destination,
        "budget_limit": budget_limit,
        "replanning_count": 0
    }

# 3. Supervisor Node (Dynamic Task Dispatcher)
def supervisor_node(state: TripPlannerState):
    print("\n  [Supervisor] Checking gathered information...")
    if not state.get("research_data"):
        print("  [Supervisor] Decision -> Dispatching to Research Agent")
        return {"next_step": "Research"}
    elif not state.get("weather_data"):
        print("  [Supervisor] Decision -> Dispatching to Weather Agent")
        return {"next_step": "Weather"}
    elif state.get("calculated_cost", 0.0) == 0.0:
        print("  [Supervisor] Decision -> Dispatching to Budget Agent")
        return {"next_step": "Budget"}
    else:
        print("  [Supervisor] Decision -> All pre-requisites met. Forwarding to Planning Agent!")
        return {"next_step": "Planning"}

def route_supervisor(state: TripPlannerState) -> Literal["research_agent", "weather_agent", "budget_agent", "planning_agent"]:
    mapping = {
        "Research": "research_agent",
        "Weather": "weather_agent",
        "Budget": "budget_agent",
        "Planning": "planning_agent"
    }
    return mapping[state["next_step"]]

# 4. Worker Nodes / Agents
def research_agent(state: TripPlannerState):
    print("  [Research Agent] Finding top places, food, and stays...")
    return {
        "research_data": "Places: Marina Beach, Kapaleeshwarar Temple; Stay: SeaView Resort; Dining: Annalakshmi"
    }

def weather_agent(state: TripPlannerState):
    print("  [Weather Agent] Fetching weather forecast...")
    return {
        "weather_data": "Weather: Pleasant Evening 27°C, Light breeze"
    }

def budget_agent(state: TripPlannerState):
    print("  [Budget Agent - Deterministic Cost Calculation] Computing total estimated costs...")
    # Initial calculation slightly exceeds or fits budget to test validation
    cost = 16500.0  # ₹16,500 initial estimation
    return {
        "calculated_cost": cost,
        "budget_status": f"Estimated Cost: ₹{cost:,.2f} vs Limit: ₹{state['budget_limit']:,.2f}"
    }

# 5. Planning Agent
def planning_agent(state: TripPlannerState):
    replans = state.get("replanning_count", 0)
    print(f"\n  [Planning Agent] Synthesizing Itinerary (Revision #{replans + 1})...")
    
    cost = state["calculated_cost"]
    itinerary = (
        f"=== Trip Plan for {state['destination']} (Revision #{replans + 1}) ===\n"
        f"Research: {state['research_data']}\n"
        f"Weather: {state['weather_data']}\n"
        f"Total Estimated Cost: ₹{cost:,.2f} (Budget Limit: ₹{state['budget_limit']:,.2f})"
    )
    return {"itinerary": itinerary}

# 6. Validation Node (Deterministic Check)
def validation_node(state: TripPlannerState):
    cost = state["calculated_cost"]
    limit = state["budget_limit"]
    is_valid = cost <= limit
    
    print(f"\n  [Validation Node - Deterministic Rule Check]")
    print(f"  --> Total Cost (₹{cost:,.2f}) <= Limit (₹{limit:,.2f}) ? => {is_valid}")
    
    return {"validation_passed": is_valid}

def route_validation(state: TripPlannerState) -> Literal[END, "replanning_node"]:
    if state.get("validation_passed"):
        print("  [Validation Route] -> Plan APPROVED! Routing to END.")
        return END
    else:
        print("  [Validation Route] -> Plan OVER BUDGET! Routing to Replanning Node...")
        return "replanning_node"

# 7. Replanning Node (Adjusts Parameters on Validation Failure)
def replanning_node(state: TripPlannerState):
    count = state.get("replanning_count", 0) + 1
    print(f"\n  [Replanning Node] Optimizing plan to fit budget (Attempt #{count})...")
    
    # Adjust research and cost downwards to meet budget constraint
    adjusted_cost = 13500.0  # Reduced to ₹13,500
    adjusted_research = "Places: Marina Beach, Kapaleeshwarar Temple; Stay: Heritage Inn (Budget); Dining: Local Eateries"
    
    return {
        "replanning_count": count,
        "calculated_cost": adjusted_cost,
        "research_data": adjusted_research,
        "budget_status": f"Adjusted Cost: ₹{adjusted_cost:,.2f} vs Limit: ₹{state['budget_limit']:,.2f}"
    }

# 8. Build Full Graph Architecture
builder = StateGraph(TripPlannerState)

# Add all nodes
builder.add_node("intake", intake_node)
builder.add_node("supervisor", supervisor_node)
builder.add_node("research_agent", research_agent)
builder.add_node("weather_agent", weather_agent)
builder.add_node("budget_agent", budget_agent)
builder.add_node("planning_agent", planning_agent)
builder.add_node("validation_node", validation_node)
builder.add_node("replanning_node", replanning_node)

# Connect Edges:
# User -> Intake -> Supervisor
builder.add_edge(START, "intake")
builder.add_edge("intake", "supervisor")

# Supervisor conditional routing to worker agents
builder.add_conditional_edges(
    "supervisor",
    route_supervisor,
    {
        "research_agent": "research_agent",
        "weather_agent": "weather_agent",
        "budget_agent": "budget_agent",
        "planning_agent": "planning_agent"
    }
)

# Workers return to Supervisor
builder.add_edge("research_agent", "supervisor")
builder.add_edge("weather_agent", "supervisor")
builder.add_edge("budget_agent", "supervisor")

# Planning Agent -> Validation Node
builder.add_edge("planning_agent", "validation_node")

# Validation Node conditional routing -> END or Replanning
builder.add_conditional_edges(
    "validation_node",
    route_validation,
    {
        END: END,
        "replanning_node": "replanning_node"
    }
)

# Replanning -> Planning Agent loop
builder.add_edge("replanning_node", "planning_agent")

graph = builder.compile()

if __name__ == "__main__":
    print("==================================================")
    print("  EXERCISE 10: Complete Trip Planner Architecture")
    print("==================================================")
    
    initial_request = {
        "user_request": "Plan a 2-day vacation to Chennai with ₹15,000 budget",
        "destination": "",
        "budget_limit": 0.0,
        "next_step": "",
        "research_data": "",
        "weather_data": "",
        "calculated_cost": 0.0,
        "budget_status": "",
        "itinerary": "",
        "validation_passed": False,
        "replanning_count": 0
    }
    
    final_state = graph.invoke(initial_request)
    
    print("\n==================================================")
    print("  FINAL APPROVED ITINERARY")
    print("==================================================")
    print(final_state["itinerary"])
    print(f"\nFinal Validation Passed: {final_state['validation_passed']}")
    print(f"Replanning Cycles Run: {final_state['replanning_count']}")
    print("==================================================")
