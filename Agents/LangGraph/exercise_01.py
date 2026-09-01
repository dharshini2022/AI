#Simple Sequential Graph
from typing import TypedDict
# pyrefly: ignore [missing-import]
from langgraph.graph import StateGraph, START, END

#State => shared context/data
class State(TypedDict):
    user_input: str
    topic: str
    response: str

# Node => Work
def extract_topic(state: State):
    return {
        "topic": state["user_input"]
    }

def generate_response(state: State):
    return {
        "response": f"You asked about: {state['topic']}"
    }

builder = StateGraph(State)

builder.add_node("extract_topic", extract_topic)
builder.add_node("generate_response", generate_response)

# Edge => Flow (What to do next)
builder.add_edge(START, "extract_topic")
builder.add_edge("extract_topic", "generate_response")
builder.add_edge("generate_response", END)

#adds everything to the graph
graph = builder.compile()

#executes the fraph
result = graph.invoke({
    "user_input": "Explain LangGraph",
    "topic": "",
    "response": ""
})

print(result)