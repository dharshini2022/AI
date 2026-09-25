# Weather Gate

The place agent checks the forecast **before** it searches for attractions, and raises the
indoor question itself instead of leaving it to the Main Agent afterwards.

## Why it moved

`indoor_mode` used to have no effect on research. It travelled from the Main Agent's STEP 5
JSON into `placesResult` (`mainAgent.ts:166`) and then into the itinerary dict
(`itinerary.ts:237`) — and stopped there. Nothing re-ran `places_search`, and no
`send_message_to_subagent` ever carried the answer back to the place agent.

So answering *"yes, switch to indoor"* returned the **identical outdoor itinerary**. The only
observable effect was `weather_declined` going false, which hid the warning line at
`itinerary.ts:353`. The user was told they had an indoor plan and did not have one.

Asking after the research was complete was the root of it: by the time the Main Agent knew the
answer, the attractions had already been fetched, and nothing in the pipeline was willing to
fetch them again.

## The two-phase contract

The place agent's spec (`agent_specs/place_agent.md`) now defines two steps:

1. **`weather_search` alone.** If the result has `bad_weather: true`, the agent calls no other
   tool and ends its turn with
   `{"done": false, "needs_clarification": "The forecast is poor … switch to indoor activities?"}`.
   If the forecast is fine it carries straight on to step 2 in the same turn.
2. **`places_search` + `restaurants_search` + `accommodation_search` together**, with
   `indoor_only` set from the Main Agent's answer.

The Main Agent's STEP 2 recognises that particular question, answers it with `ask_yes_no`
rather than `ask_user`, relays it with `send_message_to_subagent`, and `set_indoor_mode` records the answer as
`preferences.indoorMode` in the scratchpad (`concepts/architecture/scratchpad.md`). The old STEP 4 was deleted — left in place it would
have asked the user a second time, after the transport choice.

## Why no new machinery was needed

This reuses the sub-agent lifecycle exactly as it already worked (see
`concepts/architecture/subagent-lifecycle.md`, Use case 1): a sub-agent ends a turn with
`needs_clarification`, the Main Agent sees it through `wait_for_subagents`, and
`send_message_to_subagent` resumes the same session with its memory intact via the shared
`MemorySaver`. `places_search` already accepted `indoor_only` (`mcp_server/handlers.ts:52`).

The whole behaviour change therefore lives in two prompt texts. No function, code path or tool
signature changed.

## Side benefit: the question fills dead time

`transport_search` scrapes for 15–20 s while `weather_search` returns in 1–2 s. Asking the
indoor question at ~T=2 s puts it inside that window, instead of at ~T=25 s after the transport
choice. This is a genuine improvement but it is **not** the reason for the change — correctness is.

Note the related idea that was rejected: pipelining a partial plan while transport is still
running. `assemble()` is `merge_plan` + `budget_check`, both transport-dependent (the total
includes the fare) and both local MCP calls costing milliseconds — `computeTransportOptions` already
runs a full `assemble()` once per transport option without anyone noticing. There is no compute
worth pipelining into that window; only user interaction fits there.

## Cost: a clarification slot

`SUBAGENT_MAX_CLARIFICATIONS` caps how many times one task may reply `needs_clarification`
before `runTurn` fails it (`spinUp.ts:261`); the counter is per-task and never resets. The
weather question now permanently consumes one slot on every bad-weather trip, so the default was
raised from 2 to 3 (`config.ts:51`, `.env.example:19`). Without that, a trip which is both rainy
and over budget would have a single question left, and a second one during the budget re-check
would mark the place agent `failed` and degrade the negotiation at `mainAgent.ts:311-314`.

## What cannot be tested

The phasing lives in a prompt, so no unit test can verify it. The place-agent stubs in
`tests/smoke.test.ts` and `tests/budgetRecheck.test.ts` stand in for the LLM by invoking all
four tools at once, and stay green either way. The real check is a live run against a rainy
destination where a "yes" answer yields materially different attractions from a "no".

## Known adjacent gap

`maps.ts:340` stamps `indoor: indoorOnly` on every attraction, so an `indoor_only=false` search
returns zero places flagged `indoor` — which makes the rainy-day indoor front-loading at
`itinerary.ts:84-88` inert on the outdoor path. Fixing that touches tool output and would move
`tests/fixtures/parity.json`, so it was left out of this change.
