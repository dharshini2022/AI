# Human-in-the-Loop (HITL) Middleware & Architecture

In the Agentic Trip Planner, **Human-in-the-Loop (HITL)** is the architectural bridge between autonomous AI decision-making and human oversight. There are two distinct mechanisms in play, chosen per tool based on what kind of human interaction that tool actually needs — not one uniform mechanism applied everywhere.

---

## 1. Two mechanisms, not one

**Plain synchronous `Hitl` calls** — a tool's own body calls a method on the `Hitl` channel (`travel_agent/hitl.ts`), which does real `readline`/stdin I/O and blocks until the user answers. No pausing of the LangGraph run is involved; the tool simply hasn't returned yet.

**LangGraph's interrupt/resume protocol**, via `humanInTheLoopMiddleware` — the middleware intercepts a proposed tool call *before it executes*, calls LangGraph's `interrupt(...)`, and the entire graph run pauses. The tool's own body never runs during this pause. Resuming requires the caller to invoke the graph again with `new Command({ resume })`, carrying an approve/edit/reject decision. This is built for pausing across a process/actor boundary (e.g. a different reviewer, possibly much later) — the decision vocabulary is specifically "should this one proposed action run, as-is or edited, or not at all?"

### Why the split

An earlier iteration of this project put all four human-facing tools (`ask_user`, `choose_transport`, `set_indoor_mode`, `book_flight`) under `interruptOn`, but never implemented the resume half of the protocol (no code anywhere called `Command({resume})`). Every interrupt pausing forever, `Agent.send` had no way to answer it, and the Main Agent looked like it had stopped extracting information from the user at all — every gated tool call just hung.

The fix wasn't to build resume plumbing for all four uniformly — it was to ask, per tool, *what kind of human interaction does this actually need?*

- **`ask_user`** — pure data collection ("what's the value of X?"). Used for iterative requirement gathering (STEP 1, one field at a time), relaying sub-agent doubts, asking for a raised budget figure, and the plan confirm prompt (STEP 4: an empty answer means approved — see [scratchpad.md](scratchpad.md)). There's no proposed *action* to approve; the answer *is* the payload. The interrupt protocol's approve/edit/reject vocabulary has no slot for "here's arbitrary data" (the closest fit, `reject` with a `message`, frames every normal answer as a tool *error*, which is a workaround, not a fit).
- **`choose_transport`** — picking one of several fare-only options. There's nothing to approve here: the user is the one choosing, directly, from a list; nobody else's decision needs review.
- **`set_indoor_mode`** — a single yes/no on one proposed action ("switch to indoor because of this forecast?"), with no data the tool needs to compute first. Genuine fit for `interruptOn`.
- **`propose_change`** — a place agent tool, gated by `interruptOn`, used to swap one place, restaurant or accommodation for a candidate it just researched (a budget re-check, or the user's own edit request). Unlike `choose_transport`, the *thing being reviewed* (a candidate from a search) genuinely doesn't exist until a tool has run — so this is exactly the "run the real tool first, then interrupt with the real result" case the `choose_transport` note above used to flag as a future custom-middleware change. It's solved differently here: the search tool (`places_search`/`restaurants_search`/`accommodation_search`) runs and writes to a **draft** (`Scratchpad.setStaging`/`stagedOutput`), not live, and `propose_change` — the tool that *is* gated — is a second, separate call the place agent makes once it has decided what to propose. Its `description` is a JSON-encoded summary built by code from the live item and the staged candidate (`travel_agent/tools/proposals.ts`'s `buildChangeSummary`), never from the model's own claim — data only, not display text; `Hitl` decides how to show it (see "The draft → propose → approve flow" below).
- **`book_transportation`** (then named `book_flight`) — was once registered here too, but is no longer an LLM tool. It was consequential and admin-gated with fixed arguments, yet the model decided *when* to call it, and the approval pause fired before the role check, so a non-admin was asked to approve something they could never do. Booking is now a code-triggered step after the plan is confirmed (`offerBooking` in `mainAgent.ts`): code checks the role, shows the booking box, and asks a plain yes/no through `Hitl.askYesNo`. See [rbac.md](rbac.md).

So `ask_user` and `choose_transport` stay plain, ungated `Hitl` calls, and the booking yes/no is a code-triggered `Hitl.askYesNo`. `set_indoor_mode` and `propose_change` are registered under `interruptOn`, and are the two tools where the interrupt/resume cycle is completed end-to-end — `set_indoor_mode` for the Main Agent, `propose_change` for place_agent (only place_agent gets it; every other sub-agent's tools are still resolved from its spec's plain MCP tool list, see `SpinUp.placeAgentExtras` in `spinUp.ts`).

One lever doesn't fit either mechanism: switching transport from the over-budget menu is a **code-driven** re-pick (the user picks from a list `Hitl.handleTransportChoice` shows, same as the initial `choose_transport`), not an LLM tool call — so `humanInTheLoopMiddleware` has nothing to intercept. `switchTransport` (`mainAgent.ts`) shows its own before/after box and asks a plain `Hitl.askYesNo`, reusing the same "try N of 3" shape as `propose_change` without going through the interrupt/resume protocol at all.

