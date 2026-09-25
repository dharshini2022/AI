# Skill Usage: Two-Phase Mechanism

How skills are loaded and used by agents, from initialization through execution.

## Overview

Skills follow a two-phase pattern:

1. **Setup Phase** — when an agent is created: extract skill metadata, append descriptions to system prompt
2. **Runtime Phase** — when an agent is executing: agent decides which skill to use, loads full instructions on-demand

This design keeps the system prompt lean (only descriptions, not full instructions) while making skills available when needed.

## Phase 1: Setup (Agent Initialization)

**When:** `new Agent(spec, ...)` in `agent.ts`

**What happens:**

```
Agent constructor called with spec
  ↓
  spec.skills = ["budget_cut", "apply_user_edit"]
  ↓
  Two setup functions called:
  
  1. skillCatalog(spec.skills)
     ├─ loadSkillHeader("budget_cut")
     │  └─ Returns: { name: "budget_cut", description: "Use when..." }
     └─ loadSkillHeader("apply_user_edit")
        └─ Returns: { name: "apply_user_edit", description: "Use when..." }
     ↓
     Formats as markdown block:
     
     ## Skills available to you
     These are extra instructions for a situation that doesn't come up on every turn...
     - budget_cut: Use when the total cost exceeds the budget
     - apply_user_edit: Use when the user wants to modify the plan
     
     ↓
     Appended to system prompt
  
  2. createLoadSkillTool(spec.skills)
     ├─ Creates allowlist Set: {"budget_cut", "apply_user_edit"}
     └─ Returns a LangChain Tool named "load_skill"
        (which can only load skills in the allowlist)
     ↓
     Added to agent's available tools
```

**Key points:**
- Only **name + description** are extracted (via `loadSkillHeader`)
- Full **instructions (body) are NOT loaded yet** — they're fetched on-demand
- The **allowlist** restricts which skills this specific agent can load
- This setup is code-driven, not LLM-driven

---

## Phase 2: Runtime (Agent Execution)

**When:** Agent is running and processing messages

**What happens:**

```
Agent receives message: "no temples please"
  ↓
  Agent reads system prompt (which includes skill catalog)
  ↓
  Agent LLM thinks: "This looks like an edit request.
                    I should check my skills..."
  ↓
  Agent reads in system prompt:
  "- apply_user_edit: Use when the user wants to modify the plan"
  ↓
  Agent LLM decides: "Yes, this matches. I'll call load_skill."
  ↓
  Agent calls: load_skill({ name: "apply_user_edit" })
  ↓
  LangChain Tool handler:
  ├─ Checks allowlist: "Is apply_user_edit in my allowed set?"
  │  └─ YES ✓
  ├─ Calls: loadSkillBody("apply_user_edit")
  │  └─ Reads SKILL.md file, extracts body (full instructions)
  └─ Returns: { instructions: "...full instructions..." }
  ↓
  Agent receives full instructions for that skill
  ↓
  Agent follows those instructions for this turn
```

**Key points:**
- Agent **reads descriptions** in its system prompt (from Phase 1)
- Agent **decides** which skill to use (LLM judgment)
- Agent **calls the tool** to load the body on-demand
- **Guardrail:** Allowlist ensures agent can't load skills outside its spec
- **Full instructions are fetched only when needed** — saves tokens on most turns

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                      SETUP PHASE                             │
│              (Agent.ts constructor)                          │
└─────────────────────────────────────────────────────────────┘

  Spec declares:
  skills: ["budget_cut", "apply_user_edit"]
  
           ↓
  
  loadSkillHeader()          createLoadSkillTool()
  ├─ Read SKILL.md           ├─ Create allowlist Set
  ├─ Extract frontmatter     └─ Wrap in LangChain Tool
  └─ Return name+description
  
           ↓                           ↓
  
  skillCatalog()            load_skill Tool
  (format as text)          (guards calls)
  
           ↓                           ↓
  
  └────────────────────┬─────────────────┘
                       ↓
                 System Prompt
           (with skill descriptions)


