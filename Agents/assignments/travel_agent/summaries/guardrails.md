# Agent Security & Guardrails

This document outlines the safety steps implemented in our tool execution layer to prevent arbitrary code execution, sanitize parameters, and handle faults gracefully.

---

## 🛑 The Danger of Arbitrary Code Execution

If an LLM is permitted to output raw Python code that is executed directly in the application hosting environment (e.g., via `eval()`, `exec()`, or spawning bash shells), it opens the system to critical security vulnerabilities:

* **Remote Code Execution (RCE)**: Attackers can exploit prompt injections (e.g., in reviews, profiles, or user inputs) to trick the model into executing system commands.
* **Privilege Abuse**: Code running in Python can import dangerous built-in packages like `os`, `sys`, `subprocess`, and `socket` to delete system files, read private `.env` keys, or access private local services.
* **Data Exfiltration**: Malicious code can use `urllib` or `requests` to post secret keys or database records to external command-and-control servers.
* **Denial of Service (DoS)**: Infinite loops, thread spawns, or heavy memory queries can exhaust system resources and crash the host machine.

---

## 🛡️ Secure Dispatch Architecture (Registry Pattern)

To eliminate code execution risks, we enforce a strict **Safe Tool Registry** contract:

```
[ User Input ]
      │
      ▼
[ LLM Agent ] (Decides to run tool)
      │
      ▼ (Outputs: Name + arguments JSON string)
[ Python Host Application ]
      │
      ├─► Step 1: Registry Verification (Is Name in whitelist?)
      │             ❌ No  ➡️ Reject with unknown tool error
      │             ✔ Yes ➡️ Proceed
      │
      ├─► Step 2: JSON Decoding & Validation
      │             ❌ Failure ➡️ Return JSON Syntax Error to LLM
      │             ✔ Success ➡️ Proceed
      │
      ├─► Step 3: Signature Type Check
      │             ❌ Mismatch ➡️ Return parameter type mismatch error
      │             ✔ Match ➡️ Proceed
      │
      ▼
[ Whitelisted Local Python Function ] (Executed within Try-Catch block)
      │
      ├─► Step 4: Exception Boundary Protection
      │             ❌ Exception ➡️ Catch exception and return details to LLM (Prevents crash)
      │             ✔ Success ➡️ Return structured output to LLM
```

---

## 📝 Four Steps of Safe Execution

Here are the concrete steps implemented inside our [`run_agent()`](file:///Users/dharshini/Desktop/AI/Agents/assignments/travel_agent/multi_tool.py#L273-L368) loop:

### 1. Registry Verification (Unknown Tool Check)
We maintain a hardcoded dictionary (`TOOL_REGISTRY`) of whitelisted function pointers:
```python
TOOL_REGISTRY = {
    "get_weather": get_weather,
    "search_places": search_places,
    "calculate_budget": calculate_budget
}
```
If the LLM generates a tool request that is not a key in this dictionary, the application rejects execution immediately and feeds back an error message to the model without invoking any code:
```python
if func_name not in TOOL_REGISTRY:
    result = {"error": f"Tool '{func_name}' is not recognized/registered."}
```

### 2. Argument Validation (Malformed JSON Check)
LLMs sometimes generate slightly invalid JSON. We wrap the parsing process in a `try-except` block to capture any JSON syntax failures cleanly:
```python
try:
    args = json.loads(args_str)
except json.JSONDecodeError as jde:
    result = {"error": f"Invalid JSON arguments: {jde}"}
```

### 3. Signature Type Check (Mismatch Protection)
To prevent runtime argument errors (such as passing a list instead of a string, or passing extra parameters that the Python function signature doesn't accept), the arguments are safely unpacked (`func(**args)`). We catch `TypeError` to catch any signature discrepancies:
```python
except TypeError as te:
    result = {"error": f"Argument signature mismatch: {te}. Check tool parameters."}
```

### 4. Exception Isolation (Runtime Fault Protection)
If the whitelisted Python function itself crashes during runtime (e.g. division by zero, database lookup timeout), we wrap the execution call in a broad `Exception` boundary. This prevents the entire travel agent CLI program from crashing, and instead translates the crash trace into an error payload sent back to the model:
```python
try:
    func = TOOL_REGISTRY[func_name]
    result = func(**args)
except Exception as e:
    result = {"error": f"Tool execution failed due to an internal error: {e}"}
```
