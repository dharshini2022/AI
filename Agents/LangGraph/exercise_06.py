# Exercise 6: Persistence, Checkpointing, and State Resumption
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver

# 1. Define State Schema
class State(TypedDict):
    request: str
    booking_details: str
    approved: bool
    status: str

# 2. Define Node Functions
def plan_booking(state: State):
    print("  [Node: plan_booking] Generating booking options...")
    return {
        "booking_details": "Luxury Resort in Chennai for ₹8,500/night",
        "status": "Waiting for User Approval"
    }

def book_hotel(state: State):
    print("  [Node: book_hotel] Finalizing booking...")
    if state.get("approved"):
        return {"status": "CONFIRMED: Luxury Resort in Chennai booked successfully!"}
    else:
        return {"status": "CANCELLED: Booking request was rejected."}

# 3. Graph Factory Function (Simulates Application Initialization)
def build_and_compile_graph(checkpointer):
    builder = StateGraph(State)
    
    builder.add_node("plan_booking", plan_booking)
    builder.add_node("book_hotel", book_hotel)
    
    builder.add_edge(START, "plan_booking")
    builder.add_edge("plan_booking", "book_hotel")
    builder.add_edge("book_hotel", END)
    
    # Pause execution before executing sensitive node 'book_hotel'
    return builder.compile(
        checkpointer=checkpointer,
        interrupt_before=["book_hotel"]
    )

if __name__ == "__main__":
    # Shared Checkpointer instance (acting as persistent storage across app sessions)
    checkpointer = MemorySaver()
    thread_id = "user_session_99"
    thread_config = {"configurable": {"thread_id": thread_id}}

    print("==================================================")
    print("  RUN 1: Initial Application Process")
    print("==================================================")
    
    # Initialize App Instance 1
    app_instance_1 = build_and_compile_graph(checkpointer)
    
    user_request = {
        "request": "Plan a trip and book a resort in Chennai.",
        "booking_details": "",
        "approved": False,
        "status": "Initiated"
    }
    
    print(f"\n1. Starting workflow for thread: '{thread_id}'")
    for event in app_instance_1.stream(user_request, thread_config):
        print("  Event output:", event)
    
    # Check current state after Run 1
    state_after_run1 = app_instance_1.get_state(thread_config)
    print(f"\nGraph paused at node(s): {state_after_run1.next}")
    print(f"Current State Details: {state_after_run1.values}")
    
    print("\n==================================================")
    print("  SIMULATING APPLICATION RESTART & PROCESS SHUTDOWN")
    print("==================================================")
    # Destroy reference to app_instance_1 to prove state persistence
    del app_instance_1
    print("App Instance 1 destroyed. Simulated new server instance startup...")
    
    # Initialize App Instance 2 (New object, loading checkpointer state)
    app_instance_2 = build_and_compile_graph(checkpointer)
    
    # Retrieve checkpointed state in new application instance
    restored_snapshot = app_instance_2.get_state(thread_config)
    print(f"\n2. Restored snapshot for thread '{thread_id}':")
    print(f"   - Next Node to Run: {restored_snapshot.next}")
    print(f"   - Pending Booking Details: {restored_snapshot.values.get('booking_details')}")
    print(f"   - Current Status: {restored_snapshot.values.get('status')}")
    
    print("\n==================================================")
    print("  RESUMING EXECUTION AFTER RESTART")
    print("==================================================")
    
    # User provides human approval in the resumed session
    print("3. Human User approves the booking request.")
    app_instance_2.update_state(thread_config, {"approved": True})
    
    print("4. Resuming execution from checkpoint...")
    for event in app_instance_2.stream(None, thread_config):
        print("  Event output:", event)
        
    final_state = app_instance_2.get_state(thread_config)
    print(f"\n5. Final Graph Execution State:")
    print(f"   - Status: {final_state.values.get('status')}")
    print(f"   - Next Nodes: {final_state.next}")
    print("==================================================")
