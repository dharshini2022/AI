# LangGraph — Components and Core Concepts

## 1. What is LangGraph?

**LangGraph is a framework for building stateful, multi-step, and agentic applications as graphs.**

The core mental model is:

```text
             ┌──────────────┐
             │    STATE     │
             │ Shared data  │
             └──────┬───────┘
                    │
             ┌──────▼───────┐
             │    NODES     │
             │ Work/actions │
             └──────┬───────┘
                    │
             ┌──────▼───────┐
             │    EDGES      │
             │ Control flow  │
             └───────────────┘
```

In simple terms:

- **State** = what the application knows
- **Node** = something the application does
- **Edge** = what happens next

LangGraph is especially useful when an application needs branching, loops, persistence, human approval, or coordination between multiple agents.

---

# 2. Why LangGraph?

A simple workflow can be written as normal Python:

```python
destination = search_destination(user_input)
weather = get_weather(destination)
restaurants = search_restaurants(destination)
itinerary = create_itinerary(destination, weather, restaurants)
```

This is mostly a fixed sequence:

```text
User
  ↓
Search
  ↓
Weather
  ↓
Restaurants
  ↓
Itinerary
```

But an agentic application may need to decide dynamically:

```text
                    ┌── Weather ───────┐
                    │                  │
User → Supervisor ──┼── Research ──────┤
                    │                  │
                    └── Budget ────────┘
                              ↓
                           Planner
```

The system may also need to loop:

```text
Research
   ↓
Evaluate
   ↓
Enough information?
   │
   ├── No ──→ Research again
   │
   └── Yes
          ↓
         END
```

LangGraph gives you a structured way to represent and execute these patterns.

---

# 3. The Core Components

The most important components to learn first are:

```text
State
  │
  ├── Nodes
  │     │
  │     └── perform work
  │
  └── Edges
        │
        ├── normal edge
        └── conditional edge

Additional capabilities:

- Loops
- Persistence / checkpointing
- Interrupts / human-in-the-loop
- Subgraphs
- Streaming
- Runtime/context
```

---

# 4. State

## What is State?

**State is the shared data that flows through the graph.**

For example, a trip planner could have:

```python
from typing import TypedDict

class State(TypedDict):
    user_request: str
    destination: str
    weather: str
    restaurants: list
    itinerary: str
```

Initially:

```text
user_request = "Plan a trip to Tokyo"
destination = ""
weather = ""
restaurants = []
itinerary = ""
```

After research:

```text
user_request = "Plan a trip to Tokyo"
destination = "Tokyo"
weather = ""
restaurants = [...]
itinerary = ""
```

After weather lookup:

```text
user_request = "Plan a trip to Tokyo"
destination = "Tokyo"
weather = "Rainy"
restaurants = [...]
itinerary = ""
```

The state therefore acts as the **shared working memory for graph execution**.

---

# 5. Nodes

## What is a Node?

A **node is a function that performs a unit of work**.

Example:

```python
def research_node(state: State):
    destination = search_destination(
        state["user_request"]
    )

    return {
        "destination": destination
    }
```

Another node:

```python
def weather_node(state: State):
    weather = get_weather(
        state["destination"]
    )

    return {
        "weather": weather
    }
```

The node reads from state and returns updates to state.

Visual model:

```text
             STATE
               │
               ▼
       ┌────────────────┐
       │ research_node  │
       └───────┬────────┘
               │
          state update
               │
               ▼
             STATE
```

## Important

A node does **not** have to be an LLM.

It can contain:

- Python logic
- LLM calls
- Agent execution
- Tool calls
- Database operations
- API calls
- Validation
- Calculations

For example:

```text
Node
 ├── LLM call
 ├── API call
 ├── Python calculation
 ├── Database query
 └── Agent
```

---

# 6. Edges

## What is an Edge?

An **edge determines the next step in the graph**.

Example:

```text
Research
   ↓
Weather
   ↓
Planning
```

Conceptually:

```python
builder.add_edge("research", "weather")
builder.add_edge("weather", "planning")
```

This creates:

```text
research → weather → planning
```

---

# 7. START and END

LangGraph graphs have explicit entry and exit points.

```text
START
  ↓
Research
  ↓
Weather
  ↓
Planning
  ↓
END
```

Conceptually:

```python
builder.add_edge(START, "research")
builder.add_edge("planning", END)
```

Think of:

- `START` = graph execution begins here
- `END` = graph execution finishes here

---

# 8. Building a Basic Graph

A minimal graph looks like this:

```python
from typing import TypedDict
from langgraph.graph import StateGraph, START, END


class State(TypedDict):
    message: str


def node_a(state: State):
    return {
        "message": state["message"] + " → A"
    }


def node_b(state: State):
    return {
        "message": state["message"] + " → B"
    }


builder = StateGraph(State)

builder.add_node("a", node_a)
builder.add_node("b", node_b)

builder.add_edge(START, "a")
builder.add_edge("a", "b")
builder.add_edge("b", END)

graph = builder.compile()
```

