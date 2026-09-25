import { describe, expect, it, vi } from "vitest";
import type { HITLRequest } from "langchain";
import { Hitl } from "../travel_agent/hitl.ts";
import {
  applyChange,
  buildChangeSummary,
  type ChangeSummary,
  findCandidate,
  formatChangeLine,
  formatChangeTable,
  MAX_PROPOSAL_TRIES,
  mealOf,
  ProposalTracker,
} from "../travel_agent/tools/proposals.ts";

// Builds the same shape the real humanInTheLoopMiddleware interrupt carries for one propose_change call —
// `description`, when given, is the JSON ChangeSummary the real middleware now sends (proposeChange.ts) — so
// Hitl.reviewToolCalls (the client side of the interrupt/resume cycle — see
// concepts/features/human-in-the-loop.md) can be exercised directly without a real LangGraph run.
function proposeChangeRequest(args: Record<string, unknown>, description?: string): HITLRequest {
  return {
    actionRequests: [{ name: "propose_change", args, description }],
    reviewConfigs: [{ actionName: "propose_change", allowedDecisions: ["approve", "reject"] }],
  } as HITLRequest;
}

function batchRequest(...changes: { args: Record<string, unknown>; description: string }[]): HITLRequest {
  return {
    actionRequests: changes.map((c) => ({ name: "propose_change", ...c })),
    reviewConfigs: changes.map(() => ({ actionName: "propose_change", allowedDecisions: ["approve", "reject"] })),
  } as HITLRequest;
}

describe("ProposalTracker", () => {
  it("ignores `day` in the key, so a call that varies it doesn't reset the count", () => {
    const tracker = new ProposalTracker();
    const key = tracker.key("place", "Wonderla Park");
    expect(key).toBe(tracker.key("place", "Wonderla Park")); // same key regardless of day, since day isn't taken
    tracker.recordRejection(key, "Cubbon Park");
    expect(tracker.attemptsFor(key)).toBe(1);
  });

  it("tracks attempts and rejected candidates per key, and resets on approval", () => {
    const tracker = new ProposalTracker();
    const key = tracker.key("place", "Wonderla Park");
    expect(tracker.attemptsFor(key)).toBe(0);
    expect(tracker.alreadyRejected(key, "Cubbon Park")).toBe(false);

    tracker.recordRejection(key, "Cubbon Park");
    expect(tracker.attemptsFor(key)).toBe(1);
    expect(tracker.alreadyRejected(key, "cubbon park")).toBe(true); // case/space-insensitive

    tracker.reset(key);
    expect(tracker.attemptsFor(key)).toBe(0);
    expect(tracker.alreadyRejected(key, "Cubbon Park")).toBe(false);
  });

  it("clear() wipes every key's state", () => {
    const tracker = new ProposalTracker();
    const key = tracker.key("accommodation", "Hotel Grand");
    tracker.recordRejection(key, "Hotel Lotus");
    tracker.clear();
    expect(tracker.attemptsFor(key)).toBe(0);
    expect(tracker.alreadyRejected(key, "Hotel Lotus")).toBe(false);
  });
});

describe("findCandidate / mealOf", () => {
  it("finds a place or accommodation candidate by name, case/space-insensitively", () => {
    const places = { places: [{ name: "Cubbon Park", est_cost: 0 }] };
    expect(findCandidate("place", places, " cubbon PARK ")).toMatchObject({ name: "Cubbon Park" });
    expect(findCandidate("place", places, "Lalbagh")).toBeNull();
  });

  it("finds a restaurant candidate across all three meals, and reports which meal it's in", () => {
    const restaurants = { Breakfast: [], Lunch: [{ name: "MTR", est_cost: 350 }], Dinner: [{ name: "Taste of Munnar", est_cost: 400 }] };
    expect(findCandidate("restaurant", restaurants, "MTR")).toMatchObject({ name: "MTR" });
    expect(mealOf(restaurants, "MTR")).toBe("Lunch");
    expect(mealOf(restaurants, "Taste of Munnar")).toBe("Dinner");
    expect(mealOf(restaurants, "Nobody's Cafe")).toBeNull();
  });
});

