# Skills

**See also:** [`concepts/features/skill_usage/skill_usage.md`](../features/skill_usage/skill_usage.md) for a detailed walkthrough of how skills are loaded and used at runtime (the two-phase mechanism).

A skill is a short instruction snippet an agent loads for itself when its own situation calls for it, instead
of carrying the instructions permanently in its base spec. It solves a narrower problem than a spec: a spec
(`agent_specs/*.md`, see `subagent-lifecycle.md`) is the *entire* system prompt for a *new* agent; a skill is a
few extra rules for *one turn* of an *already-running* agent, loaded only when that turn actually needs them.

## Why

`place_agent.md` used to carry two instruction blocks — how to cut costs on a budget re-check, and how to turn
"no temples" into `exclude: ["temples"]` — on every turn of every trip, even though most trips never trigger
either flow. Both are genuine LLM judgment calls (so removing them outright would be wrong — see
`concepts/features/booking-email.md` for the opposite case, where there's no judgment call to package at all),
but they didn't need to be in context by default.

## History: from code-attached to agent-loaded

The first version of this had `mainAgent.ts` decide *and* attach skills: it detected the trigger (budget over
cap, an edit request after `present_plan`) and stuffed the skill's body into a `skill_instructions` field on
the message it sent to `place_agent`. That worked for two skills with two disjoint, code-visible triggers, but
it meant `mainAgent.ts` — orchestration policy — named specific skills, and adding a third skilled sub-agent
meant editing the orchestrator plus copy-pasting a "read the skill_instructions field" paragraph into its spec.

The current design inverts that dependency: **each spec declares its own skills; a generic loader serves every
agent identically.** `mainAgent.ts` no longer names any skill.

## Mechanics

- **Files:** `travel_agent/agent-skills/<name>/SKILL.md` — one folder per skill, sibling to `agent_specs/` so
  `config.ts`'s `ROOT`-relative resolution (`settings.skillDir`) needed no change. Same markdown + YAML
  frontmatter shape as a spec (`splitFrontmatter`, exported from `travel_agent/specs.ts`), but with no
  `tools`/`model`/`output` — a skill is never used to construct a new `Agent`.
- **Frontmatter is load-bearing now.** `description` is the routing rule a model reads to decide whether a
  skill applies to the message in front of it, so it must say *when to use this*, not just what it is — e.g.
  "Use when a message contains a `budget_feedback` field...". Previously this field existed but nothing ever
  read it.
- **Declaration:** `AgentSpec.skills: string[]` (`travel_agent/specs.ts`), parsed from a spec's `skills:`
  frontmatter exactly like `tools:`. `loadSpec` validates every declared name resolves to a real
  `<name>/SKILL.md` and throws immediately if not — a typo in `skills:` fails at startup, not the first time an
  agent tries to load it mid-conversation.
- **Loader:** `travel_agent/skillLoader.ts`, agent-agnostic, three exports:
  - `loadSkillMeta(name)` → `{ name, description, body }`.
  - `skillCatalog(names)` → the prompt block listing `name: description` for exactly the given names; `""` for
    an empty list, so nothing is appended to an agent with no skills.
  - `createLoadSkillTool(names)` → a `load_skill` tool scoped to exactly those names. Calling it for a name
    outside that list returns an error, never the file — the same enforcement shape `spec.tools` already gives
    MCP tool access (`agent.ts`).
- **Wiring:** `Agent`'s constructor (`agent.ts`) does two things whenever `spec.skills.length > 0`:
  appends `skillCatalog(spec.skills)` to the system prompt, and concatenates `createLoadSkillTool(spec.skills)`
  onto whichever tool list the agent would otherwise get (MCP tools for a sub-agent, or the Main Agent's own
  explicitly-passed tools). An agent with no skills gets neither the catalog text nor the tool.
- **RBAC:** `load_skill` is listed in `USER_PERMISSIONS` (`rbac/rbac.ts`) like any other tool name, or the RBAC
  middleware denies every call to it.

## Who decides what, now

| | Before | Now |
|---|---|---|
| Which skills exist for agent X | implicit — whatever `mainAgent.ts` attached | declared in X's own spec (`skills:`) |
| When a skill applies | code (`!budget.ok`, a specific tool body) | the agent itself, from its catalog's descriptions |
| Loading the instructions | code pasted them into the message | the agent calls `load_skill` |
| `mainAgent.ts`'s role | named both skills, decided both triggers | sends plain facts only; names no skill |

This trades a deterministic, code-guaranteed trigger for a model decision: `place_agent` must notice that a
`budget_feedback` field matches its catalog entry and choose to call `load_skill` before acting, where before
it simply received the instructions already attached. The mitigation is that each skill's `description` names
the literal signal to look for (a payload key, a message shape), so the match is close to mechanical rather
than open-ended judgment. If this proves unreliable in practice, the fallback that keeps the same dependency
direction is: code still decides *when*, but sends a neutral `skill_hint` naming a skill **read from the
agent's own spec**, never a literal in `mainAgent.ts`.

## What is, and isn't, a skill candidate

A skill must earn its place by three properties, not two:

1. **Large enough** — its body is big enough that not loading it by default actually saves meaningful tokens.
2. **Rare enough** — most turns of most trips never trigger it. A block that fires on most runs costs the same
   as leaving it in the spec, plus an added load-skill round-trip, for no saving.
3. **Safe to miss** — now that loading is the agent's own decision, a turn where it fails to load a matching
   skill must degrade gracefully, not silently break a core flow.

The third property is new since the code-attached era, and it's the direct consequence of moving the decision
into the model: a trigger that is rare but *unsafe to miss* (e.g. anything on a critical, always-taken path) is
a worse skill candidate now than it would have been when code guaranteed the attachment.

`place_agent`'s two skills both clear the bar: `budget_cut` (~215 tokens) and `apply_user_edit` (~1,100 tokens)
each fire on a minority of trips, and missing either degrades to "the plan stays as it was" rather than a
broken flow. The Main Agent currently declares `skills: []` — see the frontmatter comment in
`agent_specs/main/main_agent.md` for why its largest candidate blocks (STEP 4's edit-routing table, STEP 2's
orchestration rules) fail property 2, since they fire on most trips.

Two counter-examples, kept exactly as they were:
- **Booking + email** (`bookingFlow.ts`) — no LLM judgment step exists to package; it's deliberately plain,
  RBAC-gated code (`concepts/features/booking-email.md`).
- **HITL gates and search/pricing fallback chains** (`hitl.ts`, `tools/search/*`, `tools/providers/`) — repeated
  code *shapes*, but no LLM ever reasons over them, so there's nothing for a skill to attach to; that's a
  DRY/code-modularity concern, not a skills one.

## Adding a new skilled sub-agent

Because the mechanism is generic, adding one is now a file-only change:

```
   1. write agent_specs/<new>.md declaring tools: [...] and skills: [...]
   2. write agent-skills/<skill_name>/SKILL.md per declared skill, with a
      description that states the exact trigger to watch for
                          |
                          v
   Agent.ts appends the catalog + load_skill tool automatically.
   mainAgent.ts needs NO edit -- it never names a skill.
```

Contrast with adding a sub-agent under the old design, which required editing `mainAgent.ts` for every new
skill: a hardcoded call site, a hardcoded log line naming the agent, and a hand-copied "read this field"
paragraph in the new spec.