Graph:

```text
START
  ↓
  A
  ↓
  B
  ↓
 END
```

Run it:

```python
result = graph.invoke({
    "message": "Start"
})

print(result)
```

The important lifecycle is:

```text
Define State
     ↓
Create Graph
     ↓
Add Nodes
     ↓
Add Edges
     ↓
Compile
     ↓
Invoke
```

---

# 9. Conditional Edges

A normal edge always follows the same path:

```text
A → B
```

A **conditional edge chooses the next node based on state**.

Example:

```text
             ┌── Technical Response
             │
Classifier ──┤
             │
             └── General Response
```

Suppose the state contains:

```python
class State(TypedDict):
    user_input: str
    category: str
```

A routing function might be:

```python
def route(state: State):
    return state["category"]
```

Conceptually:

```python
builder.add_conditional_edges(
    "classifier",
    route
)
```

Graph:

```text
                 ┌── technical ──→ Technical
                 │
START → Classifier
                 │
                 └── general ────→ General
```

Conditional edges are one of the mechanisms that make LangGraph useful for dynamic workflows.

---

# 10. Deterministic vs Agentic Routing

This distinction is important.

## Deterministic routing

```python
def route(state):
    if state["weather"] == "rain":
        return "indoor"

    return "outdoor"
```

The application determines the path using explicit logic.

```text
State
  ↓
Python condition
  ↓
Next node
```

## LLM-based routing

The LLM can determine what should happen next.

```text
State
  ↓
LLM
  ↓
"I need weather information"
  ↓
Weather node
```

This is more agentic.

### Key distinction

```text
Decision to use a tool
        ↓
      Agentic

Execution of the tool
        ↓
   Usually deterministic
```

For example:

```text
Agent
  │
  │ "I need weather"
  ▼
get_weather()
  │
  │ API request
  ▼
Weather data
```

The agent decides **whether/when** to use the capability.

The tool implementation should normally perform its defined operation deterministically.

---

# 11. Loops

LangGraph can represent cycles.

Example:

```text
        ┌──────────────────┐
        │                  │
        ▼                  │
Research → Evaluate ───────┘
              │
              │ Enough?
              ▼
             END
```

More explicitly:

```text
Research
   ↓
Evaluate
   ↓
Enough information?
   │
   ├── No ──→ Research
   │
   └── Yes ──→ END
```

This pattern is common in agentic applications.

For example:

1. Search for information.
2. Evaluate the results.
3. Decide whether enough information exists.
4. If not, search again.
5. Otherwise, finish.

## Production consideration

A loop should have a termination strategy.

For example:

```python
class State(TypedDict):
    research: str
    iterations: int
```

Possible termination rule:

```text
iterations >= 3
        ↓
       END
```

Never rely solely on an LLM to terminate an important loop.

---

# 12. Tools inside LangGraph

Tools can be called from nodes or agents.

Example:

```python
def get_weather(city: str):
    return {
        "city": city,
        "temperature": 28,
        "condition": "Rainy"
    }
```

A tool-using agent can follow:

```text
User
 ↓
Agent
 ↓
Need weather?
 ├── No → Answer
 │
 └── Yes
       ↓
   Weather Tool
       ↓
      Agent
       ↓
     Answer
```

This illustrates the **agent loop**:

```text
Reason
  ↓
Act
  ↓
Observe
  ↓
Reason
  ↓
Act / Finish
```

LangGraph can be used to explicitly model this cycle.

---

# 13. Agent vs Workflow vs LangGraph

These concepts should not be confused.

## Workflow

The developer specifies the path.

```text
A → B → C → D
```

The application follows a predefined process.

## Agent

The LLM can decide what action/tool to take.

```text
             ┌→ Tool A
LLM decides ─┼→ Tool B
             └→ Tool C
```

## LangGraph

LangGraph provides the graph-based execution model in which workflows, agents, or combinations of both can be implemented.

```text
LangGraph
    │
    ├── deterministic workflow
    │
    ├── single agent
    │
    ├── agent + tools
    │
    └── multi-agent system
```

Therefore:

> LangGraph itself does not automatically make an application agentic.

It provides the orchestration and state-management primitives needed to build these systems.

---

# 14. Multi-Agent Systems

LangGraph is useful for coordinating multiple specialized agents.

Example:

```text
                         Supervisor
                       /     |      \
                      /      |       \
                     ▼       ▼        ▼
                Research  Weather   Budget
                   Agent    Agent     Agent
                     \       |        /
                      \      |       /
                       ▼     ▼      ▼
                         Supervisor
                             │
                             ▼
                          Planner
```

Each agent has a focused responsibility.

