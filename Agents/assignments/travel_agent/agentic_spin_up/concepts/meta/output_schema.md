# Output Schema — Final Itinerary Format

Companion to `slot_schema.md` (Phase 1 input) for the Phase 2 generation output.
This is the human-readable description; `itinerary_schema.py` is the Pydantic
enforcement layer, and `output_template.md` is the literal text template
rendered from it.

## Structure

**Transportation** (once per trip)
- Source → Destination: mode, provider, cost per person, duration
- Destination → Source: mode, provider, cost per person, duration

**Per day** (repeated for each day of the trip)
- Date
- Weather: condition, temp range, precipitation chance, `advisory` (see below)
- Accommodation: name, maps link, cost per night
- Ordered stop sequence: alternating place / restaurant entries

## Distance rule

Distance is **always measured from the immediately preceding stop in that
day's sequence**, not from accommodation for every entry:

```
accommodation → place 1        distance = accommodation → place 1
place 1 → restaurant 1         distance = place 1 → restaurant 1
restaurant 1 → place 2         distance = restaurant 1 → place 2
...
```

The first stop of the day is always measured from accommodation, since that's
where the day starts. Every stop after that is measured from whatever came
directly before it — never re-measured from accommodation.

## Weather advisory

When forecast conditions cross a bad-weather threshold (defined in
`weather_search` tool logic, not here), the day's weather block carries an
`advisory` field with prompt text, e.g. "Bad weather expected — proceed with
indoor activities?" This is structured data, not just a chat aside: it's
attached to the specific day it applies to, and downstream logic can check
`advisory is not None` to decide whether to pause for confirmation before
finalizing that day's stops.

## Per-item fields

| Item | Fields |
|---|---|
| Transportation leg | mode, provider, cost_per_person, duration |
| Weather | condition, temp_high, temp_low, precipitation_chance, advisory (optional) |
| Accommodation | name, maps_link, cost_per_night |
| Place | name, maps_link, cost_per_person, distance_from_previous_km |
| Restaurant | name, maps_link, cost_per_person, distance_from_previous_km |

## Open items

- Cost currency/locale formatting not yet specified.
- Whether multi-restaurant days (e.g. lunch + dinner) are expected — current
  schema supports any number of place/restaurant entries per day, so this
  should already work, but hasn't been exercised.