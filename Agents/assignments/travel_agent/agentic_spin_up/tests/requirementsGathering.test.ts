import { beforeEach, describe, expect, it, vi } from "vitest";

// Offline end-to-end: real Main Agent code, SpinUp, LangChain tool wrappers, the scratchpad and the MCP tool
// handlers (in-process), with a scripted extraction call. Each test sets `script.state.extraction` to what
// the model "found" in the user's message, then drives the rest of the intake through scripted answers.
const script = vi.hoisted(() => {
  const state = {
    extraction: {} as Record<string, unknown>,
    calls: [] as { name: string; args: Record<string, any> }[],
  };
  const reply = (value: unknown) => ({ messages: [{ content: JSON.stringify(value) }] });

  function fakeCreateAgent({ tools = [], systemPrompt = "" }: { tools?: any[]; systemPrompt?: string }) {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    let mainTurn = 0;

    return {
      async invoke({ messages }: { messages: { content: string }[] }) {
        const content = messages.at(-1)!.content;
        const task = content.trim().startsWith("{") ? JSON.parse(content) : {};

        if (systemPrompt.includes("transport research specialist")) {
          await byName.transport_search.invoke({
            source: task.source, destination: task.destination, start_date: task.start_date, travellers: task.travellers ?? 1,
          });
          return reply({ done: true });
        }

        if (systemPrompt.includes("destination research specialist")) {
          const numDays = task.num_days ?? 2;
          await Promise.all([
            byName.weather_search.invoke({ destination: task.destination, num_days: numDays, start_date: task.start_date ?? "" }),
            byName.places_search.invoke({ destination: task.destination, interests: task.interests ?? [], indoor_only: false }),
            byName.restaurants_search.invoke({ destination: task.destination, interests: task.interests ?? [] }),
            byName.accommodation_search.invoke({
              destination: task.destination, travellers: task.travellers ?? 1, start_date: task.start_date ?? "", nights: Math.max(1, numDays - 1),
            }),
          ]);
          return reply({ done: true });
        }

        // The Main Agent's own session: turn 1 is the one extraction call; every later turn arrives only
        // once code has already collected, validated and saved the requirements itself.
        mainTurn++;
        if (mainTurn === 1) {
          await byName.extract_requirements.invoke(script.state.extraction);
          return reply({ done: false });
        }

        if (content.startsWith("Requirements saved:")) {
          const m = content.match(/^Requirements saved: (.+?)(?: Excluded: (\[.*?\])\.)? Continue with STEP 2\.$/);
          const req = JSON.parse(m![1]);
          await byName.launch_subagent.invoke({
            spec_name: "transportation_agent",
            task: { source: req.source, destination: req.destination, start_date: req.start_date, travellers: req.num_travellers, budget_cap: req.budget },
          });
          await byName.launch_subagent.invoke({
            spec_name: "place_agent",
            task: { destination: req.destination, interests: req.interests, num_days: req.num_days, start_date: req.start_date, travellers: req.num_travellers },
          });
          await byName.wait_for_subagents.invoke({});
          await byName.choose_transport.invoke({});
          await byName.present_plan.invoke({});
          await byName.ask_user.invoke({ question: "Press Enter to confirm." });
          return reply({ confirmed: true });
        }

        return reply({ confirmed: true }); // a step nudge after the fake stopped early: just stop again
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
const { planTrip } = await import("../travel_agent/mainAgent.ts");

const FULL: Record<string, unknown> = {
  source: "Bangalore", destination: "Munnar", start_date: "2026-10-02", num_days: 2, num_travellers: 2,
};

beforeEach(() => {
  script.state.calls = [];
});

// Every run also has to answer choose_transport's outbound and return prompts ("1", "1") before the
// final "Press Enter to confirm." — the same two answers every other end-to-end test in this suite uses.
const TRANSPORT_AND_CONFIRM = ["1", "1", ""];

it("asks for interests when extraction didn't determine them, and saves what the user says", async () => {
  script.state.extraction = { ...FULL, budget: 30000 }; // interests and exclude both left out
  const result = await planTrip("trip to munnar", { hitl: new Hitl(["nature", "", ...TRANSPORT_AND_CONFIRM]) }); // interests, exclude
  expect(result.requirements.interests).toEqual(["nature"]);
});

it("does not ask again when extraction already said there is no budget limit or no interests", async () => {
  script.state.extraction = { ...FULL, budget: null, interests: [] }; // both explicitly given, not merely omitted
  // Only the exclude question is left before transport/confirm; if a fixed budget/interests re-ask were
  // still asked, one of these answers would be consumed early and the run would fall through to the real
  // terminal for the field it never got and hang instead of completing.
  const result = await planTrip("trip to munnar", { hitl: new Hitl(["", ...TRANSPORT_AND_CONFIRM]) });
  expect(result.requirements.budget).toBeNull();
  expect(result.requirements.interests).toEqual([]);
});

it("asks what to avoid when not already said, and applies it to the place agent's searches", async () => {
  script.state.extraction = { ...FULL, budget: 30000, interests: ["nature"] };
  await planTrip("trip to munnar", { hitl: new Hitl(["temples, seafood", ...TRANSPORT_AND_CONFIRM]) });
  const placeSearches = script.state.calls.filter((c) => c.name === "places_search");
  expect(placeSearches[0].args.exclude).toEqual(["temples", "seafood"]);
});

it("skips the avoid-question when the user already said it in their first message", async () => {
  script.state.extraction = { ...FULL, budget: 30000, interests: ["nature"], exclude: ["temples"] };
  await planTrip("no temples, trip to munnar", { hitl: new Hitl(TRANSPORT_AND_CONFIRM) });
  const placeSearches = script.state.calls.filter((c) => c.name === "places_search");
  expect(placeSearches[0].args.exclude).toEqual(["temples"]);
});

it("re-asks a required field the user answered badly, with the schema's error message, until it's valid", async () => {
  script.state.extraction = { destination: "Munnar" }; // source, start_date, num_days, num_travellers all missing
  const result = await planTrip("trip to munnar", {
    hitl: new Hitl([
      "Bangalore", // source
      "2020-01-01", "2026-10-02", // start_date: past, then valid
      "0", "2", // num_days: too low, then valid
      "2", // num_travellers
      "", "", "", // budget, interests, exclude
      ...TRANSPORT_AND_CONFIRM,
    ]),
  });
  expect(result.requirements.source).toBe("Bangalore");
  expect(result.requirements.start_date).toBe("2026-10-02");
  expect(result.requirements.num_days).toBe(2);
});
