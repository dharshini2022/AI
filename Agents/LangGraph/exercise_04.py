# Tool Using Agent
from typing import TypedDict, Optional
from langgraph.graph import StateGraph, START, END

# 1. Define State
class State(TypedDict):
    user_input: str
    tool_needed: bool
    city: Optional[str]
    tool_result: Optional[dict]
    response: str

# 2. Deterministic Weather Tool
def get_weather(city: str):
    return {
        "city": city,
        "temperature": 28,
        "condition": "Rainy"
    }

# 3. Agent Decision Node (Agentic Choice)
def agent_decide(state: State):
    input_text = state["user_input"].lower()
    
    if "weather" in input_text:
        # Detect city (defaulting to Chennai if mentioned)
        city = "Chennai" if "chennai" in input_text else "Unknown"
        return {
            "tool_needed": True,
            "city": city
        }
    else:
        # Direct answer without tool call
        return {
            "tool_needed": False,
            "response": "Why don't scientists trust atoms? Because they make up everything!"
        }

# 4. Tool Execution Node
def run_tool_node(state: State):
    city = state.get("city", "Chennai")
    result = get_weather(city)
    return {"tool_result": result}

# 5. Agent Response Node (Formulates final answer from tool output)
def agent_respond_node(state: State):
    tool_res = state.get("tool_result")
    if tool_res:
        formatted_response = f"The weather in {tool_res['city']} is currently {tool_res['condition']} with a temperature of {tool_res['temperature']}°C."
    else:
        formatted_response = state.get("response", "No response generated.")
    return {"response": formatted_response}

# 6. Routing Function for Conditional Edge
def route_tool(state: State):
    if state.get("tool_needed"):
        return "use_tool"
    return "no_tool"

# 7. Build Graph
builder = StateGraph(State)

builder.add_node("agent_decide", agent_decide)
builder.add_node("run_tool_node", run_tool_node)
builder.add_node("agent_respond_node", agent_respond_node)

builder.add_edge(START, "agent_decide")

# Conditional routing based on tool_needed decision
builder.add_conditional_edges(
    "agent_decide",
    route_tool,
    {
        "use_tool": "run_tool_node",
        "no_tool": END
    }
)

builder.add_edge("run_tool_node", "agent_respond_node")
builder.add_edge("agent_respond_node", END)

graph = builder.compile()

# 8. Test Executions
if __name__ == "__main__":
    print("=== Test 1: Weather Prompt ===")
    prompt_1 = {"user_input": "What is the weather in Chennai?", "tool_needed": False, "city": None, "tool_result": None, "response": ""}
    res1 = graph.invoke(prompt_1)
    print(f"User: {prompt_1['user_input']}")
    print(f"Tool Triggered: {res1['tool_needed']}")
    print(f"Agent Response: {res1['response']}\n")

    print("=== Test 2: Joke Prompt ===")
    prompt_2 = {"user_input": "Tell me a joke.", "tool_needed": False, "city": None, "tool_result": None, "response": ""}
    res2 = graph.invoke(prompt_2)
    print(f"User: {prompt_2['user_input']}")
    print(f"Tool Triggered: {res2['tool_needed']}")
    print(f"Agent Response: {res2['response']}")