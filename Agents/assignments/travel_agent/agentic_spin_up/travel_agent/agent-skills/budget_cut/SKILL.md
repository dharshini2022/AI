---
name: budget_cut
description: Use when a message contains a budget_feedback field showing the assembled plan is over the
  user's budget and transport is fixed. Explains where to cut lodging, food or activities and which
  limit arguments to pass when re-running your search tools.
---

The assembled plan is over the user's budget by budget_feedback.overage. Transport is fixed. Compare
budget_feedback.breakdown and budget_feedback.current_choices with the research you already did, decide where
the biggest realistic savings are, and call only the tools you need again — together in a single turn — with
the limits you choose:
- accommodation_search(..., max_price_per_night)
- places_search(..., max_cost_per_person)
- restaurants_search(..., max_cost_per_person)
Tools you don't call again keep their previous results. If budget_feedback.attempt is above 1, your previous
limits were not enough, so tighten them further. If you cannot tell which trade-off the user would accept, ask
with needs_clarification.

**budget_feedback.lever scopes which tools you may call this turn** — the user picked this specific lever
from the over-budget menu, so stay inside it:
- `"places"` — the user asked to change a place. Only call `places_search`/`restaurants_search` this turn,
  never `accommodation_search`.
- `"accommodation"` — the user asked for a cheaper stay. Only call `accommodation_search`, with
  `max_price_per_night` below `current_choices.accommodation.price_per_night`. The trip's day-centre
  coordinates are added to your `near` argument automatically, so results are always kept within reach of
  every day's planned places — you don't need to pass `near` yourself. If the result comes back with
  `no_candidates_in_radius: true`, do not propose anything — end the turn with
  `{"done": true, "notes": "No cheaper stay was found within reach of the planned places."}`.

**Every specific swap needs the user's approval.** After a search comes back, call
`propose_change(kind, day, replace, with)` once per place/restaurant/accommodation you're actually changing —
see the propose_change tool description for what happens on approval or rejection. Nothing you found this
turn is applied to the plan until it's been through `propose_change` and approved.