┌─────────────────────────────────────────────────────────────┐
│                     RUNTIME PHASE                            │
│          (Agent.invoke() on each message)                    │
└─────────────────────────────────────────────────────────────┘

  Agent reads skill descriptions
  in system prompt
  
           ↓
  
  Agent LLM decides which skill
  applies to the current message
  
           ↓
  
  Agent calls: load_skill({ name: "X" })
  
           ↓
  
  Tool handler checks allowlist
  (Is this skill in my spec.skills?)
  
           ↓ YES
  
  loadSkillBody("X")
  ├─ Read SKILL.md
  └─ Extract body (instructions)
  
           ↓
  
  Agent receives full instructions
  and follows them for this turn
```

---

## The Two Mechanisms

### Mechanism 1: Setup — Extracting Descriptions

**Functions used:** `loadSkillHeader()`, `skillCatalog()`

**Role:** Internal setup (not exposed to agent as a tool)

```ts
// These run once when agent is created
const descriptions = skillCatalog(spec.skills);
// Returns markdown text like:
// "## Skills available to you\n- skill1: description1\n- skill2: description2"

// This gets appended to the system prompt
const systemPrompt = spec.body + descriptions;
```

**Purpose:**
- Inform the agent which skills are available
- Tell the agent *when* to use each skill (via descriptions)
- Keep system prompt lean (only descriptions, not full bodies)

---

### Mechanism 2: Runtime — Loading Instructions

**Tool:** `load_skill` (LangChain Tool created by `createLoadSkillTool()`)

**Used by:** The agent (LLM decides when to call it)

```ts
// Agent calls this during execution
const result = await load_skill.invoke({ name: "apply_user_edit" });
// Returns: { instructions: "full body of the skill..." }
```

**Purpose:**
- Guard against agents loading skills outside their spec
- Fetch full instructions only when needed
- Give agent the detailed rules for that specific situation

---

## Why Two Phases?

| Aspect | If we put full instructions in system prompt | With two-phase loading |
|---|---|---|
| System prompt size | Large (carries all skill bodies) | Small (only descriptions) |
| Agent decision | Pre-wired (instructions always there) | LLM judgment (reads descriptions, decides) |
| Token cost | High on every turn | Low most turns, higher only when skill used |
| Flexibility | Fixed triggers (code-attached) | Agent-driven (model decides) |

**Trade-off:** We gain token efficiency but rely on the agent to notice when a skill applies. The mitigation: each skill's description is specific and mechanical (not open-ended), so the match is close to deterministic.

---

## Adding a New Skill

1. Create folder: `travel_agent/agent-skills/<skill_name>/`
2. Create file: `travel_agent/agent-skills/<skill_name>/SKILL.md` with:
   ```yaml
   ---
   name: my_skill
   description: "Use when [specific condition], e.g. user says X or payload has Y"
   ---
   
   Full instructions for the agent to follow when this skill applies.
   ```
3. Add to agent's spec: In `travel_agent/agent_specs/<agent_name>.md`, add to frontmatter:
   ```yaml
   skills: [my_skill]
   ```

That's it. The loader (`skillLoader.ts`) handles the rest automatically.

---

## Key Files

- **Loader:** `travel_agent/skillLoader.ts`
  - `loadSkillHeader(name)` — Extract name + description
  - `loadSkillBody(name)` — Extract full body
  - `skillCatalog(names)` — Format descriptions for system prompt
  - `createLoadSkillTool(names)` — Create the `load_skill` tool

- **Wiring:** `travel_agent/agent.ts` (Agent constructor)
  - Calls `skillCatalog()` to append descriptions
  - Calls `createLoadSkillTool()` to add the tool

- **Definition:** `travel_agent/agent-skills/<name>/SKILL.md`
  - Frontmatter: name, description
  - Body: full instructions

- **Declaration:** `travel_agent/agent_specs/<agent>.md`
  - Frontmatter: `skills: [...]`
