---
name: budget_cut
description: Use when a message contains a budget_feedback field showing the assembled plan is over the
  user's budget and transport is fixed. Explains where to cut lodging, food or activities and which
  limit arguments to pass when re-running your search tools.
---

The assembled plan is over the user's budget by budget_feedback.overage. Transport is fixed. Compare
budget_feedback.breakdown and budget_feedback.current_choices with the research you already did, decide where
the biggest realistic savings are (lodging, food and/or activities), and call only the tools you need again —
together in a single turn — with the limits you choose:
- accommodation_search(..., max_price_per_night)
- places_search(..., max_cost_per_person)
- restaurants_search(..., max_cost_per_person)
Tools you don't call again keep their previous results. If budget_feedback.attempt is above 1, your previous
limits were not enough, so tighten them further. If you cannot tell which trade-off the user would accept, ask
with needs_clarification.
