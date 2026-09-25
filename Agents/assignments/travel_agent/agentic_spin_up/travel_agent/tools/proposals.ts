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

// Why a proposal can't actually be applied even if the user says yes — checked by the tool body too
// (proposeChange.ts) as a backstop, but surfaced here so the person deciding sees it up front.
export type InvalidReason = "not_found" | "already_rejected" | "limit_reached";

const INVALID_LABEL: Record<InvalidReason, string> = {
  not_found: "not found in the latest search",
  already_rejected: "you already said no to this candidate",
  limit_reached: "retry limit already used — reject this",
};

// Structured data for one proposed change — deliberately not pre-formatted text. `createProposeChangeMiddleware`
// (proposeChange.ts) builds this from the live/staged items and JSON-encodes it as the interrupt's
// `description`; Hitl.reviewToolCalls does all the human-facing formatting (a table for a batch, a compact
// line per item — see formatChangeTable/formatChangeLine below), rather than the middleware baking in one
// fixed box per item regardless of how many arrive in the same turn.
export interface ChangeSummary {
  kind: ProposalKind;
  day: number | null;
  replace: string;
  with: string;
  removeCost: number | null;
  addCost: number | null;
  saving: number | null; // removeCost - addCost; null when either cost is unknown
  attempt: number;
  invalid?: InvalidReason;
}

export function buildChangeSummary(
  kind: ProposalKind,
  oldItem: Dict | null,
  newItem: Dict | null,
  replace: string,
  withName: string,
  day: number | null,
  attempt: number,
  invalid?: InvalidReason,
): ChangeSummary {
  const removeCost = oldItem ? costOf(kind, oldItem) : null;
  const addCost = newItem ? costOf(kind, newItem) : null;
  const saving = removeCost != null && addCost != null ? removeCost - addCost : null;
  return { kind, day, replace, with: withName, removeCost, addCost, saving, attempt, ...(invalid ? { invalid } : {}) };
}

const truncate = (name: string, max = 26): string => (name.length > max ? `${name.slice(0, max - 1)}…` : name);

function costLabel(kind: ProposalKind, cost: number | null): string {
  if (cost == null) return "?";
  return `₹${fmtFixed(cost, 0)}${kind === "accommodation" ? "/night" : ""}`;
}

function savingLabel(summary: ChangeSummary): string {
  if (summary.saving == null) return "cost unknown";
  if (summary.saving > 0) return `saves ₹${fmtFixed(summary.saving, 0)}`;
  if (summary.saving < 0) return `costs ₹${fmtFixed(-summary.saving, 0)} more`;
  return "same cost";
}

// One table for a whole batch of proposals — the overview the compact per-item prompts (formatChangeLine)
// then confirm one at a time. `attempt` is only shown per row when above 1, so a fresh batch (the common
// case) isn't cluttered with "try 1 of 3" on every line.
export function formatChangeTable(summaries: ChangeSummary[]): string {
  const totalSaving = summaries.reduce((sum, s) => sum + (s.saving && s.saving > 0 ? s.saving : 0), 0);
  const header = " #  Day  Kind        Remove                      →  Add                         Save";
  const rows = summaries.map((s, i) => {
    const day = s.day == null ? "-" : String(s.day);
    const flag = s.invalid ? ` ⚠ ${INVALID_LABEL[s.invalid]}` : "";
    const tryTag = s.attempt > 1 ? ` (try ${s.attempt} of ${MAX_PROPOSAL_TRIES})` : "";
    return (
      `${String(i + 1).padStart(2)}  ${day.padStart(3)}  ${s.kind.padEnd(11)} ${truncate(s.replace).padEnd(27)} →  ` +
      `${truncate(s.with).padEnd(27)} ${savingLabel(s)}${tryTag}${flag}`
    );
  });
  return [`\n${summaries.length} changes proposed:\n`, header, ...rows, `\nTotal possible saving: ₹${fmtFixed(totalSaving, 0)}`].join("\n");
}

// The confirm prompt for one item — printed right before asking approve/reject for it, so the person deciding
// doesn't have to scroll back up to the table to remember what row N was.
export function formatChangeLine(summary: ChangeSummary, index: number, total: number): string {
  const day = summary.day == null ? "" : `Day ${summary.day}, `;
  const tryTag = summary.attempt > 1 ? ` [try ${summary.attempt} of ${MAX_PROPOSAL_TRIES}]` : "";
  const flag = summary.invalid ? ` ⚠ ${INVALID_LABEL[summary.invalid]}` : "";
  return (
    `[${index}/${total}]${tryTag} ${day}${summary.kind}: ${truncate(summary.replace)} (${costLabel(summary.kind, summary.removeCost)}) ` +
    `→ ${truncate(summary.with)} (${costLabel(summary.kind, summary.addCost)}) — ${savingLabel(summary)}${flag}`
  );
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
