# LangChain, Prompt Templates, Vector Stores, RAG, and Agents

## 1. LangChain LLM Wrappers vs MCP

LangChain and MCP both involve abstraction and standardization, but they solve different problems.

### LangChain LLM abstraction

The problem is:

> How can my application interact with different LLM providers through a common programming interface?

```text
Your Application
      |
      v
Common LLM interface
      |
  +---+--------+---------+
  v            v         v
OpenAI      Anthropic  Gemini
```

### MCP

MCP (Model Context Protocol) standardizes how AI applications interact with external tools, resources, and data sources.

```text
              AI Application
                    |
                   MCP
        +-----------+-----------+
        v           v           v
   GitHub MCP   Database MCP  Slack MCP
      Server        Server       Server
```

### Key distinction

| | LangChain LLM abstraction | MCP |
|---|---|---|
| Standardizes | Model interaction | Tool/resource interaction |
| Connects | Application → LLM | AI application → external systems |
| Examples | OpenAI, Anthropic, Gemini | GitHub, Slack, databases |
| Main purpose | Model abstraction | Tool/context interoperability |
| Protocol | Framework/API abstraction | Protocol |

LangChain and MCP can coexist. LangChain can orchestrate an agent that uses MCP-provided tools.

---

## 2. Prompt Templates

A prompt template is a reusable prompt structure containing variables.

```text
You are a travel planning assistant.

Destination: {destination}
Budget: {budget}
Preferences: {preferences}

Create a suitable itinerary.
```

The application supplies values:

```text
destination = Japan
budget = ₹100,000
preferences = Cultural experiences
```

The template produces the final prompt.

### Who creates the template?

In a typical application, the **developer creates the prompt template**. The end user normally provides the information that fills the variables.

```text
Developer
    |
    | defines
    v
Prompt Template
    |
    | application supplies values
    v
Filled Prompt
    |
    v
LLM
```

A UI can also provide predefined templates for users to choose from, but that is an application-level design choice.

### Prompt template as a function

A useful analogy:

```python
def create_prompt(destination, days, budget):
    return f"""
    Plan a trip to {destination}
    for {days} days
    with a budget of {budget}.
    """
```

The developer defines the structure; the application provides the arguments.

---

## 3. Does LangChain Automatically Extract Values from User Input?

No.

If a template expects:

```text
{destination}
{days}
{budget}
```

and the user says:

> I want to go to Japan for a week with a budget of ₹1 lakh.

Something must convert the natural-language request into structured values:

```text
destination = Japan
days = 7
budget = ₹100,000
```

This can be done using:

- Application logic
- An LLM
- Structured output
- A combination of deterministic parsing and LLM extraction

A prompt template itself does not perform arbitrary natural-language extraction.

---

## 4. System Prompt vs Prompt Template

### System prompt

Defines the agent's behavior and instructions:

```text
You are a travel planning agent.

Validate destinations before planning.
Use the weather tool when weather information is required.
```

### Prompt template

Provides a reusable structure with dynamic variables:

```text
Plan a trip to {destination}
for {days} days
with a budget of {budget}.
```

Distinction:

- **System prompt:** instructions about how the agent should behave.
- **Prompt template:** reusable prompt structure with variables.

---

## 5. Documents and Prompts in Vector Stores

Documents and prompts **can** both be stored in a vector store, but storing something in a vector store does not automatically make it RAG or prompt caching.

A vector store is fundamentally a **semantic retrieval system**.

```text
                 Vector Store
                      |
          +-----------+-----------+
          v                       v
      Documents                Prompts
          |                       |
   "What information       "Which prompt is
    is relevant?"           relevant?"
          |                       |
          v                       v
         RAG              Prompt Retrieval
```

### Documents in a vector store

A typical RAG pipeline:

```text
Documents
    |
    v
Chunking
    |
    v
Embedding Model
    |
    v
Vectors
    |
    v
Vector Store
```

At query time:

```text
User Question
      |
      v
Create query embedding
      |
      v
Vector Search
      |
      v
Relevant Documents
      |
      v
LLM + Retrieved Context
      |
      v
Answer
```

### Prompts in a vector store

Prompts can also be embedded and retrieved semantically:

```text
User Request
      |
      v
Embedding
      |
      v
Vector Search
      |
      v
Most Relevant Prompt
      |
      v
LLM
```

