import { describe, expect, it, vi } from "vitest";
import { Hitl } from "../travel_agent/hitl.ts";
import { resolveTransportBudgetConflict } from "../travel_agent/mainAgent.ts";

const option = (mode: string, total: number, cap: number) => ({
  label: `[${mode}] ${mode} option`,
  flightsResult: { selected: { mode, option: `${mode} option`, provider: "Acme" } },
  itinerary: {},
  budget: { total, ok: total <= cap },
});
const requirements = { budget: 20000, num_travellers: 2 };
const allOver = [option("flight", 30000, 20000), option("bus", 22854, 20000), option("train", 26000, 20000)];

async function run(answers: string[], computed = allOver, reqs: Record<string, unknown> = requirements) {
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  try {
    const result = await resolveTransportBudgetConflict(new Hitl(answers), computed, reqs);
    return { result, output: log.mock.calls.map((c) => c.join(" ")).join("\n") };
  } finally {
    log.mockRestore();
  }
}

describe("resolveTransportBudgetConflict", () => {
  it("does nothing when some option fits the budget", async () => {
    const { result, output } = await run([], [option("bus", 18000, 20000), ...allOver]);
    expect(result).toBeNull();
    expect(output).toBe("");
  });

  it("does nothing when there is no budget cap", async () => {
    expect((await run([], allOver, { ...requirements, budget: null })).result).toBeNull();
  });

  it("option 1 returns the user's transportation change request", async () => {
    const { result } = await run(["1", "leave a day later by train"]);
    expect(result).toEqual({ action: "change_transportation", request: "leave a day later by train" });
  });

  it("option 2 picks the cheapest transport to trim places around", async () => {
    expect((await run(["2"])).result).toEqual({ action: "adjust_places", index: 1 });
  });

  it("option 3 returns the raised budget", async () => {
    expect((await run(["3", "₹25,000"])).result).toEqual({ action: "raise_budget", budget: 25000 });
  });

  it("option 3 with a non-number falls back to the normal list", async () => {
    expect((await run(["3", "no idea"])).result).toBeNull();
  });

  it("names the cap, the cheapest option and the traveller count", async () => {
    const { output } = await run(["2"]);
    expect(output).toContain("₹20000");
    expect(output).toContain("bus: bus option via Acme");
    expect(output).toContain("₹22854 for 2 travellers");
  });
});
