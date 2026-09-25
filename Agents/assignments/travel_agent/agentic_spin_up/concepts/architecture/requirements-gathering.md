# Requirements Gathering: One-LLM-Call Slot-Filling

Collecting the 7 trip requirements (source, destination, start_date, num_days, num_travellers, budget, interests)
plus one preference (exclude — what the user does NOT want) from the user's free-text request takes exactly one
LLM call and a code-driven slot-filling loop.

## The problem it solves

**Before code-driven slot-filling existed at all:** Gathering N missing fields cost N+2 real LLM API calls. The
Main Agent's spec mandated the LLM drive a question loop via the `ask_user` tool, one field at a time —
`ask_user` → user answers → model called again → repeat. Each call re-processed the full system prompt,
conversation history, and earlier answers.

**A later version cut that to two LLM calls:** one to extract what was stated, one — after code collected the
rest — for the LLM to merge and save. That version had three problems, found when this design was reviewed:

- `interests`'s schema default (`.default([])`) still filled in `[]` when the LLM's extraction omitted the
  field, so the loop's "is this missing?" check saw a value that was never actually given and skipped asking.
- The same rule was true of `budget`: a genuinely-stated "no limit" (`null`) looked the same as "not stated",
  so it got asked again.
- The second LLM call did nothing but copy already-validated data into a tool call — real cost, no judgment.

**Now:** Exactly one LLM call, regardless of how many fields are missing. Code takes over the question loop,
asks about exclusions too (previously never asked, only ever picked up if the user happened to mention them
unprompted), and saves the result itself once every field is checked. The LLM's only two jobs are: extract
what it can from free text, and decide what the user meant when a check fails and it needs to be asked again
— both real judgment calls. Asking "How many days?" or copying an already-checked object into a tool call are
not.

## The idea, in plain words

Think of a form with 7 fields plus a line for "anything to avoid". The applicant (user) scribbles what they can
on the form in free text. A form processor (code) looks at it and marks which fields are still blank — a field
the applicant did fill in, even with "none" or "no limit", counts as answered. Code then hands the applicant a
printed questionnaire with templated questions for each blank field, checks each answer against the same rules
the form itself uses, and files the completed form once every field is checked. There's no separate reviewer
step — the processor's checks are the only sign-off the form needs.

## The flow

**The one LLM call — extract what is stated:**

```
User: "I'm going to Goa in October for a week with my family, no crowded markets"

LLM calls:
  extract_requirements({
    destination: "Goa",
    num_days: 7,
    start_date: "2025-10-01",   // inferred from "October"
    exclude: ["crowded markets"],
    // num_travellers, source, budget, interests: omitted — not stated, so left out entirely
  })
```

**Code-driven slot-filling (no LLM) for everything extraction left out:**

```
Required, in order (skip if already given):
  Question:  "Where are you travelling from?"
  User:      "Mumbai"
  Check:     ✓ (schema: non-empty string)
  Save:      source = "Mumbai"

  Question:  "How many travellers?"
  User:      "4"
  Check:     ✓ (schema: integer >= 1)
  Save:      num_travellers = 4

Optional, in order (skip if already given — including an explicit null or []):
  Question:  "What's your budget in INR? (press Enter for no limit)"
  User:      "" (Enter)
  Save:      budget = null

  Question:  "Anything you'd like to avoid ...? (press Enter to skip)"
  — skipped here: exclude was already given as ["crowded markets"]
```

A field that fails its check is asked again, up to 3 times, with the schema's own error message prefixed to the
question:

```
  Question:  "What date does the trip start? (YYYY-MM-DD)"
  User:      "10-01"
  Check:     ✗ start_date must be a valid date in YYYY-MM-DD format and cannot be in the past.
  Re-ask:    "start_date must be ... What date does the trip start? (YYYY-MM-DD)"
  User:      "2025-10-01"
  Check:     ✓
  Save:      start_date = "2025-10-01"
```

On the 3rd failure: a required field cancels the whole trip request; an optional field is just left unset.

**Code saves — no LLM call needed:**

