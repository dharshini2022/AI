# LangChain and How It Works

## 1. What Is LangChain?

**LangChain is a framework for building applications that use large language models (LLMs).**

An LLM by itself mainly performs:

```text
Input
  ↓
LLM
  ↓
Output
```

A real application usually needs more:

- Prompt management
- Model interaction
- Structured output
- External data
- Retrieval
- Tools
- Memory/state
- Multi-step workflows
- Agent orchestration

LangChain provides abstractions and components that help developers connect these pieces.

A useful mental model is:

```text
                    APPLICATION
                         |
                         v
                    LANGCHAIN
                         |
       +-----------------+-----------------+
       |                 |                 |
       v                 v                 v
     Models           Prompts           Tools
       |                 |                 |
       v                 v                 v
    OpenAI/           Templates        APIs / DBs
    Anthropic/          etc.             etc.
    Gemini
                         |
                         v
                    Retrieval
                         |
                         v
                  Vector Databases
```

LangChain is **not an LLM**.

It is an application framework/orchestration layer around LLMs.

---

# 2. Why Do We Need LangChain?

Suppose you directly integrate with an LLM provider.

Your application may contain provider-specific code:

```text
Application
    |
    +--> OpenAI API
    |
    +--> Anthropic API
    |
    +--> Gemini API
```

If every provider has different APIs, request formats, response formats, and capabilities, the application can become tightly coupled to individual providers.

LangChain provides abstractions that allow application code to work with models through a more consistent interface.

Conceptually:

```text
Application
     |
     v
LangChain model abstraction
     |
  +--+---------+---------+
  v            v         v
OpenAI      Anthropic  Gemini
```

The exact APIs and supported integrations change over time, so current LangChain documentation should be used for implementation details.

---

# 3. The Main Components

The most useful LangChain concepts are:

```text
LangChain
   |
   +-- Models
   |
   +-- Prompts
   |
   +-- Structured Output
   |
   +-- Tools
   |
   +-- Retrieval
   |
   +-- Agents
   |
   +-- Memory / State
   |
   +-- Chains / Runnables
```

These components can be combined to create different application architectures.

---

# 4. Models

LangChain provides abstractions for interacting with chat models and other model types.

Conceptually:

```text
Application
     |
     v
Model Interface
     |
     +--------+---------+
     v        v         v
   GPT     Claude    Gemini
```

The application can invoke a model through the abstraction.

Conceptually:

```python
response = model.invoke("Explain Kubernetes")
```

The exact model initialization and package APIs depend on the current LangChain version and provider integration.

The important concept is:

> **LangChain abstracts model interaction; the actual inference is still performed by the underlying model provider.**

---

# 5. Prompt Templates

A prompt template is a reusable prompt structure.

Example:

```text
You are a travel assistant.

Destination: {destination}
Duration: {duration}
Budget: {budget}

Create a travel plan.
```

The application provides values:

```text
destination = Japan
duration = 7 days
budget = ₹100,000
```

The template becomes:

```text
You are a travel assistant.

Destination: Japan
Duration: 7 days
Budget: ₹100,000

Create a travel plan.
```

The flow is:

```text
Variables
   ↓
Prompt Template
   ↓
Final Prompt
   ↓
Chat Model
   ↓
Response
```

### Important

The prompt template does not automatically extract variables from arbitrary user messages.

For example:

```text
"I want to visit Japan for 7 days with ₹1 lakh."
```

must first be converted into structured values if the application expects:

```text
destination = Japan
duration = 7
budget = ₹100,000
```

That extraction can involve an LLM, structured output, or deterministic application logic.

---

# 6. System Prompts

An agent or model application can also have a system instruction.

Example:

```text
You are a travel planning assistant.

Rules:
1. Validate the destination.
2. Use the weather tool when current weather is required.
3. Do not invent unavailable information.
```

A system prompt primarily defines behavior and constraints.

A prompt template primarily provides reusable prompt structure and variables.

