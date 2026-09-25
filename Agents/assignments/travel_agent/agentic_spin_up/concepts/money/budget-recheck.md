# Budget Re-check and Latency

The planner keeps its LLM sub-agents (`transportation_agent`, `place_agent`) deciding what to call and with which arguments. Code adds guarantees around them, but never launches tools on an agent's behalf.

## Post-plan revision (STEP 4)

Once transport is chosen, the Main Agent calls the `present_plan` tool (`travel_agent/mainAgent.ts`). It assembles the plan via `buildPlan` — one `assemble()` call, always fresh; there is nothing left to cache once transport options no longer carry a precomputed itinerary (see "Transport is picked before any assembly happens" below) — and **shows it to the user immediately**. If that first plan is over budget, `presentPlan` shows it and then runs the over-budget menu on its own, before anything else happens; there is no automatic cut first. The Main Agent then asks one open-ended question through `ask_user`:

> "Press Enter to confirm. Or ask a question, request a change to the plan, or ask to recheck the budget:"

An empty answer confirms the plan and ends the loop. For any other text the Main Agent itself decides what the user wants — a budget request, an edit, or just a question — because that is a judgment call, consistent with keeping LLM agents deciding and code limited to triggers/guardrails. It then calls its own tools:

| The user wants | What the Main Agent does |
|---|---|
| To recheck the budget | `present_plan({ recheck_budget: true })`, which runs the over-budget menu described below, then shows the updated plan. |
| A change to places, food or stays | `request_place_edit`, which sends the change to the place agent's own session and waits. As with a budget re-check, nothing the place agent finds is applied until the user approves it — see "Every change is proposed, never applied silently" below. |
| An answer to a question | Puts the answer at the start of its next `ask_user` question, followed by the confirm text. |

`present_plan` stops offering revisions after `MAX_PLAN_REVISION_TURNS` (5) by returning `limit_reached`. See `concepts/architecture/scratchpad.md` for how the facts and results are shared.

## The over-budget menu

The menu shows itself — on the first over-budget plan, and again whenever `present_plan({ recheck_budget: true })` is called — and offers exactly one lever at a time, never a silent automatic cut:

```
 present_plan → buildPlan (assemble once) → showPlan
                                                │
                                        over budget? ──no──► ask_user "confirm?"
                                                │yes
                              ┌──── 4-way menu (a while loop, not recursion) ◄────────────┐
                              │  0  Change a place        → recheckBudget(lever:"places") │
                              │  1  Switch transport       → switchTransport (its own      │
                              │                               before/after + yes/no, up to │
                              │                               3 tries — no LLM tool call   │
                              │                               here for the middleware to   │
                              │                               gate)                        │
                              │  2  Switch accommodation   → recheckBudget(lever:"accomm.")│
                              │  3  Proceed anyway          → return the plan as-is         │
                              └────────────────┬───────────────────────────────────────────┘
                                                ▼ (a lever that saved nothing is dropped from
                                          still over budget?      the menu; the loop ends once
                                                │yes, levers left   only "Proceed" remains, or
                                                └──────────────►    the plan fits)
```

`resolveOverBudget` (`travel_agent/mainAgent.ts`) owns this loop. Bounding it by dropping a lever, rather than by a fixed visit count, is what keeps it from looping forever on a genuinely unaffordable trip while still letting the user try every lever once.

| Who | Decides | How |
|---|---|---|
| **Code** | *Which* lever is offered, and *when* to stop offering it | The menu; a lever that produced no approved saving this round is removed. |
| **Code** | *When* to re-check within one lever pick | `recheckBudget`'s own loop: while `budget_status.ok` is false and fewer than `BUDGET_RETRY_LIMIT` (default 2) attempts have run for `"places"`/`"accommodation"`. It stops early when an attempt doesn't lower the total. |
| **Place agent (LLM)** | *How* to cut, within the picked lever | It receives `budget_feedback` (cap, total, overage, breakdown, current choices, and the picked `lever`) as a new message in **its own session**, so it remembers its earlier research. It searches within that lever only, then proposes each specific swap — see below — rather than committing it directly. |

