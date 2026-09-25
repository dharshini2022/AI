import { beforeEach, describe, expect, it, vi } from "vitest";
import { Scratchpad } from "../travel_agent/scratchpad.ts";

const trip = {
  source: "Chennai",
  destination: "Madurai",
  start_date: "2026-10-02",
  num_days: 3,
  num_travellers: 2,
  interests: ["food"],
  budget: 30000,
};

let scratchpad: Scratchpad;

beforeEach(() => {
  scratchpad = new Scratchpad();
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("requirements and preferences", () => {
  it("refuses to hand out requirements that were never saved", () => {
    expect(scratchpad.requirements).toBeNull();
    expect(() => scratchpad.requireRequirements()).toThrow("intake must finish first");
  });

  it("updates one requirement without touching the others", () => {
    scratchpad.setRequirements(trip);
    scratchpad.updateRequirements({ budget: 50000 });
    expect(scratchpad.requirements).toEqual({ ...trip, budget: 50000 });
  });

  it("keeps exclusions lower-case and unique, and lets the user take one back", () => {
    scratchpad.addExclusions(["Temples", " temples ", "Museums"]);
    expect(scratchpad.preferences.exclude).toEqual(["temples", "museums"]);
    scratchpad.removeExclusions(["TEMPLES"]);
    expect(scratchpad.preferences.exclude).toEqual(["museums"]);
  });
});

describe("results", () => {
  it("keeps the latest output per tool and counts every write", () => {
    scratchpad.record("places_search", { destination: "Madurai" }, { places: [1] });
    scratchpad.record("places_search", { destination: "Madurai" }, { places: [2] });
    scratchpad.record("weather_search", {}, { days: [] });
    expect(scratchpad.output("places_search")).toEqual({ places: [2] });
    expect(scratchpad.outputs(["places_search", "restaurants_search"])).toEqual({ places_search: { places: [2] } });
    expect(scratchpad.version).toBe(3);
  });
});

describe("facts block", () => {
  it("is empty until requirements are saved", () => {
    expect(scratchpad.factsBlock()).toBe("");
  });

  it("carries the saved trip and the exclusions", () => {
    scratchpad.setRequirements(trip);
    scratchpad.addExclusions(["temples"]);
    const block = scratchpad.factsBlock();
    expect(block).toContain(JSON.stringify(trip));
    expect(block).toContain("does NOT want: temples");
  });
});

describe("pin (the tool-call guardrail)", () => {
  it("passes calls through untouched before requirements are saved", () => {
    const input = { destination: "Ooty", interests: [] };
    expect(scratchpad.pin("places_search", input)).toEqual({ input });
  });

  it("puts the saved destination back when a search names another city, and says so", () => {
    scratchpad.setRequirements(trip);
    const { input, notice } = scratchpad.pin("places_search", { destination: "Ooty", interests: ["food"], indoor_only: false });
    expect(input).toEqual({ destination: "Madurai", interests: ["food"], indoor_only: false });
    expect(notice).toContain("destination 'Ooty' → 'Madurai'");
  });

  it("treats a different spelling of the saved name as the same place: case, spacing, qualified form", () => {
    const log = vi.spyOn(console, "log");
    scratchpad.setRequirements({ ...trip, destination: "chennai" });
    for (const given of ["Chennai", "  CHENNAI ", "Chennai, Tamil Nadu", "Chennai, Tamil Nadu, India"]) {
      const { input, notice } = scratchpad.pin("places_search", { destination: given });
      expect(input.destination).toBe(given);
      expect(notice).toBeUndefined();
    }
    expect(log).not.toHaveBeenCalled();
  });

  it("still replaces an alias it cannot recognise, such as Madras for Chennai", () => {
    scratchpad.setRequirements({ ...trip, destination: "chennai" });
    const { input, notice } = scratchpad.pin("places_search", { destination: "Madras" });
    expect(input.destination).toBe("chennai");
    expect(notice).toContain("Do not try other names for the destination");
  });

  it("also pins dates, days and travellers on the tools that take them", () => {
    scratchpad.setRequirements(trip);
    expect(scratchpad.pin("weather_search", { destination: "Ooty", num_days: 9, start_date: "2027-01-01" }).input).toEqual({
      destination: "Madurai",
      num_days: 3,
      start_date: "2026-10-02",
    });
    expect(scratchpad.pin("accommodation_search", { destination: "Madurai", travellers: 5, start_date: "", nights: 2 }).input).toEqual({
      destination: "Madurai",
      travellers: 2,
      start_date: "2026-10-02",
      nights: 2,
    });
  });

  it("fills in a pinned argument the model left out, without a notice", () => {
    scratchpad.setRequirements(trip);
    const { input, notice } = scratchpad.pin("weather_search", { num_days: 3 });
    expect(input).toMatchObject({ destination: "Madurai", start_date: "2026-10-02" });
    expect(notice).toBeUndefined();
  });

  it("logs only when it actually replaced something", () => {
    const log = vi.spyOn(console, "log");
    scratchpad.setRequirements(trip);
    scratchpad.pin("places_search", { destination: "Madurai" });
    expect(log).not.toHaveBeenCalled();
    scratchpad.pin("places_search", { destination: "Ooty" });
    expect(log.mock.calls[0][0]).toContain("destination 'Ooty' replaced with the saved 'Madurai'");
  });

  it("pins only the day count on transport_search: a new date or route there is the user's own request", () => {
    scratchpad.setRequirements(trip);
    const input = { source: "Bangalore", destination: "Madurai", start_date: "2026-10-05", travellers: 2 };
    const pinned = scratchpad.pin("transport_search", input);
    expect(pinned.input).toEqual({ ...input, num_days: 3 });
    expect(pinned.notice).toBeUndefined();
    expect(scratchpad.pin("transport_search", { ...input, num_days: 9 }).input.num_days).toBe(3);
  });

  it("adds the saved exclusions to place and restaurant searches, keeping the model's own", () => {
    scratchpad.setRequirements(trip);
    scratchpad.addExclusions(["temples"]);
    expect(scratchpad.pin("places_search", { destination: "Madurai", exclude: ["Museums"] }).input.exclude).toEqual(["museums", "temples"]);
    expect(scratchpad.pin("restaurants_search", { destination: "Madurai" }).input.exclude).toEqual(["temples"]);
    expect(scratchpad.pin("accommodation_search", { destination: "Madurai" }).input).not.toHaveProperty("exclude");
  });

  it("does not mutate the input it was given", () => {
    scratchpad.setRequirements(trip);
    const input = { destination: "Ooty" };
    scratchpad.pin("places_search", input);
    expect(input).toEqual({ destination: "Ooty" });
  });
});