They can be used together.

```text
System Instructions
        +
Dynamic Prompt
        ↓
     Chat Model
        ↓
      Output
```

---

# 7. Structured Output

LLMs naturally produce unstructured text.

Applications often need structured data.

For example, instead of:

```text
Japan is a good destination. You could visit Tokyo...
```

the application might require:

```json
{
  "destination": "Japan",
  "duration_days": 7,
  "estimated_budget": 100000
}
```

Structured output allows application code to work with predictable fields.

Conceptually:

```text
User Request
     ↓
LLM
     ↓
Structured Output
     ↓
Application Logic
```

This is particularly useful when an LLM's output needs to be passed into another deterministic component.

---

# 8. Chains

A chain represents a sequence of processing steps.

A simple chain:

```text
Input
  ↓
Prompt Template
  ↓
LLM
  ↓
Output
```

A more complex workflow:

```text
User Input
    ↓
Prompt
    ↓
LLM
    ↓
Extract Information
    ↓
Retrieve Data
    ↓
LLM
    ↓
Final Answer
```

The important characteristic is that the workflow is largely **defined by the application**.

You can think of a traditional chain as:

```text
A → B → C → D
```

The developer determines the sequence.

---

# 9. Tools

A tool is a capability that allows the application or agent to perform an operation outside the LLM itself.

Examples:

```text
Weather API
Database Query
Calculator
Search API
GitHub API
Payment API
```

Conceptually:

```text
Agent
  |
  +--> Weather Tool
  |
  +--> Search Tool
  |
  +--> Calculator
  |
  +--> Database Tool
```

The important distinction is:

> The LLM does not actually execute the external operation.

The LLM can decide that a tool should be called and provide arguments. Your application/tool infrastructure performs the operation.

Example:

```text
User:
"What is the weather in Chennai?"

        ↓

Agent / LLM
"Call weather tool with Chennai"

        ↓

Weather Tool
        ↓
Weather API
        ↓
Weather data

        ↓

Agent / LLM
        ↓
Final response
```

---

# 10. Tool Calling

Tool calling is the mechanism through which a model can request a tool invocation.

Conceptually:

```text
User
 ↓
LLM
 ↓
Tool call:
get_weather(city="Chennai")
 ↓
Application executes tool
 ↓
Tool result
 ↓
LLM
 ↓
Final answer
```

Notice that there are two distinct parts:

### Model decision

```text
"Which tool should I call?"
"What arguments should I provide?"
```

### Application execution

```text
Actually call the API/function.
```

This distinction is important when designing reliable agent systems.

---

# 11. Retrieval

LLMs do not automatically have access to your private documents.

Suppose your application contains:

```text
company_handbook.pdf
travel_policy.pdf
insurance_policy.pdf
```

You can build a retrieval system around those documents.

The typical pipeline is:

```text
Documents
    ↓
Chunking
    ↓
Embeddings
    ↓
Vector Store
```

At query time:

```text
User Question
      ↓
Query Embedding
      ↓
Vector Search
      ↓
Relevant Chunks
      ↓
LLM + Retrieved Context
      ↓
Answer
```

This is the basis of RAG.

---

# 12. Embeddings

An embedding converts content into a numerical vector representation.

For example:

```text
"How do I deploy Kubernetes?"
             ↓
       Embedding Model
             ↓
 [0.12, -0.43, 0.81, ...]
```

Semantically related text tends to have vectors that are close according to an appropriate similarity measure.

Embeddings are commonly used for:

- Semantic search
- Document retrieval
- Similarity matching
- Recommendation systems
- RAG

---

# 13. Vector Stores

A vector store stores vectors and allows similarity-based retrieval.

Typical architecture:

```text
Documents
    ↓
Chunk
    ↓
Embedding
    ↓
Vector
    ↓
Vector Store
```

When the user asks a question:

```text
Question
   ↓
Embedding
   ↓
Vector Search
   ↓
Relevant Chunks
```

