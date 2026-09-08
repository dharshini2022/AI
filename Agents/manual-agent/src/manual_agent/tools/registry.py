"""A Registry to show set of available tools to LLM"""
# pyrefly: ignore [missing-import]
from .calculator import calculator


tools = [
    {
        "type": "function",
        "function": {
            "name": "calculator",
            "description": "Multiply two numbers together.",
            "parameters": {
                "type": "object",
                "properties": {
                    "a": {
                        "type": "number",
                        "description": "First number"
                    },
                    "b": {
                        "type": "number",
                        "description": "Second number"
                    }
                },
                "required": ["a", "b"]
            }
        }
    }
]


tool_registry = {
    #string key (tool name) : python function (tool) value
    "calculator": calculator
}