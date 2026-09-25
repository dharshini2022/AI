import { beforeEach, describe, expect, it, vi } from "vitest";

// A plan edit after the plan is shown ("no museums"), offline and end to end: real Main Agent code, SpinUp,
// LangChain tool wrappers, the scratchpad guard and the MCP tool handlers (in-process), with scripted LLMs.
// The scripted place agent drifts on purpose when it gets an edit: it searches another city and forgets the
// exclusion. The guard has to put both back.
const script = vi.hoisted(() => {
  const state = {
    calls: [] as { name: string; args: Record<string, any> }[],
    toolNames: new Set<string>(),
    mode: "edit" as "edit" | "skipPresent" | "loop" | "cancel",
    limitReached: false,
  };
  const reply = (value: unknown) => ({ messages: [{ content: JSON.stringify(value) }] });
  const req = { source: "Bangalore", destination: "Munnar", start_date: "2026-10-02", num_days: 3, num_travellers: 2, interests: ["tea"], budget: 999_999, exclude: [] };
  const confirm = "Press Enter to confirm. Or ask a question, request a change to the plan, or ask to recheck the budget:";

  function fakeCreateAgent({ tools = [], systemPrompt = "" }: { tools?: any[]; systemPrompt?: string }) {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    for (const name of Object.keys(byName)) state.toolNames.add(name);
    const turns = { place: 0, main: 0 };
    return {
      async invoke({ messages }: { messages: { content: string }[] }) {
        const content = messages.at(-1)!.content;

        if (systemPrompt.includes("transport research specialist")) {
          const task = JSON.parse(content);
          await byName.transport_search.invoke({ source: task.source, destination: task.destination, start_date: task.start_date, travellers: task.travellers });
          return reply({ done: true });
        }

        if (systemPrompt.includes("destination research specialist")) {
          if (++turns.place === 1) {
            const task = JSON.parse(content);
            await Promise.all([
              byName.weather_search.invoke({ destination: task.destination, num_days: task.num_days, start_date: task.start_date }),
              byName.places_search.invoke({ destination: task.destination, interests: task.interests, indoor_only: false }),
              byName.restaurants_search.invoke({ destination: task.destination, interests: task.interests }),
              byName.accommodation_search.invoke({ destination: task.destination, travellers: task.travellers, start_date: task.start_date, nights: 2 }),
            ]);
          } else {
            await byName.places_search.invoke({ destination: "Ooty", interests: ["tea"], indoor_only: false });
          }
          return reply({ done: true });
        }

        // A nudge after the Main Agent stopped early: it just stops again, so the code-side safety net is what shows the plan.
        if (content.startsWith("You stopped")) return reply({ confirmed: true });

        // The Main Agent's own session: turn 1 extracts everything (nothing left for the intake loop to
        // ask), so turn 2 arrives already carrying "Requirements saved:" from the application code.
        turns.main++;
        if (turns.main === 1) {
          await byName.extract_requirements.invoke(req);
          return reply({ done: false });
        }

        await byName.launch_subagent.invoke({ spec_name: "transportation_agent", task: { source: req.source, destination: req.destination, start_date: req.start_date, travellers: 2, budget_cap: req.budget } });
        await byName.launch_subagent.invoke({ spec_name: "place_agent", task: { destination: req.destination, interests: req.interests, num_days: req.num_days, start_date: req.start_date, travellers: 2 } });
        await byName.wait_for_subagents.invoke({});
        if (state.mode === "cancel") return reply({ cancelled: true, reason: "the search service is down" });
        await byName.choose_transport.invoke({});
        if (state.mode === "skipPresent") return reply({ confirmed: true });
        let shown = await byName.present_plan.invoke({});
        if (state.mode === "loop") {
          while ((await byName.ask_user.invoke({ question: confirm })).answer) {
            shown = await byName.present_plan.invoke({});
            if (shown.limit_reached) break;
          }
          state.limitReached = Boolean(shown.limit_reached);
          return reply({ confirmed: true });
        }
        const { answer } = await byName.ask_user.invoke({ question: confirm });
        if (answer) {
          await byName.update_preferences.invoke({ add_exclude: ["museums"] });
          await byName.send_message_to_subagent.invoke({ task_id: "place_agent-1", message: `Change the places: ${answer}` });
          await byName.wait_for_subagents.invoke({});
          await byName.present_plan.invoke({});
          await byName.ask_user.invoke({ question: confirm });
        }
        return reply({ confirmed: true });
      },
    };
  }
  return { state, fakeCreateAgent };
});

vi.mock("langchain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("langchain")>()),
  createAgent: script.fakeCreateAgent,
}));
vi.mock("../travel_agent/config.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../travel_agent/config.ts")>();
  return { ...mod, settings: { ...mod.settings, serpapiApiKey: "test-key", mapsProviders: ["serpapi"], usdToInr: 82.5, badWeatherRainPct: 60, searchCacheTtlMs: 0, searchFallbackCacheTtlMs: 0 } };
});
vi.mock("../travel_agent/tools/http.ts", async () => {
  const { fakeRequestJson, fakeRequestJsonDetailed } = await import("./fixtures/fakeHttp.ts");
  return { requestJson: fakeRequestJson, requestJsonDetailed: fakeRequestJsonDetailed };
});
vi.mock("../travel_agent/mcpClient.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../travel_agent/mcpClient.ts")>();
  const { TOOLS } = await import("../travel_agent/mcp_server/handlers.ts");
  const { z } = await import("zod");
  class InProcessMcpTools extends mod.McpTools {
    async open() {
      const tools = Object.entries(TOOLS).map(([name, t]) => ({
        name,
        description: t.description,
        schema: z.toJSONSchema(z.object(t.inputSchema), { io: "input" }),
      }));
      return Object.assign(this, { tools });
    }
    async close() {}
    async call(name: string, args: Record<string, unknown> = {}) {
      script.state.calls.push({ name, args });
      const t = TOOLS[name];
      return JSON.parse(JSON.stringify(await t.run(z.object(t.inputSchema).parse(args), () => {})));
    }
  }
  return { ...mod, McpTools: InProcessMcpTools };
});

