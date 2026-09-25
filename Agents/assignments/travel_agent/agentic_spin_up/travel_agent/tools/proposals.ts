// Shared logic for the draft → propose → approve flow (current_implementation.md steps 2-4): looking up a
// research candidate by name, building the before/after box shown for approval, and tracking how many times
// one specific change has been retried. Kept separate from mainAgent.ts/hitl.ts since both need it: mainAgent
// wires the propose_change tool itself, hitl.ts's reviewToolCalls needs the tracker on the reject path (the
// tool body never runs on reject — see concepts/features/human-in-the-loop.md — so the retry count has to be
// kept and read here instead).
import { fmtFixed, get, isDict, pyOr, type Dict } from "./util.ts";

export type ProposalKind = "place" | "restaurant" | "accommodation";

// One change is retried at most this many times before the user is told it isn't possible — the user's own
// "3 nos" rule (current_implementation.md decision 4).
export const MAX_PROPOSAL_TRIES = 3;

const KIND_TO_TOOL: Record<ProposalKind, string> = {
  place: "places_search",
  restaurant: "restaurants_search",
  accommodation: "accommodation_search",
};

export function toolForKind(kind: ProposalKind): string {
  return KIND_TO_TOOL[kind];
}

// The candidate list a kind's search result actually holds. Restaurants are keyed by meal, so a name is
// looked for across all three.
function itemsOf(kind: ProposalKind, output: unknown): Dict[] {
  if (!isDict(output)) return [];
  if (kind === "place") return pyOr(get(output, "places"), []);
  if (kind === "accommodation") return pyOr(get(output, "accommodation_options"), []);
  return (["Breakfast", "Lunch", "Dinner"] as const).flatMap((meal) => pyOr(get(output, meal), []) as Dict[]);
}

function costOf(kind: ProposalKind, item: Dict): number {
  return pyOr(get(item, kind === "accommodation" ? "price_per_night" : "est_cost"), 0);
}

const norm = (name: string) => name.trim().toLowerCase();

export function findCandidate(kind: ProposalKind, output: unknown, name: string): Dict | null {
  const target = norm(name);
  return itemsOf(kind, output).find((item) => norm(String(get(item, "name", ""))) === target) ?? null;
}

const MEALS = ["Breakfast", "Lunch", "Dinner"] as const;

// Which meal list (for a restaurant) a name is found in, live or staged — used so a swap lands back in the
// same meal it came from, and a pure addition (no live match) lands in whichever meal the candidate itself
// was returned under, rather than a guess.
function mealOf(output: unknown, name: string): (typeof MEALS)[number] | null {
  if (!isDict(output)) return null;
  const target = norm(name);
  return MEALS.find((meal) => (pyOr(get(output, meal), []) as Dict[]).some((item) => norm(String(get(item, "name", ""))) === target)) ?? null;
}

// Applies one approved swap to a tool's LIVE result, replacing only the named item — never publishing the
// rest of a re-searched list the user never saw (current_implementation.md decision 4: "approve exactly one
// item"). `candidate` must already be the resolved staged item (from findCandidate). Falls back to adding the
// candidate when `replace` isn't found live, e.g. "add more nature spots" rather than a straight swap.
// `mealHint` (restaurant only): which meal the candidate came from in the staged result — used only when
// `replace` isn't found in any live meal list, so a pure addition lands where the candidate actually is.
export function applyChange(kind: ProposalKind, liveOutput: unknown, replace: string, candidate: Dict, mealHint?: string | null): Dict {
  const live: Dict = isDict(liveOutput) ? liveOutput : {};
  const target = norm(replace);
  const swap = (list: Dict[]): Dict[] => {
    const idx = list.findIndex((item) => norm(String(get(item, "name", ""))) === target);
    return idx === -1 ? [...list, candidate] : list.map((item, i) => (i === idx ? candidate : item));
  };

  if (kind === "place") return { ...live, places: swap(pyOr(get(live, "places"), [])) };
  if (kind === "accommodation") return { ...live, accommodation_options: swap(pyOr(get(live, "accommodation_options"), [])) };

  // restaurant: replace within whichever meal currently holds `replace`; a pure addition goes into mealHint
  // (falls back to Dinner) rather than a guess.
  const meal = mealOf(live, replace) ?? mealHint ?? "Dinner";
  return { ...live, [meal]: swap(pyOr(get(live, meal), [])) };
}

