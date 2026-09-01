# Exercise 7: Failure Handling, Retry Logic, and Fallback Routing
import time
from typing import TypedDict
from langgraph.graph import StateGraph, START, END

# 1. Define State Schema
class State(TypedDict):
    city: str
    attempts: int
    hotel_results: str
    status: str

# Simulated API failure counter for demonstration
simulated_api_calls = 0

# 2. Define Tool / Action Node with Intentional Failure
def search_hotels(state: State):
    global simulated_api_calls
    simulated_api_calls += 1
    current_attempt = state.get("attempts", 0) + 1
    
    print(f"\n  [Node: search_hotels] Execution Attempt #{current_attempt} (Total API calls: {simulated_api_calls})")
    
    # Intentionally fail API call
    try:
        print("  --> Contacting Hotel Search API...")
        # Simulate API unavailable error
        raise Exception("API unavailable: 503 Service Unavailable")
    except Exception as e:
        print(f"  [ERROR]: {e}")
        return {
            "attempts": current_attempt,
            "status": "FAILED",
            "hotel_results": ""
        }

# 3. Fallback Node when retries are exhausted
def fallback_hotel_search(state: State):
    print("\n  [Node: fallback_hotel_search] Maximum retries reached (3/3). Triggering Fallback!")
    return {
        "hotel_results": f"Cached Fallback: Standard Hotel in {state['city']} (Offline Cache)",
        "status": "FALLBACK_SUCCESS"
    }

# 4. Success / Formatting Node
def format_results(state: State):
    print("\n  [Node: format_results] Formatting final response...")
    return {
        "status": f"SUCCESS: {state['hotel_results']}"
    }

# 5. Conditional Router for Retry & Fallback Decision
def router(state: State):
    if state.get("status") == "SUCCESS" or state.get("hotel_results"):
        return "format_results"
    
    if state.get("attempts", 0) < 3:
        print(f"  [Router] Attempt {state.get('attempts')} failed. Retrying search_hotels...")
        return "search_hotels"
    else:
        print(f"  [Router] Max attempts reached ({state.get('attempts')}/3). Routing to fallback_hotel_search...")
        return "fallback_hotel_search"

# 6. Build Graph Architecture
builder = StateGraph(State)

builder.add_node("search_hotels", search_hotels)
builder.add_node("fallback_hotel_search", fallback_hotel_search)
builder.add_node("format_results", format_results)

# Entry point
builder.add_edge(START, "search_hotels")

# Conditional Edges from search_hotels
builder.add_conditional_edges(
    "search_hotels",
    router,
    {
        "search_hotels": "search_hotels",
        "fallback_hotel_search": "fallback_hotel_search",
        "format_results": "format_results"
    }
)

builder.add_edge("fallback_hotel_search", "format_results")
builder.add_edge("format_results", END)

graph = builder.compile()

if __name__ == "__main__":
    print("==================================================")
    print("  EXERCISE 7: Failure, Retry Loop & Fallback")
    print("==================================================")
    
    initial_state = {
        "city": "Chennai",
        "attempts": 0,
        "hotel_results": "",
        "status": "INIT"
    }
    
    # Execute graph
    final_output = graph.invoke(initial_state)
    
    print("\n==================================================")
    print("  FINAL GRAPH STATE OUTPUT")
    print("==================================================")
    print(f"  City: {final_output['city']}")
    print(f"  Total Attempts: {final_output['attempts']}")
    print(f"  Status: {final_output['status']}")
    print(f"  Results: {final_output['hotel_results']}")
    print("==================================================")
