import { beforeEach, describe, expect, it, vi } from "vitest";
import { McpTools } from "../travel_agent/mcpClient.ts";

// What the model sees from an LLM-issued tool call versus what is recorded for the itinerary builder.
// A fake McpTools stands in for the MCP server: `call` returns whatever the test sets.
let response: unknown;
const sent: Record<string, unknown>[] = [];

class FakeMcp extends McpTools {
  async call(_name: string, args: Record<string, unknown> = {}) {
    sent.push(args);
    return response;
  }
}

function toolFor(name: string, onResult: (tool: string, result: unknown, input: Record<string, unknown>) => void, guard?: any) {
  const mcp = new FakeMcp();
  Object.assign(mcp, { tools: [{ name, description: "", schema: { type: "object", properties: {}, additionalProperties: true } }] });
  return mcp.langchainTools(null, "Place Agent", onResult, guard)[0];
}

beforeEach(() => {
  sent.length = 0;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("notices for the model", () => {
  it("tells the model when the guard replaced a value, and records the result without the notice", async () => {
    response = { places: [{ name: "Marina Beach" }] };
    const recorded: unknown[] = [];
    const guard = () => ({ input: { destination: "chennai" }, notice: "The search used the saved values." });
    const result = await toolFor("places_search", (_t, r, input) => recorded.push([r, input]), guard).invoke({ destination: "Madras" });

    expect(sent).toEqual([{ destination: "chennai" }]);
    expect(result).toEqual({ places: [{ name: "Marina Beach" }], guard_notice: "The search used the saved values." });
    expect(recorded).toEqual([[{ places: [{ name: "Marina Beach" }] }, { destination: "chennai" }]]);
  });

  it("passes a search_problem to the model but not into the recorded result", async () => {
    response = { places: [], search_problem: "serpapi: quota" };
    const recorded: unknown[] = [];
    const result = await toolFor("places_search", (_t, r) => recorded.push(r)).invoke({ destination: "chennai" });

    expect(result).toEqual({ places: [], search_problem: "serpapi: quota" });
    expect(recorded).toEqual([{ places: [] }]);
  });

  it("keeps a meals dictionary free of the flag when recording it", async () => {
    response = { Breakfast: [], Lunch: [], Dinner: [], search_problem: "serpapi: quota; serper: unauthorized" };
    const recorded: unknown[] = [];
    await toolFor("restaurants_search", (_t, r) => recorded.push(r)).invoke({ destination: "chennai" });
    expect(recorded).toEqual([{ Breakfast: [], Lunch: [], Dinner: [] }]);
  });

  it("returns an ordinary result untouched when there is nothing to tell the model", async () => {
    response = { places: [{ name: "Marina Beach" }] };
    const recorded: unknown[] = [];
    const guard = (_tool: string, input: Record<string, unknown>) => ({ input });
    const result = await toolFor("places_search", (_t, r) => recorded.push(r), guard).invoke({ destination: "chennai" });

    expect(result).toEqual({ places: [{ name: "Marina Beach" }] });
    expect(recorded).toEqual([{ places: [{ name: "Marina Beach" }] }]);
  });
});
