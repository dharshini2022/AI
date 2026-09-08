# This is a single - tool calculator agent
## Tool Design & Registration

* **Python Functions as Tools**: Tools are standard Python functions (e.g., `calculator(a, b)`).
* **Tool Schema (`tools`)**:
  * A JSON schema describing each tool's name, description, and required arguments.
  * **Schema is the only part shared with the LLM**, allowing the model to know *what* tools are available and *how* to call them.
* **Tool Registry (`tool_registry`)**:
  * An internal Python dictionary that maps schema names to executable functions:
    * **Key**: The tool name string specified in the schema (e.g., `"calculator"`).
    * **Value**: The reference to the actual Python function (e.g., `calculator`).
  * **Private to the agent runtime**: The LLM never sees or accesses `tool_registry` or the underlying code.

---
## WorkFlow
1. main.py
   └─► Accepts user input, calls run_agent(user_input)

2. agent.py (run_agent)
   └─► Builds messages list [system_prompt, user_prompt]
   └─► Enters while True loop
   └─► Invokes call_llm(messages, tools)

3. llm.py (call_llm)
   └─► Sends prompt + tool schemas to Groq LLM

4. LLM Response
   └─► Model decides to call a tool (returns assistant_message with tool_calls)

5. agent.py (Tool Execution)
   └─► Parses arguments (json.loads)
   └─► Looks up function in tool_registry[tool_name]
   └─► Executes function: tool_function(**arguments)
   └─► Appends result {"role": "tool", "content": ...} to messages

6. while True Loop (Next Turn)
   └─► call_llm(messages, tools) sends the updated history to the LLM
   └─► LLM synthesizes the result and returns the final answer (tool_calls is None)

7. Return & Output
   └─► agent.py returns assistant_message.content
   └─► main.py prints the final answer to the user