describe("applyChange — the single-item merge into the live result", () => {
  it("swaps only the named place, leaving every other place untouched", () => {
    const live = { places: [{ name: "Wonderla Park", est_cost: 1200 }, { name: "Lalbagh", est_cost: 0 }] };
    const candidate = { name: "Cubbon Park", est_cost: 0 };
    const next = applyChange("place", live, "Wonderla Park", candidate);
    expect(next.places).toEqual([{ name: "Cubbon Park", est_cost: 0 }, { name: "Lalbagh", est_cost: 0 }]);
  });

  it("appends the candidate when `replace` isn't found live (a pure addition), instead of dropping other places", () => {
    const live = { places: [{ name: "Lalbagh", est_cost: 0 }] };
    const candidate = { name: "Cubbon Park", est_cost: 0 };
    const next = applyChange("place", live, "Nonexistent Place", candidate);
    expect(next.places).toEqual([{ name: "Lalbagh", est_cost: 0 }, { name: "Cubbon Park", est_cost: 0 }]);
  });

  it("swaps only the named accommodation, without touching the accommodation_options siblings", () => {
    const live = { accommodation_options: [{ name: "Hotel Grand", price_per_night: 4000 }, { name: "Other Hotel", price_per_night: 3500 }] };
    const candidate = { name: "Hotel Lotus", price_per_night: 2600 };
    const next = applyChange("accommodation", live, "Hotel Grand", candidate);
    expect(next.accommodation_options).toEqual([{ name: "Hotel Lotus", price_per_night: 2600 }, { name: "Other Hotel", price_per_night: 3500 }]);
  });

  it("swaps a restaurant within the meal it currently belongs to, leaving the other meals untouched", () => {
    const live = { Breakfast: [{ name: "Cafe A", est_cost: 100 }], Dinner: [{ name: "Guru's Restaurant", est_cost: 1800 }] };
    const candidate = { name: "Taste of Munnar", est_cost: 400 };
    const next = applyChange("restaurant", live, "Guru's Restaurant", candidate);
    expect(next.Dinner).toEqual([{ name: "Taste of Munnar", est_cost: 400 }]);
    expect(next.Breakfast).toEqual([{ name: "Cafe A", est_cost: 100 }]); // untouched
  });

  it("places a restaurant addition into the meal hint when `replace` isn't found live", () => {
    const live = { Lunch: [{ name: "MTR", est_cost: 350 }] };
    const candidate = { name: "Some Cafe", est_cost: 200 };
    const next = applyChange("restaurant", live, "Nonexistent Restaurant", candidate, "Breakfast");
    expect(next.Breakfast).toEqual([{ name: "Some Cafe", est_cost: 200 }]);
    expect(next.Lunch).toEqual([{ name: "MTR", est_cost: 350 }]); // untouched
  });
});

describe("buildChangeSummary / formatChangeTable / formatChangeLine", () => {
  const wonderlaToCubbon = () =>
    buildChangeSummary("place", { name: "Wonderla Park", est_cost: 1200 }, { name: "Cubbon Park", est_cost: 0 }, "Wonderla Park", "Cubbon Park", 2, 1);

  it("computes the saving from the two items' costs", () => {
    const summary = wonderlaToCubbon();
    expect(summary).toMatchObject({ removeCost: 1200, addCost: 0, saving: 1200, day: 2, attempt: 1 });
  });

  it("leaves saving null when either item's cost is unknown, rather than guessing", () => {
    const summary = buildChangeSummary("place", { name: "Wonderla Park", est_cost: 1200 }, null, "Wonderla Park", "Cubbon Park", 2, 1);
    expect(summary.saving).toBeNull();
    expect(summary.addCost).toBeNull();
  });

  it("carries the invalid reason through, when given", () => {
    const summary = buildChangeSummary("place", null, null, "Wonderla Park", "Cubbon Park", 2, 4, "limit_reached");
    expect(summary.invalid).toBe("limit_reached");
  });

  it("formatChangeLine shows the try count only above try 1, and flags an invalid proposal", () => {
    expect(formatChangeLine(wonderlaToCubbon(), 1, 1)).not.toContain("try");
    const retried = { ...wonderlaToCubbon(), attempt: 2 };
    expect(formatChangeLine(retried, 1, 1)).toContain("try 2 of 3");
    const invalid: ChangeSummary = { ...wonderlaToCubbon(), invalid: "already_rejected" };
    expect(formatChangeLine(invalid, 1, 1)).toContain("already said no");
  });

  it("formatChangeTable lists every row and totals only the positive savings", () => {
    const costly = buildChangeSummary("restaurant", { name: "Cafe A", est_cost: 100 }, { name: "Cafe B", est_cost: 500 }, "Cafe A", "Cafe B", 1, 1);
    const table = formatChangeTable([wonderlaToCubbon(), costly]);
    expect(table).toContain("Wonderla Park");
    expect(table).toContain("Cubbon Park");
    expect(table).toContain("Cafe A");
    expect(table).toContain("Total possible saving: ₹1200"); // costly's -400 isn't counted as a saving
  });
});

