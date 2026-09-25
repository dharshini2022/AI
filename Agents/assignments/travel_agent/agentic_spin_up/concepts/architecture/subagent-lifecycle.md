# Sub-agent Lifecycle

This adapts the queue-based sub-agent pattern (launch → worker → report back) to a single process: no database, no job queue, no second service. Only the Main Agent's LLM decides which sub-agents to launch and what to tell them. Code runs what was launched, waits, and reports status.

## Main Agent tools (`travel_agent/spinUp.ts`)

| Tool | What it does | Waits? |
|---|---|---|
| `launch_subagent(spec_name, task)` | Starts a sub-agent from its spec in the background and returns `task_id` | No |
| `wait_for_subagents(task_ids?, until="all"\|"any", timeout_seconds?)` | Waits until tasks stop running (or the first one does), then returns status, question, error and a compact research summary | Yes |
| `check_subagent_status(task_ids?)` | The same view, right now | No |
| `send_message_to_subagent(task_id, message)` | Continues that sub-agent's own conversation: an answer, a comment or new instructions | No |
| `stop_subagent(task_id, reason?)` | Cancels the running turn and drops queued messages; memory is kept, so a later message resumes it | No |

## Which specs can be launched

`loadSpec`/`listSpecs` (`travel_agent/specs.ts`) read `agent_specs/`. Every *sub-agent* spec is a direct child of
that folder (`place_agent.md`, `transportation_agent.md`), so `listSpecs()` finds it, and `launch_subagent`'s tool
description advertises it to the Main Agent as a valid `spec_name`.

The Main Agent's own spec (`agent_specs/main/main_agent.md`) is deliberately **one level deeper**, in its own
subfolder — `listSpecs()`'s directory scan isn't recursive, so it never appears there, and `mainAgent.ts` is the
only code that loads it, by passing that subfolder explicitly to `loadSpec`. The Main Agent must never be able to
launch itself as a sub-agent: doing so would spin up a second, live LLM session running its own system prompt with
none of the custom tools (`ask_user`, `extract_requirements`, …) that only exist because `mainAgent.ts` passes them in
by hand — a broken, resource-consuming session with no path to actually doing anything.

That file layout is the *first* line of defense, but it's an emergent property of `readdirSync` not recursing —
not something anyone reading `spinUp.ts` would see. So `spinUp.ts` also keeps an explicit `NOT_LAUNCHABLE` set,
checked both when building `launch_subagent`'s description (so `"main_agent"` is never *suggested*) and inside
`launch()` itself (so a call naming it directly is rejected, not run). `tests/specs.test.ts` and
`tests/subagents.test.ts` assert both: that `listSpecs()` never contains `"main_agent"`, and that a launch attempt
naming it fails.

## How it works

- **Status record:** every launch creates a `SubagentTask` with `status` (`running`, `done`, `needs_clarification`, `failed`, `stopped`), `turns`, timings, the latest reply, the error, an inbox, and the raw tool results.
- **Sessions:** each task's `Agent` is built once, with `createAgent({ checkpointer })`, and runs every turn on `thread_id = task_id`. The shared `MemorySaver` restores the earlier conversation, so a new message continues where the last turn ended.
- **Ending a turn:** a sub-agent's turn ends the way any `createAgent` run does, when the model replies without calling a tool. Replying `{"done": false, "needs_clarification": "…"}` marks the task `needs_clarification`. No LangGraph `interrupt` is needed, because the checkpointer already preserves the conversation between turns.
- **Messages to a busy sub-agent:** a message can't be injected into a model call that's already in flight. It waits in the task's inbox and becomes the next turn automatically.
- **Stopping:** each turn runs with an `AbortController`. `stop_subagent` aborts it, the in-flight model request is cancelled, and the task becomes `stopped`.
- **Limits:** `SUBAGENT_MAX_CLARIFICATIONS` (default 2) questions per task, after which the task is marked `failed`. `SUBAGENT_WAIT_TIMEOUT_MS` (default 300 s) caps every wait.
- **Failures never throw:** a turn's error becomes `status: failed` with the message, so the Main Agent's conversation continues.

## How `wait_for_subagents` wakes up

