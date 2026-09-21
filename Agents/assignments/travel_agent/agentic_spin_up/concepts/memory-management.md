# MEMORY MANAGEMENT

## 1. Agent Memory Management

### A. LangGraph's MemorySaver (Conversational History)
- Stores the entire multi-turn conversation (System prompt, User messages, AI reasoning, Tool calls) in RAM.
- Managed by `SpinUp` keyed by `sessionId` (e.g., `place_agent-1`) so an agent can be messaged and resumed across multiple turns.
- Cleared when the session/application terminates.

```
User Message (request)
AI Message (tool call request)
Tool Message (tool response)
AI Message (final reply)
...
```
### B. Custom Record Storage
-  In-memory state tracking object created for deterministic processing, lifecycle tracking, and card-based UI assembly.

```typescript
record.status = "running";          // "running" | "done" | "needs_clarification" | "failed" | "stopped"
record.abort = controller;          // AbortController for cancelling active requests
record.error = null;                // Captured error message if execution fails
record.finishedAt = null;           // Timestamp when turn finishes
record.turns++;                     // Turn counter
record.tools = { ... };             // Dictionary mapping tool_name -> latest raw JSON result
record.reply = { ... };             // Latest parsed JSON response from the LLM
```

## Why maintain custom record storage
- Programmatic Control: Easily track status, cancel running agents (abort), handle timeouts, and manage error states without messing with LangGraph internals.
- Lossless Raw Tool Results: MCP tool results are intercepted live into record.tools. The downstream itinerary planner can directly access exact JSON data (flights, hotels, weather) to render cards and calculate budgets without searching or parsing the raw conversational LLM history.
- Context Window Protection: Generates lightweight summaries for the Main Agent rather than dumping massive raw tool data into the main prompt.