## The draft → propose → approve flow

`humanInTheLoopMiddleware` pauses a tool call **before** it runs — fine when the thing to approve is already
known (`set_indoor_mode`'s forecast), but a search result the user needs to see doesn't exist until *after*
a tool has run. `propose_change` splits the two:

```
 place_agent                      code                           user
 ───────────                      ────                           ────
 places_search / restaurants_     Scratchpad.setStaging(true):
 search / accommodation_search    the result goes to a DRAFT,
 ─────────────────────────────►   not the live scratchpad slot
                                   the rest of the app reads
 propose_change(kind, day,        Middleware pauses the run;
 replace, with) ──────────────►   builds a ChangeSummary (JSON)
 (often several calls in           from the live item + the
 one turn — a budget cut           staged candidate ─────────►   Hitl renders it: one table
 rarely touches just one item)                                   for a batch, then each item
                                                                   confirmed on its own compact
                                                                   line (see below) — never a
                                                                   raw dump of the interrupt
                                                                       │
                       ┌───────── approve ◄─────────────────────── yes/no, per item
                       │                                              │
              tool body merges                               reject: synthetic ToolMessage
              just the one approved                           back to place_agent — the tool
              item into the live                               body never runs; a rejection
              result (Scratchpad.publish                       counter and "don't propose
              + applyChange) — never the                       this candidate again" list
              rest of the re-searched list                     (ProposalTracker, tracked in
                                                                 Hitl since the tool body can't
                                                                 run here) drive the retry, up
                                                                 to 3 tries per item, then
                                                                 "limit_reached"
```

`recheckBudget`/`requestPlaceEdit` open staging before sending place_agent its turn and close it (discarding
any leftover draft) in a `finally`, so a rejected or abandoned proposal never leaks into the next read — see
`budget-recheck.md` and `concepts/architecture/scratchpad.md`.

**Why the description is data, not a formatted box.** `humanInTheLoopMiddleware`'s `description` callback
runs once per action and can only return a string — but when place_agent proposes several changes in one
turn (the common case for a budget cut), all of them arrive in `Hitl.reviewToolCalls` as one `HITLRequest`
with several `actionRequests`. Showing each as its own fully-formatted box would mean stacking several boxes
with no sense of the total picture — and the raw `HITLRequest`/`Interrupt` object, if ever printed directly,
looks exactly like debugging output, not something meant for a person to read. So `createProposeChangeMiddleware`
(`travel_agent/proposeChange.ts`) puts a `ChangeSummary` — plain data: kind, day, the two item names, their
costs, the saving, the attempt count, and whether the proposal is even valid — into `description` as JSON.
`Hitl.reviewToolCalls` parses every `propose_change` action's summary and, only for a batch of more than one,
prints `formatChangeTable` once up front (every row, a `⚠` marker for anything invalid, and a total possible
saving); it then confirms each item on its own `formatChangeLine` — a single line, not a box — asking
approve/reject one at a time exactly as before. A single proposal skips the table and goes straight to its
line. Both builders live in `travel_agent/tools/proposals.ts`, pure functions with no I/O, in the same spirit
as `formatWeatherBox`/`formatBookingBox` above.

```
 An agent proposes a tool call
              │
              ▼
        which tool?
     ┌────────┼─────────────────────────────┐
     │                                       │
 ask_user,                          set_indoor_mode (Main Agent)
 choose_transport                   propose_change (place_agent)
     │                                       │
     ▼                                       ▼
 Tool body calls Hitl            humanInTheLoopMiddleware: interrupt —
 directly (readline/stdin),      pauses the whole graph run, tool body
 blocks in place                 not yet run
     │                                       │
     │                           Agent.send catches __interrupt__
     │                                       │
     │                           Hitl.reviewToolCalls shows the
     │                           rendered description, collects
     │                           approve/reject
     │                                       │
     │                           graph.invoke(Command({resume: decisions}))
     │                            ┌──────────┴──────────┐
     │                        approve                 reject
     │                            │                      │
     │                    tool body finally      synthetic ToolMessage
     │                    runs for real          returned instead — tool
     │                            │              body never runs
     └──────────────┬─────────────┴──────────────────────┘
                     ▼
          Result flows back to the model
```

---

## 2. The resume loop (`travel_agent/agent.ts`)

`Agent.send()` is where the interrupt/resume cycle is actually closed. The Main Agent supplies a `resolveInterrupt` callback directly; place_agent gets one too, but only when it's launched with a `Hitl` available (`SpinUp.placeAgentExtras` in `spinUp.ts`) — every other sub-agent never registers `interruptOn`, so it never hits this path:

```typescript
async send(message: string, signal?: AbortSignal): Promise<Dict> {
  const config = { configurable: { thread_id: this.sessionId }, signal, recursionLimit: settings.llmRecursionLimit };
  let response: any = await this.graph.invoke({ messages: [{ role: "user", content: message }] }, config);
  while (response.__interrupt__?.length) {
    if (!this.resolveInterrupt) throw new Error(`Unhandled interrupt on session '${this.sessionId}'`);
    const resume = await this.resolveInterrupt(response.__interrupt__[0].value as HITLRequest);
    response = await this.graph.invoke(new Command({ resume }), config);
  }
  const text = lastMessageText(response);
  // ...parse JSON, fall back to { notes: text }
}
```

Looping (rather than resuming once) matters because resuming can itself land on another interrupt within the same turn. This confines all the new complexity to `Agent` — `MainAgentSession` and everything in `planTrip` (including the requirements-gathering and STEP-2-completion guardrails) still just call `session.send()` and get back a final `Dict`, unaware that a pause/resume cycle happened underneath.

`Hitl.reviewToolCalls` (`travel_agent/hitl.ts`) is what `resolveInterrupt` delegates to — it renders each paused action's `description` (built from pure string builders with no I/O baked in: `formatWeatherBox` for `set_indoor_mode`, `formatChangeBox` in `tools/proposals.ts` for `propose_change`; `formatBookingBox` is the same kind of builder, printed directly by `offerBooking`) and collects an approve/reject decision per action, serialized through the same FIFO queue every other `Hitl` prompt uses. For `propose_change` specifically, a rejection also updates the `ProposalTracker` (`hitl.proposals`) and turns into a message telling place_agent whether to try a different candidate or stop — see "The draft → propose → approve flow" above for why that bookkeeping has to live here rather than in the tool body.

---

## 3. Interaction Model & Policy Matrix

| Tool | Mechanism | Allowed Decisions | Why |
|---|---|---|---|
| `ask_user` | Plain `Hitl.handleSubagentClarification` (readline) | n/a | Free-text data collection — no action to approve |
| `choose_transport` | Plain `Hitl.handleTransportChoice` (readline) | n/a | The user is choosing directly from a list; nobody else's decision needs review |
| `set_indoor_mode` | `humanInTheLoopMiddleware` interrupt/resume | `["approve", "reject"]` | Single yes/no on one proposed action, no precomputed data needed |
| `propose_change` (place_agent only) | `humanInTheLoopMiddleware` interrupt/resume | `["approve", "reject"]` | One specific swap, from a draft the search just produced — see the flow above |
| "Switch transport" (over-budget menu lever, not a tool) | Code-driven re-pick + `Hitl.askYesNo` | n/a | The pick itself is the user choosing from a list, same as `choose_transport`; there's no LLM tool call for the middleware to gate |
| booking (`offerBooking`, not a tool) | Code-triggered `Hitl.askYesNo` after the plan | n/a | Fixed action with known arguments; role check must decide what to show, so it lives in code |

For `set_indoor_mode` and `propose_change`, the tool body itself only runs *after* approval — neither does its own prompting. `setIndoorMode`'s body just reports the outcome (`{ approved: true, indoor_mode: enabled ?? true }`); `propose_change`'s body commits the draft to live (`Scratchpad.commitStaged`).

RBAC (see [rbac.md](rbac.md)) is a separate control from approval: it restricts *who* may book at all, while the yes/no governs *whether that specific booking proceeds*.

---

## 4. Rich Weather Forecast UI Display

`formatWeatherBox` (a pure function, no I/O) builds the same rendered forecast card as before, now used as the interrupt's `description` so it's shown to the user before they decide:

```
┌ Weather Forecast Notice ──────────────────────────────────────────
│ Destination : Munnar
│ Summary     : 2 of 3 days with high rain probability
├ Daily Breakdown:
│   • 2026-10-02 : Moderate rain · 15.0°C – 22.0°C · 65% rain [⚠️ BAD WEATHER]
│   • 2026-10-03 : Heavy rain    · 14.0°C – 21.0°C · 80% rain [⚠️ BAD WEATHER]
│   • 2026-10-04 : Partly cloudy · 17.0°C – 24.0°C · 10% rain
└───────────────────────────────────────────────────────────────────

Approve set_indoor_mode? (yes/no)
>
```

---

## 5. Serialized I/O & Parallel Safety (`travel_agent/hitl.ts`)

When sub-agents or tool calls run concurrently, uncoordinated terminal prompts would garble stdout and stdin. The `Hitl` class ensures strict FIFO serialization via `queue` — this applies equally to plain prompts (`ask_user`, `choose_transport`) and to `reviewToolCalls`:

```typescript
export class Hitl {
  private queue: Promise<unknown> = Promise.resolve();

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn);
    this.queue = run.catch(() => undefined);
    return run;
  }
}
```

---

## 6. Automated Test Support

For unit and integration testing without interactive humans, `Hitl` accepts a scripted list of answers — this covers both plain prompts and `reviewToolCalls`' approve/reject questions, since both read through the same `input()` method:

```typescript
const hitl = new Hitl(["yes", "1"]); // answers a yes/no gate with 'yes', a choice list with '1'
const result = await planTrip("Plan 3 days in Munnar for 2", { hitl });
```