export { mealOf };

// One line describing a candidate for the box: name, cost, and (for a stay) how far it is from the day it
// would serve, when that distance is known.
function candidateLine(kind: ProposalKind, item: Dict | null, fallbackName: string): string {
  if (!item) return `${fallbackName} — not found in the latest search`;
  const cost = costOf(kind, item);
  const unit = kind === "accommodation" ? "/night" : "";
  return `${get(item, "name", fallbackName)} — ₹${fmtFixed(cost, 0)}${unit}`;
}

// Pure text builder for the propose_change approval box, in the same style as formatWeatherBox/
// formatBookingBox (hitl.ts) — no I/O, built entirely by code from the current live item and the staged
// candidate, never from the model's own description of the change.
export function formatChangeBox(kind: ProposalKind, oldItem: Dict | null, newItem: Dict | null, replace: string, attempt: number): string {
  const oldCost = oldItem ? costOf(kind, oldItem) : null;
  const newCost = newItem ? costOf(kind, newItem) : null;
  const delta = oldCost != null && newCost != null ? oldCost - newCost : null;
  const effect = delta == null ? "Cost unknown" : delta > 0 ? `Saves ₹${fmtFixed(delta, 0)}` : delta < 0 ? `Costs ₹${fmtFixed(-delta, 0)} more` : "Same cost";
  const lines = [
    `\nReplace this ${kind}?\n`,
    `┌ Proposed Change (try ${attempt} of ${MAX_PROPOSAL_TRIES}) ─────────────────────────────`,
    `│ Remove : ${candidateLine(kind, oldItem, replace)}`,
    `│ Add    : ${candidateLine(kind, newItem, "(unnamed candidate)")}`,
    `│ Effect : ${effect}`,
    `└───────────────────────────────────────────────────────────────────`,
  ];
  return lines.join("\n");
}

// Per-item retry state for one trip: how many times this exact change has been rejected, and which
// candidates were already turned down (so the same one is never re-proposed). Reset once an item is
// approved, or once the itinerary moves on from it.
export class ProposalTracker {
  private attempts = new Map<string, number>();
  private rejected = new Map<string, Set<string>>();

  // `day` is deliberately not part of the key — a call that sometimes omits it (or picks a different day for
  // the same named item) would otherwise reset the count and make the 3-try limit meaningless. `kind` +
  // `replace` is enough to identify one specific change.
  key(kind: ProposalKind, replace: string): string {
    return `${kind}:${norm(replace)}`;
  }

  attemptsFor(key: string): number {
    return this.attempts.get(key) ?? 0;
  }

  alreadyRejected(key: string, candidate: string): boolean {
    return this.rejected.get(key)?.has(norm(candidate)) ?? false;
  }

  // Called on a "no". Returns the new attempt count for this item.
  recordRejection(key: string, candidate: string): number {
    const next = (this.attempts.get(key) ?? 0) + 1;
    this.attempts.set(key, next);
    const set = this.rejected.get(key) ?? new Set<string>();
    set.add(norm(candidate));
    this.rejected.set(key, set);
    return next;
  }

  reset(key: string): void {
    this.attempts.delete(key);
    this.rejected.delete(key);
  }

  // Wipes every item's retry state — called when a staging session closes (mainAgent.ts's recheckBudget/
  // requestPlaceEdit), so a limit hit in one budget-menu visit or edit doesn't carry into an unrelated later
  // one (a stale count would show "try 4 of 3" on what the user experiences as a fresh request).
  clear(): void {
    this.attempts.clear();
    this.rejected.clear();
  }
}
