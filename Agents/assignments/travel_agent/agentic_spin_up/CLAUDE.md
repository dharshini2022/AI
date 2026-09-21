# Project Memory

## Overview
Trip Planner Agent. Iteratively collects trip details from the user (source,
destination, start date, number of days, budget, number of travellers, travel
interests) via a mix of upfront prompt extraction and follow-up questions.
Books transportation, then proposes a day-by-day plan (places, restaurants,
accommodation, weather). The user can approve or edit the plan via natural-
language prompts (e.g. "no temples", "swap this place"), and picks one option
from the presented transportation choices. On bad weather, the agent surfaces
the forecast and asks whether to switch to indoor activities before proceeding.
Final approval returns a consolidated plan.

## Stack & Structure
- Language: TypeScript (ESM, Node 26 runs `.ts` directly — no build step; `tsc --noEmit` type-checks)
- Agent framework: LangChain.js (`createAgent`), sub-agents spun up dynamically
  via a custom tool driven by per-agent `.md` spec files
- LLM: `ChatOpenAI` pointed at `LLM_API_BASE` (LiteLLM proxy); provider is a `.env` change only
- Weather: Open-Meteo API
- Places / restaurants / accommodation: SerpAPI
- Transportation: custom DB-backed API (**not yet implemented**)
- Tool access: agent-to-tool over stdio-based MCP server connection
- Architecture detail: see `concepts/architecture.md`
- The original Python implementation this was ported from lives in `travel_agent_python/`, self-contained with its own `.venv` — see its section in `README.md`

## Common Commands
```
start:     npm start -- "<trip request>"
test:      npm test
typecheck: npm run typecheck
```

## Secrets
- Never read `.env`. Refer to `.env.example` for variable names and shapes.

## Coding Principles

**DRY**
- Never duplicate logic. Extract shared behavior into utilities, hooks, or services.
- Before writing new code, search `packages/assistants-core` and `packages/common` for existing implementations.
- Reuse existing shadcn/ui components, Drizzle schemas, and Zod validators — don't reinvent.

**Dead Code**
- Remove unused imports, variables, functions, types, and commented-out code whenever touching a file.
- Do not leave TODO stubs, feature flags for shipped features, or backwards-compat shims once they're no longer needed.
- If a function/type/export has no callers, delete it.

## Change Workflow

When a change is instructed:
1. Analyze it as an architect — is this a good change? If not, explain the bottlenecks and suggest an alternative before proceeding.
2. Identify exactly where in the codebase the change needs to happen.
3. Write `current_implementation.md` at the repo root documenting before/after for the proposed change.
4. Wait for the user to say "proceed."
5. On proceed: make the changes, then delete `current_implementation.md`.
6. If the change reflects a notable architectural decision or concept, add or update a file in `concepts/<name>.md` describing it.

*(Full procedural detail for this workflow can move into `.claude/commands/change.md` or `.claude/skills/change/SKILL.md` if it grows — keep this file to the summary.)*

## Daily Workflow

- `/start` — begin the day with a fresh-memory mindset (see `.claude/commands/start.md`)
- `/end` — close the day; generates a report of changes made and concepts learned since `/start` (see `.claude/commands/end.md`)

## Communication Style

- Explain concepts and decisions in simple, plain English — avoid jargon
  unless it's a term already used in this codebase/stack. When a technical
  term is unavoidable, briefly define it.
- Prefer short sentences and concrete examples over abstract descriptions.

## Workflow Diagrams

- Whenever describing a multi-step process, workflow, or architecture
  (e.g. the agent's trip-planning flow, the Change Workflow above, sub-agent
  spawning), include a Mermaid diagram alongside the explanation, not instead
  of it.
- Keep diagrams focused — one flow per diagram. Use `flowchart` for
  sequential/decision logic and `sequenceDiagram` for agent-to-tool or
  agent-to-agent interactions over the MCP connection.
- Store diagrams that describe a durable concept in the relevant
  `concepts/<name>.md` file (per the Change Workflow's step 6) so they don't
  go stale in chat history.