For a trip planner:

```text
Research Agent
 ├── Search places
 ├── Search restaurants
 └── Search accommodation

Weather Agent
 └── Get weather

Budget Agent
 └── Calculate/validate cost

Planning Agent
 └── Create itinerary
```

The supervisor coordinates them.

---

# 15. State in a Multi-Agent System

A shared state might look like:

```python
class State(TypedDict):
    user_request: str
    research: str
    weather: str
    budget: str
    itinerary: str
```

Execution:

```text
Initial State
     │
     ▼
Research Agent
     │
     ├── research updated
     ▼
Supervisor
     │
     ▼
Weather Agent
     │
     ├── weather updated
     ▼
Supervisor
     │
     ▼
Budget Agent
     │
     ├── budget updated
     ▼
Planner
     │
     └── itinerary updated
```

The state provides the shared context required for coordination.

---

# 16. Subgraphs

A graph can contain another graph.

This is useful for modularity.

For example:

```text
Main Graph
│
├── Intake
│
├── Research Subgraph
│     │
│     ├── Search
│     ├── Evaluate
│     ├── Refine
│     └── END
│
├── Weather
│
└── Planning
```

Instead of putting every research step into the main graph, encapsulate the research process.

This gives you:

```text
Main Graph
    ↓
Research Subgraph
    ↓
Main Graph
```

Subgraphs are especially useful as applications become larger.

---

# 17. Persistence and Checkpointing

Long-running agent applications often need to preserve execution state.

Conceptually:

```text
Agent
  ↓
Research
  ↓
Checkpoint
  ↓
WAIT / FAILURE
  ↓
Resume
  ↓
Continue
```

Persistence is useful for:

- Long-running workflows
- Human approval
- Failure recovery
- Stateful conversations
- Resume after interruption
- Debugging

The exact persistence APIs can vary by LangGraph version, so check the current LangGraph documentation when implementing production code.

The architectural idea is:

```text
Graph execution
      ↓
Saved state/checkpoint
      ↓
Resume later
```

---

# 18. Human-in-the-Loop

Some actions should require human approval.

Example:

```text
Agent
  ↓
Generate booking action
  ↓
WAIT FOR HUMAN
  ↓
User approves
  ↓
Execute booking
```

A more complete flow:

```text
User
 ↓
Agent
 ↓
Find hotel
 ↓
Generate booking request
 ↓
──────────────
Human approval
──────────────
 ↓
Booking tool
 ↓
Confirmation
```

This is valuable when an agent can:

- Spend money
- Delete data
- Send messages
- Make bookings
- Modify production systems
- Perform irreversible operations

---

# 19. Error Handling

Production graphs must handle failure.

Example:

```text
Agent
 ↓
Search API
 ↓
FAIL
 ↓
Retry
 ↓
Success
```

Or:

```text
Search API
    ↓
  Failure
    │
    ├── Retry 1
    ├── Retry 2
    └── Retry 3
           ↓
        Fallback
```

Useful concepts include:

```text
Retry
Timeout
Fallback
Maximum attempts
Error state
Graceful termination
```

A robust graph should answer:

> What happens if this node fails?

---

# 20. Validation Nodes

Not every decision should be delegated to an LLM.

For example, budget validation should usually be deterministic.

```text
Planning Agent
      ↓
Candidate itinerary
      ↓
Budget Validator
      ↓
Within budget?
    /       \
  Yes        No
   ↓          ↓
 END       Replanning
```

Example:

```python
def validate_budget(state):
    if state["estimated_cost"] <= state["budget"]:
        return {"valid": True}

    return {"valid": False}
```

This is an example of combining:

```text
LLM reasoning
+
Deterministic constraints
```

That combination is often more reliable than asking an LLM to perform everything.

---

# 21. A Production-Style Trip Planner

A more realistic architecture could look like:

```text
                         User
                           │
                           ▼
                     Intake Node
                           │
                           ▼
                       Supervisor
                    /      |       \
                   /       |        \
                  ▼        ▼         ▼
             Research   Weather    Budget
               Agent      Agent     Agent
                  │         │         │
                  └─────────┼─────────┘
                            ▼
                        Supervisor
                            │
                            ▼
                      Planning Agent
                            │
                            ▼
                     Validation Node
                            │
                    ┌───────┴───────┐
                    │               │
                  Valid           Invalid
                    │               │
                    ▼               ▼
                   END          Replanning
                                    │
                                    └──────→ Planning
```

Notice the architectural split:

```text
Agentic
────────
Supervisor
Research decisions
Planning decisions
Tool selection

Deterministic
─────────────
Budget calculation
Budget validation
Distance calculation
Schema validation
Hard constraints
API/tool implementation
```

This hybrid approach is generally preferable to making every component an LLM-driven agent.

---

# 22. Graph Construction Lifecycle

A useful way to remember LangGraph is:

