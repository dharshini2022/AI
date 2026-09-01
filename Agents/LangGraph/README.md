# 🦜🕸️ LangGraph Hands-on Learning Exercises (1 to 10)

This directory contains a complete step-by-step hands-on curriculum for mastering **LangGraph** from basic concepts to production-grade multi-agent architectures.

---

## 📌 Summary of Exercises

### 1️⃣ Exercise 01: Simple Sequential Graph (`exercise_01.py`)
* **Goal:** Understand foundational LangGraph primitives: `StateGraph`, `State` schema (`TypedDict`), `START`, `END`, and linear node transitions (`add_edge`).
* **Workflow:** `START ➔ extract_topic ➔ generate_response ➔ END`

### 2️⃣ Exercise 02: Conditional Routing (`exercise_02.py`)
* **Goal:** Implement dynamic branching in execution paths based on state values using `add_conditional_edges`.
* **Workflow:** `START ➔ classify ➔ [Router] ➔ (technical_response | general_response) ➔ END`

### 3️⃣ Exercise 03: Agent Loop with Termination Safeguard (`exercise_03.py`)
* **Goal:** Create cyclic/iterative graph execution loops (research ➔ evaluate ➔ loop back) with safety bounds (`iterations >= 3`) to prevent infinite loops.
* **Workflow:** `START ➔ research ➔ evaluate ➔ [Router] ➔ (insufficient -> research | sufficient -> END)`

### 4️⃣ Exercise 04: Tool-Using Agent (`exercise_04.py`)
* **Goal:** Build an agentic decision node that conditionally decides whether to invoke deterministic external tools (e.g. weather tool) or respond directly.
* **Workflow:** `START ➔ agent_decide ➔ [Router] ➔ (use_tool ➔ run_tool_node ➔ agent_respond_node | no_tool) ➔ END`

### 5️⃣ Exercise 05: Human-in-the-Loop (HITL) & Interrupts (`exercise_05.py`)
* **Goal:** Pause graph execution before sensitive actions using `interrupt_before`, inspect state snapshots via `get_state()`, update state (`update_state()`), and resume via `.stream(None, config)`.
* **Workflow:** `START ➔ plan_booking ➔ [WAIT: Human Approval] ➔ book_hotel ➔ END`

### 6️⃣ Exercise 06: State Persistence & App Resumption (`exercise_06.py`)
* **Goal:** Preserve session state across application shutdowns/restarts using Checkpointers (`MemorySaver`) and session `thread_id`s.
* **Workflow:** `Run 1 (Pause) ➔ Simulate Process Shutdown ➔ New App Instance ➔ Restore State ➔ Resume Execution`

### 7️⃣ Exercise 07: Failure Handling, Retries & Fallbacks (`exercise_07.py`)
* **Goal:** Implement resilient error recovery with state-driven retry counters (`attempts < 3`) and fallback routing when maximum retries are exhausted.
* **Workflow:** `START ➔ search_hotels (FAIL) ➔ Retry (up to 3x) ➔ [Router] ➔ fallback_hotel_search ➔ END`

### 8️⃣ Exercise 08: Supervisor Multi-Agent System (`exercise_08.py`)
* **Goal:** Build a multi-agent orchestrator (`Supervisor`) that dynamically evaluates state and dispatches sub-tasks to specialized worker agents (`Research`, `Weather`, `Budget`) before calling `Planner`.
* **Workflow:** `Supervisor ⇄ (Research | Weather | Budget Agents) ➔ Supervisor ➔ Planner Agent ➔ END`

### 9️⃣ Exercise 09: Subgraph Modularity & Hierarchy (`exercise_09.py`)
* **Goal:** Enforce clean architecture by building an internal iterative `Research Subgraph` and nesting it as a single node within a parent graph.
* **Workflow:** `Main Graph ➔ Research Subgraph (Search ⇄ Evaluate Loop) ➔ Weather ➔ Budget ➔ Planner ➔ END`

### 🔟 Exercise 10: Final Project — Production Trip Planner (`exercise_10.py`)
* **Goal:** Combine agentic decision-making, deterministic rule validation (budget checking), and automated replanning loops into a production-quality architecture.
* **Workflow:** `Intake ➔ Supervisor ➔ Workers ➔ Planning Agent ➔ Validation Node ➔ (Approved -> END | Over Budget -> Replanning Node -> Planning)`

---

## 🏃 How to Run Exercises

Execute any script using python:

```bash
python exercise_01.py
python exercise_02.py
python exercise_03.py
python exercise_04.py
python exercise_05.py
python exercise_06.py
python exercise_07.py
python exercise_08.py
python exercise_09.py
python exercise_10.py
```
