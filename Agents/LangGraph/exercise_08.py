# Exercise 8: Supervisor Multi-Agent System Architecture
from typing import TypedDict, Literal
from langgraph.graph import StateGraph, START, END

# 1. Shared State Schema
class State(TypedDict):
    user_request: str
    next_agent: str
    research: str
    weather: str
    budget: str
    itinerary: str

# 2. Worker Agents
def research_agent(state: State):
    print("  [Research Agent] Gathering places, restaurants, and accommodation...")
    return {
        "research": "Places: Marina Beach, Kapaleeshwarar Temple | Dining: Saravana Bhavan | Stay: Grand Hotel"
    }

def weather_agent(state: State):
    print("  [Weather Agent] Fetching weather forecast...")
    return {
        "weather": "Forecast: Partly Cloudy, 29°C, 15% Humidity"
    }

def budget_agent(state: State):
    print("  [Budget Agent] Validating costs and budget constraints...")
    return {
        "budget": "Estimated Total Cost: ₹12,500 (Within ₹15,000 Budget Limit)"
    }

def planner_agent(state: State):
    print("  [Planner Agent] Synthesizing all agent outputs into final itinerary...")
    itinerary = (
        "=== 2-Day Trip Itinerary ===\n"
        f"Request: {state['user_request']}\n"
        f"1. Research Details: {state['research']}\n"
        f"2. Weather Conditions: {state['weather']}\n"
        f"3. Budget Validation: {state['budget']}\n"
        "Plan: Day 1 Beach & Temple visit; Day 2 Dining & Shopping."
    )
    return {"itinerary": itinerary}

# 3. Supervisor Node (Orchestrator)
def supervisor_node(state: State):
    print("\n  [Supervisor] Evaluating graph state...")
    if not state.get("research"):
        print("  [Supervisor] Choice -> Dispatching to Research Agent")
        return {"next_agent": "Research"}
    elif not state.get("weather"):
        print("  [Supervisor] Choice -> Dispatching to Weather Agent")
        return {"next_agent": "Weather"}
    elif not state.get("budget"):
        print("  [Supervisor] Choice -> Dispatching to Budget Agent")
        return {"next_agent": "Budget"}
    else:
        print("  [Supervisor] Choice -> All information gathered! Dispatching to Planner Agent")
        return {"next_agent": "Planner"}

# Conditional edge function
def route_supervisor(state: State) -> Literal["research_agent", "weather_agent", "budget_agent", "planner_agent"]:
    agent_map = {
        "Research": "research_agent",
        "Weather": "weather_agent",
        "Budget": "budget_agent",
        "Planner": "planner_agent"
    }
    return agent_map[state["next_agent"]]

# 4. Build Multi-Agent Graph
builder = StateGraph(State)

builder.add_node("supervisor", supervisor_node)
builder.add_node("research_agent", research_agent)
builder.add_node("weather_agent", weather_agent)
builder.add_node("budget_agent", budget_agent)
builder.add_node("planner_agent", planner_agent)

# Workflow Routing: START -> Supervisor
builder.add_edge(START, "supervisor")

# Supervisor conditional routing to worker agents
builder.add_conditional_edges(
    "supervisor",
    route_supervisor,
    {
        "research_agent": "research_agent",
        "weather_agent": "weather_agent",
        "budget_agent": "budget_agent",
        "planner_agent": "planner_agent"
    }
)

# Workers loop back to Supervisor
builder.add_edge("research_agent", "supervisor")
builder.add_edge("weather_agent", "supervisor")
builder.add_edge("budget_agent", "supervisor")

# Planner terminates graph
builder.add_edge("planner_agent", END)

graph = builder.compile()

if __name__ == "__main__":
    print("==================================================")
    print("  EXERCISE 8: Supervisor Multi-Agent System")
    print("==================================================")
    
    initial_input = {
        "user_request": "Plan a 2-day budget trip to Chennai",
        "next_agent": "",
        "research": "",
        "weather": "",
        "budget": "",
        "itinerary": ""
    }
    
    final_state = graph.invoke(initial_input)
    
    print("\n==================================================")
    print("  FINAL ITINERARY PRODUCED BY PLANNER AGENT")
    print("==================================================")
    print(final_state["itinerary"])
    print("==================================================")
