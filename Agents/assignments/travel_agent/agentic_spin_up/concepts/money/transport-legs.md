# Transport legs: choosing the way there and the way back

A trip is there and back. The planner shows both legs and lets the user pick each one. The trip total is the
outbound fare plus the chosen return fare.

## What the user sees

1. **Outbound prompt.** Each option shows only its fare, mode, provider and travel time — no trip total. A
   per-option total was dropped (see "Why the per-option total is gone" below); the trip total only exists
   once, after the pick, when the whole plan is assembled.
2. **Return prompt.** Lists the return options (destination → source, on the last day of the trip), the same
   fare-only way.
3. **The plan** prints `Outbound` and `Return … on <date>` lines, with the trip total shown once for the
   whole assembled plan. The admin booking box shows both legs.

Fares come from a route table or a distance formula. They do not depend on direction or date, so return prices
mirror the outbound ones for now. The return leg still gives a separate choice per leg (flight out, train back),
return-dated booking links, and a correct total when the two legs differ. Real return fares would need the
fare API that is not implemented yet.

```
 transport_search(source, destination, start_date, travellers, num_days)
        │
        ├──► outbound options
        └──► return options (destination → source, last day of the trip)
                │
   prompt 1: choose outbound            prompt 2: choose return
   (fare, mode, provider, time)   ──►   (fare, mode, provider, time)
                                                │
                                                ▼
                              plan shows Outbound and Return lines
                                                │
                              buildPlan's one assemble() computes the trip total
                                                │
                              booking box (admin) shows both legs
```

### Why the per-option total is gone

Every option's label used to include "trip total ≈ ₹X (within/over budget)" — which meant computing a full
`{itinerary, budget}` for every researched option, just to print one line each, before the user had even
picked. That's why the log used to show `merge_plan`/`budget_check` running once per option instead of once
for the whole transport-pick step. `optionLabel` now takes only the option itself; `computeLegs` is a plain
synchronous map with no MCP calls; and the one `assemble()` call for whichever pair the user picked happens
later, inside `buildPlan` (see `budget-recheck.md`).

## How it works

- **One search call covers both legs.** `transport_search` takes `num_days`. When it is given, the result also has
  `return_options`, `return_route` and `return_date`. The scratchpad keeps one record per tool name, so a second
  call for the reverse route would overwrite the outbound result. The transportation agent still decides to
  search; the tool adds the reverse leg.
- **`num_days` is pinned.** The scratchpad guard (`PINNED` in `scratchpad.ts`) fills it from the saved
  requirements. The date and route are not pinned: a new date or route is the user's own request.
- **Return date** is `start_date + (num_days − 1)` days, the last day of the trip. It matches the budget's
  `nights = num_days − 1`. Code computes it with `addDays`, not the LLM.
- **Budget.** `budget_check` sums `itinerary.transport` and `itinerary.return_transport`. Without a return leg it
  counts the outbound fare `TRIP_LEGS` (2) times, as before. `EstimatedParts.transport` is an amount, because
  only one leg may be a guess (see `price-estimates.md`).
- **Prompts.** `askTransport` in `mainAgent.ts` asks outbound, then return. `choose_transport` and the
  over-budget menu's "Switch to a cheaper transport" lever both use it (the latter through `switchTransport`,
  which adds its own before/after approval box — see `budget-recheck.md`). The pick is recorded in
  `TripPlanState`, so a later rebuild after a plan edit keeps it.

## Limits

- Return date is fixed at the last day of the trip. To change it, use "change transportation".
- Not changed: the fare model, the search providers, and how options are sorted.
