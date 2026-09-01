# Exercise 4: Human-in-the-Loop with Interrupts and State Preservation
from typing import TypedDict
from langgraph.graph import StateGraph, START, END
from langgraph.checkpoint.memory import MemorySaver

class State(TypedDict):
    request: str
    booking_details: str
    approved: bool
    status: str

def plan_booking(state: State):
    return {
        "booking_details": "Hotel X in Chennai for ₹5,000",
        "status": "Waiting for Approval"
    }

def book_hotel(state: State):
    if state.get("approved"):
        return {"status": "Confirmed: Hotel X in Chennai booked for ₹5,000!"}
    else:
        return {"status": "Cancelled: Booking was not approved."}

# Build graph
builder = StateGraph(State)

builder.add_node("plan_booking", plan_booking)
builder.add_node("book_hotel", book_hotel)

builder.add_edge(START, "plan_booking")
builder.add_edge("plan_booking", "book_hotel")
builder.add_edge("book_hotel", END)

# Checkpointer required for preserving graph state across interrupts
memory = MemorySaver()

# Interrupt execution BEFORE running the sensitive 'book_hotel' node
graph = builder.compile(
    checkpointer=memory,
    #the graph pauses before the execution of book_hotel, takes a snapshot and adds it to the checkpointer
    interrupt_before=["book_hotel"]
)

if __name__ == "__main__":
    thread_config = {"configurable": {"thread_id": "booking_thread_1"}}
    
    # 1. Initial User Request
    print("=== Step 1: User Request ===")
    user_input = {
        "request": "Book a hotel in Chennai.",
        "booking_details": "",
        "approved": False,
        "status": ""
    }
    
    # Run graph until it pauses at interrupt_before
    print("Agent is processing...")
    for event in graph.stream(user_input, thread_config):
        print("  Event:", event)

    # 2. Inspect Paused State
    state_snapshot = graph.get_state(thread_config)
    print("\n=== Step 2: Human-in-the-Loop Interrupt ===")
    print(f"Proposed Booking: {state_snapshot.values.get('booking_details')}")
    print(f"Pending Node: {state_snapshot.next}")

    # 3. Human Approval (State Update)
    print("\n=== Step 3: Human Input ===")
    print("User Action: Approve booking")
    # Update the graph state at the checkpointer thread
    graph.update_state(thread_config, {"approved": True})

    # 4. Resume Graph Execution by passing None as input with thread_config
    print("\n=== Step 4: Resume Graph Execution ===")
    for event in graph.stream(None, thread_config):
        print("  Event:", event)

    # 5. Final Result
    final_snapshot = graph.get_state(thread_config)
    print("\n=== Final State ===")
    print(f"Final Status: {final_snapshot.values.get('status')}")