const { Hitl } = await import("../travel_agent/hitl.ts");
const { can } = await import("../travel_agent/rbac/rbac.ts");
const { planTrip } = await import("../travel_agent/mainAgent.ts");

const activities = (itinerary: any): string[] => itinerary.cards.flatMap((c: any) => c.activities.map((a: any) => a.name));
let printed: string[];

beforeEach(() => {
  script.state.mode = "edit";
  script.state.limitReached = false;
  script.state.calls = [];
  printed = [];
  vi.spyOn(console, "log").mockImplementation((...args) => void printed.push(args.join(" ")));
});

describe("editing the plan after it is shown", () => {
  it("keeps the destination, applies the exclusion and shows the new plan", async () => {
    const result = await planTrip("trip", { hitl: new Hitl(["1", "1", "no museums", ""]) });

    const placeSearches = script.state.calls.filter((c) => c.name === "places_search");
    expect(placeSearches).toHaveLength(2);
    expect(placeSearches.every((c) => c.args.destination === "Munnar")).toBe(true);
    expect(placeSearches[0].args.exclude).toBeUndefined();
    expect(placeSearches[1].args.exclude).toEqual(["museums"]);
    expect(printed.some((line) => line.includes("[guard] places_search: destination 'Ooty' replaced with the saved 'Munnar'"))).toBe(true);

    expect(result.requirements.destination).toBe("Munnar");
    expect(result.itinerary.route).toBe("Bangalore → Munnar");
    expect(activities(result.itinerary).some((name) => /museum/i.test(name))).toBe(false);
    expect(result.subagent_tasks.find((t: any) => t.spec_name === "place_agent")).toMatchObject({ turns: 2, status: "done" });
  });

  it("shows the plan again after the edit, and only once when nothing is changed", async () => {
    const plans = (lines: string[]) => lines.filter((l) => l.includes("FINAL PLAN")).length;
    await planTrip("trip", { hitl: new Hitl(["1", "1", "no museums", ""]) });
    expect(plans(printed)).toBe(2);

    printed = [];
    await planTrip("trip", { hitl: new Hitl(["1", "1", ""]) });
    expect(plans(printed)).toBe(1);
  });

  it("confirms with a plain Enter and leaves the place agent alone", async () => {
    const result = await planTrip("trip", { hitl: new Hitl(["1", "1", ""]) });
    expect(script.state.calls.filter((c) => c.name === "places_search")).toHaveLength(1);
    expect(result.subagent_tasks.find((t: any) => t.spec_name === "place_agent")).toMatchObject({ turns: 1 });
    // Without the edit the museum is in the plan, so its absence above is caused by the exclusion.
    expect(activities(result.itinerary).some((name) => /museum/i.test(name))).toBe(true);
  });
});

describe("permissions", () => {
  // The scripted agents skip the RBAC middleware, so this is what catches a new tool the user role cannot call.
  it("lets the user role call every tool any agent is given", async () => {
    script.state.toolNames.clear();
    await planTrip("trip", { hitl: new Hitl(["1", "1", ""]) });
    expect(script.state.toolNames.size).toBeGreaterThan(10);
    const denied = [...script.state.toolNames].filter((name) => !can({ id: "user-1", role: "user" }, name));
    expect(denied).toEqual([]);
  });
});

describe("the code-side safety nets around the Main Agent's confirm loop", () => {
  it("shows the plan itself when the Main Agent stops without ever presenting one", async () => {
    script.state.mode = "skipPresent";
    const result = await planTrip("trip", { hitl: new Hitl(["1", "1", ""]) });
    expect(result.itinerary.route).toBe("Bangalore → Munnar");
    expect(printed.filter((l) => l.includes("FINAL PLAN"))).toHaveLength(1);
  });

  it("ends cleanly when the Main Agent reports the user chose to stop", async () => {
    script.state.mode = "cancel";
    const result = await planTrip("trip", { hitl: new Hitl([]) });
    expect(result).toMatchObject({ cancelled: true, reason: "the search service is down" });
    expect(result.itinerary).toBeUndefined();
    expect(printed.some((l) => l.includes("FINAL PLAN"))).toBe(false);
    expect(printed).toContain("\nPlanning stopped.");
  });

  it("stops offering revisions once present_plan reports the limit", async () => {
    script.state.mode = "loop";
    await planTrip("trip", { hitl: new Hitl(["1", "1", ...Array(8).fill("tweak it")]) });
    expect(script.state.limitReached).toBe(true);
    expect(printed.filter((l) => l.includes("FINAL PLAN"))).toHaveLength(6);
  });
});