describe("Hitl.reviewToolCalls — the propose_change reject/approve path", () => {
  it("approving resets the tracker for that item", async () => {
    const hitl = new Hitl(["yes"]);
    hitl.proposals.recordRejection(hitl.proposals.key("place", "Wonderla Park"), "Cubbon Park");
    await hitl.reviewToolCalls(proposeChangeRequest({ kind: "place", replace: "Wonderla Park", with: "Cubbon Park" }));
    expect(hitl.proposals.attemptsFor(hitl.proposals.key("place", "Wonderla Park"))).toBe(0);
  });

  it("rejecting once returns a retry message and records the attempt", async () => {
    const hitl = new Hitl(["no"]);
    const { decisions } = await hitl.reviewToolCalls(proposeChangeRequest({ kind: "place", replace: "Wonderla Park", with: "Cubbon Park" }));
    expect(decisions).toEqual([{ type: "reject", message: expect.stringContaining("1 of 3") }]);
    expect(decisions[0]).toMatchObject({ message: expect.stringContaining("Propose a different candidate") });
    expect(hitl.proposals.attemptsFor(hitl.proposals.key("place", "Wonderla Park"))).toBe(1);
    expect(hitl.proposals.alreadyRejected(hitl.proposals.key("place", "Wonderla Park"), "Cubbon Park")).toBe(true);
  });

  it("rejecting three times returns limit_reached and stops short of a fourth silent retry", async () => {
    const hitl = new Hitl(["no", "no", "no"]);
    let lastMessage = "";
    for (let i = 0; i < MAX_PROPOSAL_TRIES; i++) {
      const { decisions } = await hitl.reviewToolCalls(proposeChangeRequest({ kind: "place", replace: "Wonderla Park", with: "Cubbon Park" }));
      lastMessage = decisions[0].type === "reject" ? (decisions[0].message ?? "") : "";
    }
    expect(lastMessage).toContain("limit_reached");
    expect(hitl.proposals.attemptsFor(hitl.proposals.key("place", "Wonderla Park"))).toBe(MAX_PROPOSAL_TRIES);
  });

  it("prints one table for a batch of proposals, then a compact line per item — not a repeated box", async () => {
    const wonderla = buildChangeSummary("place", { name: "Wonderla Park", est_cost: 1200 }, { name: "Cubbon Park", est_cost: 0 }, "Wonderla Park", "Cubbon Park", 2, 1);
    const cafe = buildChangeSummary("restaurant", { name: "Cafe A", est_cost: 500 }, { name: "Cafe B", est_cost: 300 }, "Cafe A", "Cafe B", 1, 1);
    const hitl = new Hitl(["yes", "yes"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await hitl.reviewToolCalls(
      batchRequest(
        { args: { kind: "place", day: 2, replace: "Wonderla Park", with: "Cubbon Park" }, description: JSON.stringify(wonderla) },
        { args: { kind: "restaurant", day: 1, replace: "Cafe A", with: "Cafe B" }, description: JSON.stringify(cafe) },
      ),
    );

    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed.filter((line) => line.includes("changes proposed"))).toHaveLength(1); // the table, once
    expect(printed.some((line) => line.includes("[1/2]") && line.includes("Wonderla Park"))).toBe(true);
    expect(printed.some((line) => line.includes("[2/2]") && line.includes("Cafe A"))).toBe(true);
    log.mockRestore();
  });

  it("does not print a table for a single proposal — just its compact line", async () => {
    const wonderla = buildChangeSummary("place", { name: "Wonderla Park", est_cost: 1200 }, { name: "Cubbon Park", est_cost: 0 }, "Wonderla Park", "Cubbon Park", 2, 1);
    const hitl = new Hitl(["yes"]);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});

    await hitl.reviewToolCalls(proposeChangeRequest({ kind: "place", day: 2, replace: "Wonderla Park", with: "Cubbon Park" }, JSON.stringify(wonderla)));

    const printed = log.mock.calls.map((c) => String(c[0]));
    expect(printed.some((line) => line.includes("changes proposed"))).toBe(false);
    expect(printed.some((line) => line.includes("[1/1]"))).toBe(true);
    log.mockRestore();
  });
});