- **Why limits are needed:** the search tools are deterministic, so a re-check must pass new limits, or it would return the same plan.
- **Tools not re-called:** the scratchpad keeps each tool's latest raw result, so any tool the agent doesn't call again keeps its earlier result.
- **"Switch accommodation" stays within reach of the plan:** the lever passes the trip's day-centre coordinates (`budget_feedback.day_centers`) through to `accommodation_search`'s `near` argument, which keeps only stays within `FAR_FROM_STAY_KM` of every one. See `concepts/features/human-in-the-loop.md`.

## Every change is proposed, never applied silently

A budget re-check (or a user's own edit via `request_place_edit`) no longer changes the live plan the moment the place agent searches. Two things had to change together to make that safe and interruptible:

1. **A draft, not a live write.** While a change is in progress, `Scratchpad.setStaging(true)` redirects `places_search`/`restaurants_search`/`accommodation_search` results to a draft instead of the live scratchpad slot the rest of the app reads from (`Scratchpad.stagedOutput`/`commitStaged`/`discardStaged`). Closing staging without a commit — a rejected proposal, an abandoned edit, a crash mid-turn — discards the draft, so a search that never got the user's yes never reaches the plan. This is also what fixed the older bug where a re-search that came back worse silently became the new live result.
2. **An approval per swap.** The place agent calls `propose_change(kind, day, replace, with)` once for each specific place/restaurant/accommodation it wants to swap. This is the one place agent tool gated by `humanInTheLoopMiddleware` (see `concepts/features/human-in-the-loop.md` for why the search itself can't be gated the same way, and for the full approve/reject/retry mechanics, including the "3 nos" limit).

## Avoiding a redundant budget_check for the chosen transport

`merge_plan` and `budget_check` are deterministic, non-LLM MCP calls (`mcp_server/handlers.ts`) — plain arithmetic over already-fetched data. `choose_transport` no longer computes a full `{itinerary, budget}` per researched option just to label it with a trip total (see `transport-legs.md` for why that per-option assembly was removed); it only records which option the user picked. `buildPlan` is the one place that calls `assemble()`, once, whichever way the plan got there — a fresh presentation, a transport switch, or a budget re-check — so there's nothing left to cache against.

## Latency changes

- **Recorded tool results:** `McpTools.langchainTools` hands every raw tool result to `SpinUp`, so sub-agents reply only `{"done": true, "notes": ...}` instead of re-typing thousands of tokens. The Main Agent gets a compact summary.
- **Concurrent requests inside tools:** `searchPlaces`, `searchRestaurants`, the accommodation detail lookups, and `searchTransport`'s geocodes run together. All place and restaurant searches go through the provider chain in `tools/providers/`, which limits concurrency (`SEARCH_CONCURRENCY`) and caches answers on disk (`SEARCH_CACHE_TTL_MS`); see `search-providers.md`. `Promise.all` keeps result order, so ranking and dedupe are unchanged.
- **Batched tool calls:** `parallel_tool_calls` is requested from the model, and the specs ask for all tools in one turn. LangChain then runs a turn's tool calls together. This is still the model's choice.
- **Bounded slow calls:**
  - retries happen only on network errors, timeouts, rate limits (429) and 5xx; an out-of-quota or refused-key reply is not retried
  - search calls (SerpAPI and Serper) use `SEARCH_TIMEOUT_MS`
  - each tool stops waiting after `TOOL_DEADLINE_MS` and returns what it has
- **Geocoding:** concurrent lookups for the same city share one request.
- **Measuring:** `TRIP_TIMING=1` prints per-LLM-call (including how many tool calls the model batched), per-MCP-tool and per-HTTP timings to stderr.
