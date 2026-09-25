# Budget Re-check and Latency

The planner keeps its LLM sub-agents (`transportation_agent`, `place_agent`) deciding what to call and with which arguments. Code adds guarantees around them, but never launches tools on an agent's behalf.

## Post-plan revision (STEP 4)

Once transport is chosen, the Main Agent calls the `present_plan` tool (`travel_agent/mainAgent.ts`). It assembles the plan via `buildPlan` and **shows it to the user immediately**, over budget or not. Nothing is ever auto-trimmed or re-spun-up silently. The Main Agent then asks one open-ended question through `ask_user`:

> "Press Enter to confirm. Or ask a question, request a change to the plan, or ask to recheck the budget:"

An empty answer confirms the plan and ends the loop. For any other text the Main Agent itself decides what the user wants — a budget request, an edit, or just a question — because that is a judgment call, consistent with keeping LLM agents deciding and code limited to triggers/guardrails. It then calls its own tools:

| The user wants | What the Main Agent does |
|---|---|
| To recheck the budget | `present_plan({ recheck_budget: true })`, which runs the `recheckBudget`/`resolveOverBudget` cycle described below, then shows the updated plan. |
| A change to places, food or stays | `update_preferences` if they say what they do not want, then `send_message_to_subagent` to the place agent's own session, `wait_for_subagents`, and `present_plan` again. New research invalidates the cached transport-total (see below), so the plan is rebuilt. |
| An answer to a question | Puts the answer at the start of its next `ask_user` question, followed by the confirm text. |

`present_plan` stops offering revisions after `MAX_PLAN_REVISION_TURNS` (5) by returning `limit_reached`. See `concepts/architecture/scratchpad.md` for how the facts and results are shared.

## Budget re-check mechanics

Once a re-check is requested (by the user, via the loop above — never automatic), the responsibilities split like this:

| Who | Decides | How |
|---|---|---|
| **Code** | *When* to re-check | A plain loop: while `budget_status.ok` is false and fewer than `BUDGET_RETRY_LIMIT` (default 2) attempts have run. It stops early when an attempt doesn't lower the total. |
| **Place agent (LLM)** | *How* to cut | It receives `budget_feedback` (cap, total, overage, breakdown, current choices) as a new message in **its own session**, so it remembers its earlier research. It picks limits and re-calls only the tools it wants with `max_price_per_night` / `max_cost_per_person`. If it asks a question, the user answers it (see `concepts/architecture/subagent-lifecycle.md`). |

**How a re-check runs:**
- **Why limits are needed:** the search tools are deterministic, so a re-check must pass new limits, or it would return the same plan.
- **Tools not re-called:** the scratchpad keeps each tool's latest raw result, so any tool the agent doesn't call again keeps its earlier result.
- **Still over budget:** the user chooses to keep the plan, switch to a cheaper transport (outbound, then return, each option shown with its trip total; see `transport-legs.md`), or raise the budget. After a raise, one more re-check runs if needed.

## Avoiding a redundant budget_check for the chosen transport

`merge_plan` and `budget_check` are deterministic, non-LLM MCP calls (`mcp_server/handlers.ts`) — plain arithmetic over already-fetched data, so calling them costs no API tokens either way. But `choose_transport` already computes a full `{itinerary, budget}` for *every* researched option, just to label each one with a trip total for the user to compare — recomputing it again for the one the user actually picks would be doing identical deterministic work twice.

`choose_transport` now caches the picked option's assembled result (on the shared `PlanState`; the indoor setting it used is `preferences.indoorMode` in the scratchpad, set by `set_indoor_mode` once approved, not guessed) and `buildPlan` reuses it directly when it's still valid — same budget cap and traveller count as the final requirements, and no new research recorded in the scratchpad since (its `version` is stored with the cache). This only became safe to cache once the preview started using the real resolved `indoor_mode` instead of always assuming outdoor activities; caching a preview computed under the wrong indoor assumption would have quietly shown the wrong total. If the cache doesn't apply (e.g. `choose_transport` was never called), `buildPlan` falls back to computing it fresh, exactly as before.

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
