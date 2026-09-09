# Calculator agent created using LangChain

### Tool Descriptioj
- @tool annotator used for tools.
- tool schema replaces by one line description in the python function itself.
- tool registry is replaced by an array
- LLM can view the tool description only not the actual function implementation

### Agent Creation
- agent created using langchain's create_agent by passing llm, tools and prompt
- the agent automatically handles tool selection, adding messages to history, and returning final answer
- no while loop is required
- create_agent function returns an object which has invoke() method to make LLM call
- invoke() method returns the final answer in messages attribute.

### Workflow
1. main.py  -> gets user input and calls run_agent
2. agent.py -> get_llm() to get the llm spec from llm.py -> create_agent() -> invoke() -> returns result