- **`until="all"`:** returns when **every** requested task has stopped running.
- **`until="any"`:** returns when the **next** running task stops, meaning it finishes, asks a question, fails or is stopped. If nothing is running, it returns at once.

Either way, the result lists **every** requested task's current status, not just the one that woke it.

The Main Agent's prompt uses `until="any"` in a loop: wait, handle whatever came back, wait again, until no task is `running` or `needs_clarification`. That lets it react to a question as soon as it's asked, instead of after the slowest sub-agent finishes.

## Use case 1: a question while the other sub-agent keeps working

**Scenario:** *"Bangalore to Munnar, 3 days, 2 people, budget ₹15,000."* The place agent finds no stays under the nightly rate it's aiming for, and can't tell whether you'd rather spend more on the stay or less on food.

| Time | What happens | In code |
|---|---|---|
| **t0** | The Main Agent launches the transport and place agents; both start working in the background | `launch_subagent` ×2 → `SpinUp.launch` creates `transportation_agent-1` and `place_agent-1`, each running its first turn without being waited on |
| **t1** | The Main Agent waits for news | `wait_for_subagents(until="any")` → `SpinUp.wait` |
| **t2** | The place agent asks *"No stays under ₹1,000 — relax the limit?"* and ends its turn. It is now idle, with its memory saved. **The transport agent is still searching.** | The place agent replies `{"done": false, "needs_clarification": "…"}` → `runTurn` sets `status: needs_clarification`; `place_agent-1`'s turn promise settles, so the wait wakes up |
| **t3** | The Main Agent reads the question and asks you. **The transport agent is still working.** | The wait result shows `place_agent-1: needs_clarification` (with `question`) and `transportation_agent-1: running` → the Main Agent calls `ask_user` → `Hitl.askUser` |
| **t4** | You answer *"Yes, up to ₹2,000 a night."* The Main Agent passes it on, and the place agent continues **with its memory**: it doesn't redo searches that are still valid | `send_message_to_subagent("place_agent-1", "…")` → `SpinUp.send` → new turn on `thread_id = place_agent-1`; `MemorySaver` restores the earlier conversation and appends your answer |
| **t5** | The Main Agent waits again until both are done, then moves on to the transport choice | `wait_for_subagents(until="any")` repeated until neither task is `running` or `needs_clarification` → `choose_transport` |

**What you notice:** one extra question in the terminal, while transport research carries on uninterrupted. Nothing was frozen.

**Compared with the old synchronous design:** the Main Agent could only call a sub-agent and sit waiting for it to finish. A question couldn't be asked mid-research at all, so the sub-agent had to guess. Even if it could, t1–t5 would have been one frozen chain.

## Use case 2: both sub-agents report at the same moment

**Scenario:** the transport agent asks *"No buses on 2 October — search 3 October instead?"* just as the place agent asks *"Cut food or stays to fit ₹15,000?"* Or both simply finish together.

- **No collision.** Each sub-agent writes only to **its own task record** (status, reply, question). JavaScript also runs one callback at a time, so even "simultaneous" completions are recorded one after the other, never mixed up.
- **One wake-up shows both.** `wait_for_subagents` builds its result from every task's *current* status after it wakes, so the Main Agent usually gets both questions (or both results) in **one** tool result. If the second arrives a moment later, the next `wait_for_subagents(until="any")` call returns immediately, because nothing is left running.
- **The Main Agent handles both in one go.** It can answer from the requirements when it knows the answer (e.g. the trip date is fixed, so it tells the transport agent to keep 2 October). Otherwise it asks you.
- **Your prompts never overlap.** If it asks you both questions, `Hitl.serial()` shows them one after the other.
- **Answers can't go to the wrong agent.** Each `send_message_to_subagent` names a `task_id`, so each answer lands only in that sub-agent's session. Both then resume at the same time.
- **Mixed case** (one finished, one asking): the finished research is kept in its task record, and the Main Agent only deals with the question before continuing.

## Guarantees in `planTrip` (`travel_agent/mainAgent.ts`)

- **Before assembling:** it waits for any sub-agent still running. It never launches one.
- **`choose_transport`:** waits for running research before building its labels.
- **The budget re-check:** continues the place agent's session with `budget_feedback`. The Main Agent's LLM has already finished by then, so a question raised during a re-check is shown to the user, and the answer is sent back into the same session.