```text
1. Define State
       ↓
2. Define Nodes
       ↓
3. Define Edges
       ↓
4. Define Conditional Routing
       ↓
5. Compile Graph
       ↓
6. Invoke / Stream
       ↓
7. Observe / Debug
```

Conceptually:

```python
class State(TypedDict):
    ...


def node_a(state):
    ...


def node_b(state):
    ...


builder = StateGraph(State)

builder.add_node("a", node_a)
builder.add_node("b", node_b)

builder.add_edge(START, "a")
builder.add_edge("a", "b")
builder.add_edge("b", END)

graph = builder.compile()

result = graph.invoke(initial_state)
```

---

# 23. Important LangGraph Concepts to Learn

For practical/industry readiness, learn these in this order:

```text
Level 1 — Fundamentals
───────────────────────
State
Nodes
Edges
START / END
compile()
invoke()


Level 2 — Control Flow
──────────────────────
Conditional edges
Loops
Routing
Termination


Level 3 — Agentic Systems
─────────────────────────
LLM nodes
Tool calling
Agent loops
Dynamic routing


Level 4 — Production
────────────────────
Persistence
Checkpointing
Interrupts
Human-in-the-loop
Retries
Error handling
Validation


Level 5 — Architecture
──────────────────────
Subgraphs
Multi-agent systems
Supervisor patterns
State design
Modularity
Observability
```

---

# 24. The Most Important Mental Model

When looking at any LangGraph application, ask four questions:

### 1. What is the State?

```text
What information does the system need to remember?
```

### 2. What are the Nodes?

```text
What individual pieces of work happen?
```

### 3. What are the Edges?

```text
How does execution move between pieces of work?
```

### 4. Where are the decisions?

```text
Which transitions are deterministic?
Which transitions depend on an LLM/agent?
```

Example:

```text
                 STATE
                   │
                   ▼
                Research
                   │
                   ▼
                Evaluate
                   │
              ┌────┴────┐
              │         │
           Enough?      │
           /     \      │
         Yes      No    │
          │        │    │
          ▼        └────┘
         END
```

If you can explain this diagram, you understand the core of LangGraph.

---

# 25. LangGraph vs LangChain vs LangSmith

These tools solve different problems.

```text
┌──────────────────────────────────────────────┐
│                   AI APP                    │
│                                              │
│  LangChain                                   │
│  └── Models, tools, agents, integrations     │
│                                              │
│  LangGraph                                   │
│  └── Stateful graph orchestration            │
│      loops, routing, persistence, HITL        │
│                                              │
│  LangSmith                                   │
│  └── Tracing, evaluation, testing,           │
│      debugging, observability                │
└──────────────────────────────────────────────┘
```

A simplified mental model:

> **LangChain → building blocks and agent abstractions**

> **LangGraph → orchestration and stateful execution**

> **LangSmith → testing, evaluation, tracing, and observability**

They can be used together.

---

# 26. Recommended Hands-On Progression

Don't learn LangGraph only by reading API documentation.

Build these progressively:

```text
Exercise 1
──────────
Sequential graph

START → A → B → END


Exercise 2
──────────
Conditional routing

        ┌→ A
START → Router
        └→ B


Exercise 3
──────────
Agent loop

Research → Evaluate
    ↑         │
    └── No ───┘


Exercise 4
──────────
Tool-using agent

Agent → Tool → Agent → END


Exercise 5
──────────
Human approval

Agent → WAIT → Human → Action


Exercise 6
──────────
Persistence

Graph → Checkpoint → Resume


Exercise 7
──────────
Failure handling

Node → Retry → Retry → Fallback


Exercise 8
──────────
Multi-agent supervisor

              Supervisor
             /    |    \
            A     B     C
             \    |    /
              Supervisor


Exercise 9
──────────
Subgraphs

Main Graph
    ↓
Subgraph
    ↓
Main Graph


Exercise 10
───────────
Production-style Trip Planner
```

---

# 27. Final Summary

The simplest definition is:

> **LangGraph is a graph-based framework for building stateful workflows and agentic applications.**

The core components are:

```text
State
  ↓
Stores information

Nodes
  ↓
Perform work

Edges
  ↓
Control execution

Conditional Edges
  ↓
Choose paths

Loops
  ↓
Repeat work until a condition is met

Persistence
  ↓
Save/resume state

Interrupts
  ↓
Pause for human input

Subgraphs
  ↓
Create modular graph components

Multi-agent graphs
  ↓
Coordinate specialized agents
```

The key architectural principle is:

```text
        Agentic where reasoning is useful
                       +
        Deterministic where correctness matters
                       =
              Robust AI application
```

For an industry-oriented implementation, focus less on memorizing LangGraph APIs and more on being able to design **state, control flow, termination, failure handling, and agent/deterministic boundaries** correctly.
