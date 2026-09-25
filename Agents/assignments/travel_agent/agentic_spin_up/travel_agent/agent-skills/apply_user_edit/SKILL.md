---
name: apply_user_edit
description: Use when a message arrives after the plan has already been presented and contains a plain
  description field with no budget_feedback — the user asking for an addition, removal, replacement or
  modification to places, restaurants or accommodation (e.g. "no temples", "swap the museum", "change
  the hotel"). Identify which of your own tools the change affects, call only those, and reply once the
  new results are in. Never regenerate the whole plan or re-run a tool the change doesn't touch.
---

# Apply User Edit

This skill handles changes requested by the user after the full travel plan has been presented.

The destination, dates, travellers and every other requirement not mentioned by the change stay exactly as
they were.

**Out of scope: transport.** You have no transport tool, and no way to reach the transportation agent — only
the Main Agent can do that, through its own change-transportation flow. If a message is only about transport
("find a different way to travel," "I'd rather fly"), that's not yours to handle: reply with
`needs_clarification` so the Main Agent routes it correctly, rather than guessing at it here.

## When to use

Use this skill for a change to any of your three domain tools:

- **Places / activities** (`places_search`) — "Remove the temples," "Add more nature spots," "Remove the
  museum and add a beach instead."
- **Restaurants** (`restaurants_search`) — "Replace this restaurant with a cheaper one," "No seafood."
- **Accommodation** (`accommodation_search`) — "Change the hotel," "Find something closer to the centre."

If the change touches more than one of these — for example "swap the restaurant and find a cheaper hotel" —
handle both in the same turn.

## Step 1: Identify which tools the change affects

Decide, from the wording, which of your three tools need to run again. Never run a tool the change doesn't
touch:

- A places-only change (e.g. "no temples") → `places_search` only.
- A restaurants-only change → `restaurants_search` only.
- An accommodation-only change (e.g. "change the hotel") → `accommodation_search` only.
- A change naming two areas → both of the matching tools, together in this turn.
- **Never re-run `weather_search`** — the forecast doesn't change because the user edited the plan.

## Step 2: Call only the tools you identified

Call each affected tool once, with the arguments from Steps 3–4 below. Tools you don't call keep whatever
result they already have — you are not regenerating the plan, only the part that changed.

## Step 3: Preserve existing constraints

Whatever the user didn't ask to change stays as it was:

- An earlier exclusion (e.g. "no temples," said two turns ago) stays active unless the user is now explicitly
  taking it back.
- Any `max_price_per_night` / `max_cost_per_person` limit from an earlier budget re-check stays, unless this
  message is itself about the budget.
- A change to one tool should not alter the arguments you'd use for another: replacing a restaurant does not
  need a new accommodation search.

## Step 4: Handle additions, removals and replacements correctly

### Remove
Put what to leave out in that tool's `exclude` argument — for example `exclude: ["temples"]`. Never put a
removal into `interests`: interests are searched *for*, so "no temples" in interests would return more
temples, not fewer.

> "No temples." → `places_search(..., exclude: ["temples"])`

### Add
Put what to look for more of into `interests` (for `places_search`/`restaurants_search`) or as the relevant
limit/preference for `accommodation_search`.

> "Add more nature spots." → `places_search(..., interests: [...existing, "nature"])`

### Replace
Do both halves in the same call: exclude the old thing, and add the new preference.

> "Swap the museum for an outdoor activity." → `places_search(..., exclude: ["museum"], interests: [...existing, "outdoor"])`

> "Change the hotel." → call `accommodation_search` again; if the user said what they want instead (cheaper,
> closer to the centre), pass that as the relevant limit.

## Step 5: Clarification

If you can't tell which tool the change affects, or what it means for that tool's arguments, do not guess.
End the turn with `needs_clarification` so the Main Agent can ask the user.

## Completion

Once every tool you called has a fresh result, reply:

```json
{"done": true}
```

Do not mention the full plan or unrelated tools' results — the Main Agent assembles the final itinerary from
what's recorded; your reply only needs to say you're done.
