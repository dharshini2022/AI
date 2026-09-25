import { expect, it } from "vitest";
import { McpTools } from "../travel_agent/mcpClient.ts";

const EXPECTED = [
  "transport_search", "weather_search", "places_search", "restaurants_search",
  "accommodation_search", "merge_plan", "budget_check",
];

async function withMcp(fn: (mcp: McpTools) => Promise<void>, maxConcurrency?: number): Promise<void> {
  const mcp = await new McpTools({ maxConcurrency }).open();
  try {
    await fn(mcp);
  } finally {
    await mcp.close();
  }
}

it("server lists all tools", () =>
  withMcp(async (mcp) => {
    expect(mcp.toolNames()).toEqual(expect.arrayContaining(EXPECTED));
  }));

it("transport and weather calls", () =>
  withMcp(async (mcp) => {
    const tr = await mcp.call("transport_search", {
      source: "Coimbatore", destination: "Pondicherry", start_date: "2026-10-02", travellers: 2,
    });
    expect(tr).toHaveProperty("options");
    expect(tr).toHaveProperty("source");
    expect(tr.options.length).toBeGreaterThanOrEqual(3);
    const [first] = tr.options;
    expect(first).toHaveProperty("approx_fare");
    expect(first).toHaveProperty("travel_time");
    expect(first.booking_url).toMatch(/redbus|makemytrip|http/);

    const wx = await mcp.call("weather_search", { destination: "Pondicherry", num_days: 3, start_date: "2026-10-02" });
    expect(wx).toHaveProperty("bad_weather");
    expect("days" in wx || "message" in wx).toBe(true);
  }));

it("parallel tool calls", () =>
  withMcp(async (mcp) => {
    const results = await Promise.all([
      mcp.call("transport_search", { source: "Chennai", destination: "Bengaluru", start_date: "2026-10-02", travellers: 1 }),
      mcp.call("weather_search", { destination: "Bengaluru", num_days: 2, start_date: "2026-10-02" }),
      mcp.call("places_search", { destination: "Bengaluru", interests: ["parks"] }),
      mcp.call("restaurants_search", { destination: "Bengaluru", interests: ["south indian"] }),
    ]);
    expect(results[0]).toHaveProperty("options");
    expect(results[1]).toHaveProperty("bad_weather");
    expect(results[2]).toHaveProperty("places");
    expect(typeof results[3]).toBe("object");
  }, 4));
