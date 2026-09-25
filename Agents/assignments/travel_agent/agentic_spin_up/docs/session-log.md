# Session Log

A short entry per session, added at the end of the session or working day.

Format per entry:
```
## <date>
What we did: <1-3 lines>
Unfinished: <if anything>
Next step: <what to pick up next session>
```

---

## 2026-09-25
What we did: Reworked the transport pick and over-budget flow end to end. `choose_transport` now shows
fare/time only (no per-option budget math), and the plan is assembled once, in `buildPlan`. The over-budget
menu now shows itself on the first over-budget plan (no automatic cut first), offers change-a-place /
switch-transport / switch-accommodation / proceed, and drops a lever that saved nothing so repeat visits stay
bounded. Every specific place/restaurant/accommodation swap — from a budget re-check or the user's own edit —
now goes through a new draft → `propose_change` → approve flow: search results are staged
(`Scratchpad.setStaging`), and only an approved `propose_change` call (gated by `humanInTheLoopMiddleware`,
now wired for place_agent too) merges one named item into the live plan, with up to 3 tries and a rejected
candidate never re-proposed. "Cheaper stay" is code-restricted to within `FAR_FROM_STAY_KM` of every day's
places. Ran a code review after the first pass, which caught a real bug (approving one item was publishing
the whole re-searched list) plus a few smaller issues; all were fixed and re-verified.
Unfinished: nothing for this feature. Two known, accepted gaps: two place_agent edit sessions can't safely
overlap (staging is a single on/off flag, not a counter), and re-researching a new transport date/route when
every option is over budget has no lever any more (see `BACKLOG.md`).
Next step: none queued. `npx tsc --noEmit` and `npx vitest run` both pass (284/284).