The retrieved chunks can then be provided to the LLM.

---

# 14. RAG

RAG means **Retrieval-Augmented Generation**.

It combines:

```text
Retrieval
    +
Generation
```

A basic RAG system:

```text
             USER QUESTION
                   |
                   v
             Query Embedding
                   |
                   v
             Vector Search
                   |
                   v
          Relevant Documents
                   |
                   v
       +-----------------------+
       | Question + Documents  |
       +-----------------------+
                   |
                   v
                  LLM
                   |
                   v
                Answer
```

The purpose is to give the model relevant external context at inference time.

---

# 15. Agents

An agent adds decision-making around tools and other capabilities.

A traditional chain might be:

```text
A → B → C → D
```

An agent can dynamically determine the next action:

```text
                Agent
                  |
       "What should I do next?"
                  |
       +----------+----------+
       |          |          |
       v          v          v
      RAG       Weather    Search
                Tool       Tool
```

For example:

```text
User:
"Plan my Japan trip and tell me
whether I need an umbrella tomorrow."

             ↓

           Agent
             |
       +-----+------+
       |            |
       v            v
   Trip planning   Weather
                    Tool
       |            |
       +-----+------+
             ↓
          Agent
             ↓
       Final answer
```

The agent is therefore an **orchestration/decision-making layer**.

---

# 16. Agent + RAG

An agent can use RAG as one of its capabilities.

Normal RAG:

```text
Question
   ↓
Retrieve
   ↓
LLM
   ↓
Answer
```

Agentic RAG:

```text
Question
   ↓
 Agent
   |
   +---- Retrieval required
   |          ↓
   |       Vector Store
   |          ↓
   |       Documents
   |          ↓
   +--------- Agent
              ↓
          Final Answer
```

The key difference is that the agent can decide whether retrieval is needed and potentially combine retrieval with other tools.

---

# 17. Memory and State

Agent applications often need to maintain information across multiple interactions.

Conceptually:

```text
Conversation
     ↓
State
     ↓
Agent
```

For example:

```text
User:
"My destination is Japan."

Later:

User:
"Make it cheaper."
```

The application needs access to the relevant previous state to understand what "it" refers to.

Memory/state can be implemented in different ways depending on the application architecture.

It is useful to distinguish:

- **Short-term conversation state:** information relevant to the current thread/session.
- **Long-term memory:** information intentionally persisted for future interactions.

LangGraph provides more explicit primitives for durable state, persistence, and workflow execution than the older conceptual "memory" abstractions often associated with LangChain.

---

# 18. LangChain and MCP

LangChain and MCP are complementary.

### LangChain

Provides application-level abstractions and orchestration for LLM applications.

### MCP

Provides a protocol for connecting AI applications to external tools, resources, and context.

Conceptually:

```text
                   AI Application
                         |
                    LangChain
                         |
                       Agent
                         |
                  +------+------+
                  |             |
                  v             v
                RAG          MCP Client
                               |
                  +------------+------------+
                  v            v            v
               GitHub       Database      Slack
               MCP Server   MCP Server   MCP Server
```

LangChain does not replace MCP.

MCP does not replace LangChain.

They can operate at different layers of the architecture.

---

# 19. A Complete LangChain Application

Consider a travel-planning agent.

The user asks:

> Plan a 7-day trip to Japan under ₹1 lakh and consider the weather.

A possible architecture:

```text
                         USER
                          |
                          v
                    Travel Agent
                          |
              "What should I do?"
                          |
        +-----------------+-----------------+
        |                 |                 |
        v                 v                 v
   Destination         RAG / Docs       Weather Tool
    validation             |                 |
        |                  v                 v
        |             Vector Store       Weather API
        |                  |                 |
        +------------------+-----------------+
                           |
                           v
                    Agent / LLM
                           |
                           v
                    Final Itinerary
```

LangChain can provide abstractions for several parts of this architecture.

