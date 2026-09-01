#Conditional Routing
from typing import TypedDict
# pyrefly: ignore [missing-import]
from langgraph.graph import StateGraph, START, END

class State(TypedDict):
    user_input: str
    category: str
    response: str

def classify(state: State):
    if "kubernetes" in state["user_input"].lower():
        return {"category": "technical"}

    return {"category": "general"}

def technical_response(state: State):
    return {
        "response": "This is a technical question."
    }


def general_response(state: State):
    return {
        "response": "This is a general question."
    }

def route(state: State):
    return state["category"]

builder = StateGraph(State)

builder.add_node("classify", classify)
builder.add_node("technical_response", technical_response)
builder.add_node("general_response", general_response)

builder.add_edge(START, "classify")
builder.add_conditional_edges(
    "classify",
    #wrt result of route, the corresponding function gets triggered
    route,
    {
        "technical": "technical_response",
        "general": "general_response"
    }
)
builder.add_edge("technical_response", END)
builder.add_edge("general_response", END)

graph = builder.compile()

result = graph.invoke({
    "user_input": "Explain Kubernetes",
    "topic": "",
    "response": ""
})

print(result)