Every field now in hand was already checked, either by the extraction schema or by the per-field check above,
so there is nothing left for an LLM to decide by copying it into a tool call. Code saves the trip requirements
and the exclusions itself, then tells the Main Agent's session it can move on:

```
Code:
  scratchpad.setRequirements({ destination: "Goa", num_days: 7, start_date: "2025-10-01",
                                source: "Mumbai", num_travellers: 4, budget: null, interests: [] })
  scratchpad.addExclusions(["crowded markets"])

Code sends to the Main Agent:
  "Requirements saved: {...}. Excluded: [\"crowded markets\"]. Continue with STEP 2."
```

## Flow diagram (ASCII)

```
  User's request (free text)
       |
       v
  +----------+
  |   LLM    |   extract_requirements: every field
  | extracts |   it can determine, omitting the rest
  +----------+   (a genuinely-given null/[] still counts)
       |
       v
  +----------+
  |   Code   |   Loop: for each field extraction left out
  | asks &   |     - required fields first, then budget,
  | checks   |       interests, exclude
  |          |     - fixed template question
  |          |     - check with the field's own schema rule
  |          |     - retry up to 3 times, prefixing the error
  +----------+
       |
       v
  +----------+
  |   Code   |   scratchpad.setRequirements(...)
  | saves    |   scratchpad.addExclusions(...)
  +----------+
       |
       +---------> "Requirements saved: {...}. Continue with STEP 2." message
       |
       v
  Main Agent resumes at STEP 2 (research)
```

## Who decides what

| Decision | LLM or Code | Why |
|----------|-----------|-----|
| Extract fields from free text, including exclusions | LLM | The user may phrase things in many ways; parsing is judgment. |
| Which fields are still missing | Code | Deterministic: a field absent from `extract_requirements`'s output is missing; a field present with any value (including `null` or `[]`) is not. |
| Question text for each field | Code | "How many days?" is boilerplate UI text, not a question requiring judgment. |
| Validity of a user's answer | Code | The same schema (`TripRequirementsSchema`) that checks the LLM's own extraction and the final save — one set of rules, not a second copy. |
| Retry on invalid answer | Code | Bounded retry (up to 3 times) is a guardrail, like `Hitl.askEmail`. |
| Save to scratchpad | Code | Nothing is left to decide by this point — every field already passed a schema check, so an LLM turn here would only copy data. |

## Where the code is

- `travel_agent/validation.ts` — `TripRequirementsSchema`, `REQUIRED_FIELDS` (derived from it), `ExtractedRequirementsSchema`, `ExcludeSchema`, `parseAndValidateField()`.
- `travel_agent/mainAgent.ts` — `RequirementsDraft`, `FIELD_QUESTIONS` map, `OPTIONAL_FIELDS`, the `extractRequirements` tool, `collectField()` loop, and the save/send block at the end of the intake section of `planTrip`.
- `travel_agent/agent_specs/main/main_agent.md` — STEP 1 (describes the one-call flow and the "Requirements saved:" handoff).
- `travel_agent/hitl.ts` — `askUser()` method (reused for code-driven questions).

## Trade-offs

### Savings

- **LLM calls:** N+2 (one-question-at-a-time) → 1, regardless of how many fields are missing.
- **Latency:** No round-trip to the LLM just to copy already-checked data into a tool call.
- **Consistency:** Question wording is fixed, and there is exactly one place (`TripRequirementsSchema`) that
  defines what a valid answer looks like.

### Costs

- **Question phrasing:** Questions are templated, not conversational. The user sees "How many days?" not "How
  long is your trip?", and a casual answer like "next Friday" or "2 adults + 1 kid" is rejected and re-asked
  rather than understood.
- **Flexibility:** If question text needs to change, edit code, not the spec.

## Related concepts

- `Scratchpad` — where requirements and exclusions end up (`setRequirements`, `addExclusions`); see `concepts/architecture/scratchpad.md`.
- `Main Agent` — owns all user interaction; the Main Agent's spec still runs the one extraction call and resumes at STEP 2 once code hands the saved requirements back.
- Error handling — invalid inputs are re-prompted locally; the LLM is never asked to fix or re-validate anything.
