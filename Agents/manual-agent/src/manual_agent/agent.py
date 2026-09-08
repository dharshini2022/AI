import json

from .llm import call_llm
from .tools.registry import tools, tool_registry


def run_agent(user_input: str):

    messages = [
        {
            #system prompt
            "role": "system",
            "content": (
                "You are a calculator agent. "
                "Use the calculator tool for multiplication."
            )
        },
        #user message (Request)
        {
            "role": "user",
            "content": user_input
        }
        #assistant message (tool selection by LLM)
        #tool results (previous responses from tools) will be updated
        #assistant message (Final Response from LLM)
    ]

    while True:

        # send request to LLM (refer llm.py)
        assistant_message = call_llm(
            messages,
            tools
        )

        # Store LLM's response in conversation
        messages.append(
            assistant_message.model_dump()
        )

        # Does the LLM want to call a tool?
        if assistant_message.tool_calls:

            for tool_call in assistant_message.tool_calls:

                tool_name = tool_call.function.name

                #converts arguments from string to dictionary
                arguments = json.loads(
                    tool_call.function.arguments
                )

                # Find the actual Python function
                #tool_function acts like a pointer to the actual python function
                tool_function = tool_registry[tool_name]

                # Execute it
                # here we are unpacking the **arguments into the tool_function (arguments dict to exact value mapping)
                #here we invoke the function
                result = tool_function(**arguments)

                # appends result to history. It is sent to LLM on next while loop iteration
                messages.append(
                    {
                        "role": "tool",
                        "tool_call_id": tool_call.id,
                        "content": str(result)
                    }
                )

        else:
            # LLM has produced the final answer
            return assistant_message.content