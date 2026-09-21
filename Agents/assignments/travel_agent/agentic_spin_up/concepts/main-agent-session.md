# Main Agent Session: Corrections at Any Point

This adapts the sub-agent lifecycle pattern (see `concepts/subagent-lifecycle.md`) one level up: the
Main Agent — previously a single `createAgent().invoke()` call, start to finish — now runs as its own
`Agent` session, on a fixed `thread_id`, so a correction the user types mid-run ("actually 5 days, not
3") can be delivered without losing what has already been researched.

## Why the Main Agent needed the same pattern as a sub-agent

Before this change, the only way to talk to the Main Agent was when *it* asked (`ask_user`,
`choose_transport`, `ask_yes_no`). There was no way to interrupt it — a correction had to wait until
the whole run finished, or be answered as if it were the answer to whatever question was currently
being asked.

A sub-agent already solves an equivalent problem: `SpinUp` keeps a `checkpointer`-backed session per
task and an inbox for messages that arrive mid-turn. `MainAgentSession` (`travel_agent/mainAgent.ts`)
is the same idea, applied to the Main Agent's own conversation:

- **The session**: `mainAgent = new Agent(MAIN_AGENT_SPEC, mcp, { sessionId: "main", checkpointer, tools })`.
  `Agent`'s constructor now accepts an explicit `tools` list (rather than always deriving it from
  `spec.tools` against the MCP server), since the Main Agent's tools (`launch_subagent`, `ask_user`, …)
  aren't MCP tools at all.
- **The inbox**: `MainAgentSession.send()` runs a turn immediately if idle, or queues the message if
  busy — resolved once that queued turn actually runs, not when it's merely accepted. This mirrors
  `SpinUp.runTurn`'s inbox-draining, one level up.
- **No true interruption**: exactly like a sub-agent's turn, a correction can't interrupt a
  `graph.invoke()` already in flight — it can only be delivered as the *next* turn on the same thread,
  which the checkpointer lets pick up with full memory of what was already done.

## Where corrections come from: `StdinChannel`

`travel_agent/stdin.ts` opens **one** `readline` interface for the whole CLI run instead of one per
prompt. Every line is either:

- a `/correct <change>` message — always forwarded to whichever session registered a handler via
  `setCorrectionHandler`, regardless of what the Main Agent is doing at that moment, or
- an answer to whatever `Hitl` prompt (`askUser`/`askChoice`/`askYesNo`) is currently pending.

The prefix is what makes the two unambiguous on one stream: a plain-line "always-on" reader would have
a real race (is this line an answer to the question just asked, or an unsolicited correction?); the
prefix sidesteps it. `Hitl` now takes an optional `StdinChannel` and reads from it instead of opening
its own `readline` interface per call — scripted `answers` (used by tests) still take priority and never
touch stdin.

## STEP 0 in the Main Agent's prompt

The Main Agent's system prompt (`SYSTEM` in `mainAgent.ts`) gained a rule for reconciling a changed
requirement with whatever has already been told to a sub-agent:

- **`source`/`destination`/`start_date` changed** → the existing research is about the wrong trip
  entirely: `stop_subagent` (if running) then `launch_subagent` again, never `send_message_to_subagent`.
- **`num_days`/`num_travellers`/`interests`/`budget` changed** → the research is still valid, just
  needs re-filtering: `send_message_to_subagent` with the new value(s).
- **A task already `failed`** → `launch_subagent` again regardless of which field changed.

This scope is deliberately limited to structured requirement fields, not free-form comments — a
narrower testing surface, and every field maps to one unambiguous reconciliation action.

## Corrections after the plan is assembled

Unlike a sub-agent (whose conversation is over once it stops asking questions), the Main Agent's
session stays reachable even after it has replied with the STEP 5 JSON and `planTrip` has built and
shown a plan. `planTrip` shows the plan, then races two things: the user pressing Enter to finish, or
`session.nextCorrection()` resolving because a `/correct` line arrived. A correction reopens assembly —
the Main Agent reconciles it via the same STEP 0 rule on its own session (so it remembers everything it
already told each sub-agent), and `buildPlan` reruns from its updated answer. This closes the one gap
`subagent-lifecycle.md`'s guarantees don't cover on their own: a correction that arrives after the
Main Agent's LLM session would otherwise be considered finished.
