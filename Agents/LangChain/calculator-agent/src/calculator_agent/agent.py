from langchain.agents import create_agent
from .llm import get_llm
from .tools.calculator import calculator

#LLM System prompt
SYSTEM_PROMPT = (
    "You are a calculator agent. "
    "Use the calculator tool for multiplication."
)


def run_agent(user_input: str) -> str:
    #initialises the LLM Http request. (doesn't initiates the LLM request yet)
    llm = get_llm()

    #list of tools to be used by the LLM
    tools = [calculator]

    # create_agent wires the LLM, tools, and system prompt into an autonomous loop
    agent = create_agent(
        llm,
        tools=tools,
        system_prompt=SYSTEM_PROMPT
    )

    #makes the LLM http request 
    result = agent.invoke({
        "messages": [("user", user_input)]
    })

    messages = result.get("messages")
    if messages:
        # The last message is the final response from the LLM
        return messages[-1].content
    return str(result)