This is better described as **prompt retrieval** or **semantic prompt selection**.

It does not automatically mean prompt caching.

---

## 6. Prompt Retrieval vs Prompt Caching

These are different concepts.

### Prompt retrieval

Question:

> Which prompt is most relevant to this task?

```text
Request
   |
   v
Embedding
   |
   v
Vector Store
   |
   v
Relevant Prompt
```

### Prompt caching

Question:

> Can previously processed or reusable prompt content/computation be reused instead of processing it again?

Caching is primarily an **inference/provider performance and cost optimization**.

Therefore:

```text
Vector Store
    |
    +--> Semantic retrieval

Cache
    |
    +--> Reuse previously processed data/computation
```

A vector store is not itself a prompt cache.

---

## 7. Can an Agent Have RAG?

Yes.

An agent can use RAG as one of its capabilities.

For example:

```text
                    TRAVEL AGENT
                         |
             +-----------+-----------+
             v           v           v
          Weather      Places      Knowledge
           Tool         Tool       Retrieval
                                    |
                                    v
                              Vector Store
                                    |
                                    v
                              Travel Documents
```

The agent can decide that it needs company travel guidelines, invoke retrieval, receive relevant documents, and continue reasoning.

```text
User request
     |
     v
   Agent
     |
     v
"Need company travel guidelines"
     |
     v
    RAG
     |
     v
Vector Store
     |
     v
Relevant Documents
     |
     v
   Agent
     |
     v
Final Answer
```

---

## 8. Agent vs RAG

Do not think:

```text
Agent = RAG
```

Instead:

```text
Agent = decision-making/orchestration mechanism
       that can use RAG, tools, memory, etc.
```

An agent might have:

```text
                       AGENT
                         |
          "What should I do next?"
                         |
        +----------------+----------------+
        v                v                v
       RAG           Weather Tool      Search Tool
        |                |                |
   Vector Store      Weather API       Web/API
```

The agent decides when to use each capability.

---

## 9. Normal RAG vs Agentic RAG

### Normal RAG

The retrieval workflow is predetermined:

```text
Question
   |
   v
Retrieve Documents
   |
   v
LLM
   |
   v
Answer
```

### Agent + RAG

The agent can decide whether retrieval is necessary:

```text
Question
   |
   v
 Agent
   |
   +---- No retrieval needed ---> Answer / another tool
   |
   +---- Retrieval needed
             |
             v
            RAG
             |
             v
        Vector Store
             |
             v
      Relevant Documents
             |
             v
           Agent
             |
             v
        Final Answer
```

This is commonly described as **agentic RAG** when an agent dynamically decides how or when retrieval should be used.

---

## 10. Overall Mental Model

```text
                         AI APPLICATION
                               |
                 +-------------+-------------+
                 |                           |
                 v                           v
              MODEL                      AGENT
                 |                           |
          LangChain model             "What should I
           abstraction                 do next?"
                 |                           |
        +--------+--------+       +----------+----------+
        |        |        |       |          |          |
        v        v        v       v          v          v
       GPT    Claude   Gemini    RAG       Tools      Memory
                                  |          |
                                  v          v
                           Vector Store   APIs / MCP
```

### Key distinctions

| Concept | What it does |
|---|---|
| LLM wrapper/model abstraction | Common way to interact with model providers |
| Prompt template | Reusable prompt structure with variables |
| Vector store | Semantic retrieval |
| RAG | Augments generation with retrieved information |
| Prompt retrieval | Retrieves relevant prompts semantically |
| Prompt caching | Reuses previously processed/reusable prompt content or computation |
| Agent | Decides what actions/capabilities to use |
| MCP | Standardized protocol for connecting AI applications to external capabilities |

## Key takeaway

A useful learning progression is:

```text
LLM
  ↓
Prompt
  ↓
Prompt Template
  ↓
Chain
  ↓
Embeddings + Vector Store
  ↓
RAG
  ↓
Tool Calling
  ↓
Agent
  ↓
Agent + RAG + Tools
  ↓
LangGraph
```

The core separation to remember:

- **Vector store → retrieval mechanism**
- **RAG → pattern that augments generation with retrieved information**
- **Agent → decision-making/orchestration mechanism**
- **Prompt cache → performance/cost optimization**
- **MCP → standardized protocol for connecting AI applications to external capabilities**