---

# 20. LangChain vs LangGraph

These are related but should not be treated as identical.

A useful conceptual distinction is:

### LangChain

Useful for building LLM application components and agentic applications.

```text
Models
Prompts
Tools
Retrievers
Agents
Structured output
```

### LangGraph

Focused on **stateful, graph-based agent/workflow orchestration**.

Conceptually:

```text
        +------+
        | Node |
        +--+---+
           |
           v
        +--+---+
        | Node |
        +--+---+
           |
       +---+---+
       |       |
       v       v
     Tool    Agent
       |       |
       +---+---+
           |
           v
        Continue
```

LangGraph becomes especially useful when an application requires:

- Stateful execution
- Conditional routing
- Loops
- Persistence
- Checkpointing
- Human-in-the-loop workflows
- More explicit control over agent execution

A common modern architecture is therefore:

```text
LangChain components
        +
LangGraph orchestration
        ↓
Production agent
```

---

# 21. LangChain Does Not Mean "Everything Is an Agent"

This is an important distinction.

You can build a simple application:

```text
Prompt → LLM → Response
```

You can build a chain:

```text
Input → Step A → Step B → LLM
```

You can build RAG:

```text
Question → Retrieve → LLM
```

You can build an agent:

```text
Question → Agent → Tool/RAG/etc. → Answer
```

LangChain provides components that can support all of these patterns.

Therefore:

> **LangChain is not synonymous with agents.**

---

# 22. Mental Model

A useful overall model is:

```text
                         LANGCHAIN
                             |
          +------------------+------------------+
          |                  |                  |
          v                  v                  v
        MODELS             PROMPTS            TOOLS
          |                  |                  |
          v                  v                  v
     OpenAI/etc.       Templates          APIs / Functions
          |                  |                  |
          +------------------+------------------+
                             |
                             v
                          CHAINS
                             |
                +------------+------------+
                |                         |
                v                         v
             RAG /                    AGENTS
           Retrieval                     |
                |                        |
                v                 +------+------+
          Vector Store            |      |      |
                                  v      v      v
                                Tools   RAG   Memory
```

---

# 23. The Core Concepts to Remember

### LangChain

**Framework for building LLM-powered applications.**

### Model abstraction

**Common application interface for interacting with supported model providers.**

### Prompt template

**Reusable prompt structure with variables.**

### Chain

**Predetermined sequence of application/model operations.**

### Tool

**External capability that application/agent code can execute.**

### Tool calling

**Mechanism by which a model requests execution of a tool.**

### Embedding

**Vector representation used for semantic similarity/retrieval.**

### Vector store

**Storage and retrieval system for vectors.**

### RAG

**Retrieval + generation: retrieve relevant external context and provide it to the model.**

### Agent

**A decision-making/orchestration mechanism that can select and use tools or other capabilities.**

### MCP

**Protocol for standardized interaction between AI applications and external tools/resources.**

### LangGraph

**Graph-based orchestration framework for stateful, controllable agent/workflow execution.**

---

# 24. Final Learning Path

A strong conceptual progression is:

```text
1. LLM
   ↓
2. Prompt
   ↓
3. Prompt Template
   ↓
4. Model Abstraction
   ↓
5. Chain
   ↓
6. Structured Output
   ↓
7. Tool Calling
   ↓
8. Embeddings
   ↓
9. Vector Store
   ↓
10. RAG
   ↓
11. Agents
   ↓
12. Agent + RAG + Tools
   ↓
13. MCP
   ↓
14. LangGraph
```

The most important distinction is:

```text
LangChain
    = application framework/components

LangGraph
    = stateful graph orchestration

MCP
    = interoperability protocol for external capabilities

LLM
    = reasoning/generation model

RAG
    = retrieval + generation pattern

Agent
    = dynamic decision-making/orchestration
```

This mental model is more important than memorizing individual LangChain APIs, because LangChain's APIs and package structure evolve over time.
