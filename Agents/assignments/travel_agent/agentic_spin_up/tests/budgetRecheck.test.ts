import { beforeEach, describe, expect, it, vi } from "vitest";

// Offline end-to-end: real Main Agent code, SpinUp sessions, LangChain tool wrappers and MCP tool handlers
// (run in-process), with a scripted LLM and canned HTTP responses. The fake sub-agents keep per-session
// history by thread_id, the way the real checkpointer does.
const script = vi.hoisted(() => {
  const state = {
    budget: 0 as number | null,
    askOnRecheck: false,
    feedback: [] as any[],
    historyAtRecheck: [] as number[],
    answers: [] as string[],
    threads: new Map<string, string[]>(),
  };
  const reply = (value: unknown) => ({ messages: [{ content: JSON.stringify(value) }] });

  function fakeCreateAgent({ tools = [], systemPrompt = "" }: { tools?: any[]; systemPrompt?: string }) {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    return {
      async invoke({ messages }: { messages: { content: string }[] }, config?: { configurable?: { thread_id?: string } }) {
        const content = messages.at(-1)!.content;
        const threadId = config?.configurable?.thread_id;
        const history = threadId ? (state.threads.get(threadId) ?? []) : [];
        history.push(content);
        if (threadId) state.threads.set(threadId, history);
        const message = content.trim().startsWith("{") ? JSON.parse(content) : {};
        // "main" is the Main Agent's own session (a plain-text request, not a task payload); every other
        // thread is a sub-agent's, whose first message is always the JSON task it was launched with.
        const task = threadId && threadId !== "main" ? JSON.parse(history[0]) : message;

        if (systemPrompt.includes("transport research specialist")) {
          await byName.transport_search.invoke({
            source: task.source, destination: task.destination, start_date: task.start_date, travellers: task.travellers,
          });
          return reply({ done: true });
        }

        if (systemPrompt.includes("destination research specialist")) {
          if (message.budget_feedback) {
            const fb = message.budget_feedback;
            state.feedback.push(fb);
            state.historyAtRecheck.push(history.length);
            if (state.askOnRecheck) return reply({ done: false, needs_clarification: "Cut food or stays?" });

            if (fb.lever === "accommodation") {
              // The "LLM" tries a cheaper stay within reach of the day centres it was given.
              const search = await byName.accommodation_search.invoke({
                destination: task.destination, travellers: task.travellers, start_date: task.start_date, nights: task.num_days - 1,
                max_price_per_night: Math.max(0, fb.current_choices.accommodation.price_per_night - 1),
                near: fb.day_centers,
              });
              const [cheapest] = search.accommodation_options ?? [];
              if (search.no_candidates_in_radius || !cheapest || cheapest.name === fb.current_choices.accommodation.name) {
                return reply({ done: true, notes: "No cheaper stay found." });
              }
              await byName.propose_change.invoke({ kind: "accommodation", replace: fb.current_choices.accommodation.name, with: cheapest.name });
              return reply({ done: true });
            }

            // lever "places" or the unscoped "any": the "LLM" decides where to cut — cheaper meals only.
            // Only the currently most expensive meal is a candidate, so a repeat visit that finds nothing
            // cheaper than what's already live converges instead of proposing the same swap forever.
            const priciest = fb.current_choices.meals.reduce((a: any, b: any) => (b.est_cost > a.est_cost ? b : a));
            const search = await byName.restaurants_search.invoke({ destination: task.destination, interests: [], max_cost_per_person: priciest.est_cost - 1 });
            const cheaperMeal = (["Breakfast", "Lunch", "Dinner"] as const).flatMap((m) => search[m] ?? []).find((r: any) => r.name !== priciest.name);
            if (!cheaperMeal) return reply({ done: true, notes: "No cheaper meal found." });
            await byName.propose_change.invoke({ kind: "restaurant", replace: priciest.name, with: cheaperMeal.name });
            return reply({ done: true });
          } else if (history.length > 1) {
            state.answers.push(content);
            // Continuing after a needs_clarification answer: same cut as above (cheaper meals), proposed
            // and committed the same way.
            const priciest = script.state.feedback.at(-1).current_choices.meals.reduce((a: any, b: any) => (b.est_cost > a.est_cost ? b : a));
            const search = await byName.restaurants_search.invoke({ destination: task.destination, interests: [], max_cost_per_person: priciest.est_cost - 1 });
            const cheaperMeal = (["Breakfast", "Lunch", "Dinner"] as const).flatMap((m) => search[m] ?? []).find((r: any) => r.name !== priciest.name);
            if (cheaperMeal) await byName.propose_change.invoke({ kind: "restaurant", replace: priciest.name, with: cheaperMeal.name });
            return reply({ done: true });
          }
          await Promise.all([
            byName.weather_search.invoke({ destination: task.destination, num_days: task.num_days, start_date: task.start_date }),
            byName.places_search.invoke({ destination: task.destination, interests: task.interests, indoor_only: false }),
            byName.restaurants_search.invoke({ destination: task.destination, interests: task.interests }),
            byName.accommodation_search.invoke({
              destination: task.destination, travellers: task.travellers, start_date: task.start_date, nights: task.num_days - 1,
            }),
          ]);
          return reply({ done: true });
        }

        const requirements = {
          source: "Bangalore", destination: "Munnar", start_date: "2026-10-02",
          num_days: 3, num_travellers: 2, interests: ["tea"], budget: state.budget, exclude: [],
        };

        // The Main Agent's own session: turn 1 extracts everything (nothing left for the intake loop to
        // ask), so turn 2 arrives already carrying "Requirements saved:" from the application code.
        if (history.length === 1) {
          await byName.extract_requirements.invoke(requirements);
          return reply({ done: false });
        }

        await byName.launch_subagent.invoke({
          spec_name: "transportation_agent",
          task: { source: "Bangalore", destination: "Munnar", start_date: "2026-10-02", travellers: 2, budget_cap: state.budget },
        });
        await byName.launch_subagent.invoke({
          spec_name: "place_agent",
          task: { destination: "Munnar", interests: ["tea"], num_days: 3, start_date: "2026-10-02", travellers: 2 },
        });
        await byName.wait_for_subagents.invoke({});
        await byName.choose_transport.invoke({});
        // The confirm loop: any typed answer is treated as "recheck the budget"; Enter confirms.
        await byName.present_plan.invoke({});
        while ((await byName.ask_user.invoke({ question: "Press Enter to confirm." })).answer) {
          await byName.present_plan.invoke({ recheck_budget: true });
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
      const t = TOOLS[name];
      return JSON.parse(JSON.stringify(await t.run(z.object(t.inputSchema).parse(args), () => {})));
    }
  }
  return { ...mod, McpTools: InProcessMcpTools };
});

const { settings } = await import("../travel_agent/config.ts");
const { Hitl } = await import("../travel_agent/hitl.ts");
const { planTrip, checkResearchCompleteness } = await import("../travel_agent/mainAgent.ts");

const mutableSettings = settings as { budgetRetryLimit: number };
const meals = (itinerary: any): string[] => itinerary.cards.flatMap((c: any) => c.meals.map((m: any) => m.name));

beforeEach(() => {
  Object.assign(script.state, { askOnRecheck: false, feedback: [], historyAtRecheck: [], answers: [] });
  script.state.threads.clear();
  mutableSettings.budgetRetryLimit = 2;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("budget re-check", () => {
  it("does nothing when the plan is within budget", async () => {
    script.state.budget = 999_999;
    const result = await planTrip("trip", { hitl: new Hitl(["1", "1", ""]) });
    expect(result.budget_status.ok).toBe(true);
    expect(result.budget_attempts).toEqual([]);
    expect(script.state.feedback).toEqual([]);
  });

  // The over-budget menu now shows on its own as soon as the first plan is over budget — no recheck_budget
  // request needed — and there's no automatic cut before it (current_implementation.md decisions 2-3).
  // Picking "Change a place to something cheaper" (menu index 0) is what drives a budget_feedback re-check.
  it("continues the place agent's own session with budget feedback, stops without progress, then lets the user proceed", async () => {
    script.state.budget = 1000;
    // outbound, return, menu round1:"places" (2 attempts inside — improves then plateaus), menu round2:
    // "places" again (no saving this time → dropped from the menu), menu round3:"proceed", confirm.
    const result = await planTrip("trip", { hitl: new Hitl(["1", "1", "1", "1", "9", ""]) });

    const [first, second] = script.state.feedback;
    expect(first).toMatchObject({ attempt: 1, cap: 1000, lever: "places", transport_fixed: true });
    expect(first.breakdown).toHaveProperty("food");
    expect(first.current_choices.meals.length).toBeGreaterThan(0);
    expect(second.attempt).toBe(2); // same recheckBudget call, its second (of budgetRetryLimit=2) attempt

    expect(result.budget_attempts[0].total).toBeLessThan(first.total);
    expect(meals(result.itinerary)).not.toContain("Guru's Restaurant");
    expect(result.budget_status.ok).toBe(false);
  });

  it("sends a question raised during a re-check to the user and continues with the answer", async () => {
    script.state.budget = 1000;
    script.state.askOnRecheck = true;
    mutableSettings.budgetRetryLimit = 1;
    // outbound, return, menu:"places" (1 attempt, asks a clarifying question), menu:"proceed", confirm
    const result = await planTrip("trip", { hitl: new Hitl(["1", "1", "1", "Cut food", "9", ""]) });
    expect(script.state.answers).toEqual(["Cut food"]);
    expect(meals(result.itinerary)).not.toContain("Guru's Restaurant");
  });

  it("respects BUDGET_RETRY_LIMIT", async () => {
    script.state.budget = 1000;
    mutableSettings.budgetRetryLimit = 1;
    const result = await planTrip("trip", { hitl: new Hitl(["1", "1", "1", "9", ""]) });
    expect(result.budget_attempts).toHaveLength(1);
    expect(script.state.feedback).toHaveLength(1);
  });

  it("lets the user switch to a cheaper transport from the over-budget menu, with a before/after box to approve", async () => {
    script.state.budget = 1000;
    // outbound(2nd cheapest), return, menu:"transport" → re-pick outbound(cheapest)/return, apply? yes,
    // menu round2:"proceed", confirm
    const hitl = new Hitl(["2", "1", "2", "1", "1", "yes", "9", ""]);
    const result = await planTrip("trip", { hitl });
    const [cheapest] = result.flights_result.options;
    expect(result.itinerary.transport.option).toBe(cheapest.option);
  });

  it("keeps the current transport when the user rejects the switch three times", async () => {
    script.state.budget = 1000;
    const hitl = new Hitl([
      "2", "1", "2", // outbound(2nd cheapest), return, menu:"transport"
      "1", "1", "no", // try 1: re-pick cheapest, reject
      "1", "1", "no", // try 2: same, reject
      "1", "1", "no", // try 3: same, reject → gives up, asks the user
      "", // the "kept your current transport" notice
      "9", "", // menu round2:"proceed", confirm
    ]);
    const askYesNo = vi.spyOn(hitl, "askYesNo");
    const result = await planTrip("trip", { hitl });
    expect(askYesNo).toHaveBeenCalledTimes(3);
    expect(result.itinerary.transport.option).toBe(result.flights_result.options[1].option);
  });

  it("shows the over-budget menu on its own when the picked transport option is expensive enough", async () => {
    script.state.budget = 30_000;
    // Munnar has no railhead, so the list has four options — the priciest (index 3) tips this trip over budget.
    const hitl = new Hitl(["4", "4", "1", "9", ""]); // outbound, return, menu:"places", menu:"proceed", confirm
    const askChoice = vi.spyOn(hitl, "askChoice");
    const result = await planTrip("trip", { hitl });

    expect(askChoice.mock.calls[0][1]).toHaveLength(4);
    expect(result.itinerary.transport.option).toBe(result.flights_result.options[3].option);
    expect(script.state.feedback.length).toBeGreaterThan(0);
  });
});

describe("choose_transport", () => {
  it("labels every option, in order, by fare only — no per-option budget total", async () => {
    script.state.budget = 999_999;
    const hitl = new Hitl(["1", "1", ""]);
    const askChoice = vi.spyOn(hitl, "askChoice");
    const result = await planTrip("trip", { hitl });

    const [, labels] = askChoice.mock.calls[0];
    expect(labels).toHaveLength(result.flights_result.options.length);
    labels.forEach((label: string, i: number) => {
      const opt = result.flights_result.options[i];
      expect(label).toContain(`[${opt.mode}] ${opt.option}`);
      expect(label).not.toContain("trip total");
      expect(label).not.toContain("budget");
    });
  });

  it("then asks for the return option, and records the pair that was picked", async () => {
    script.state.budget = 999_999;
    const hitl = new Hitl(["1", "2", ""]);
    const askChoice = vi.spyOn(hitl, "askChoice");
    const result = await planTrip("trip", { hitl });

    const [returnPrompt, returnLabels] = askChoice.mock.calls[1];
    expect(returnPrompt).toContain("return transport");
    expect(returnLabels).toHaveLength(result.flights_result.return_options.length);
    expect(result.flights_result.selected_return).toBe(result.flights_result.return_options[1]);
    expect(result.itinerary.return_transport.option).toBe(result.flights_result.return_options[1].option);
    expect(result.itinerary.transport.option).toBe(result.flights_result.options[0].option);
  });

  it("totals the two chosen fares, not the outbound fare twice, when the legs differ", async () => {
    script.state.budget = 999_999;
    const same = await planTrip("trip", { hitl: new Hitl(["1", "1", ""]) });
    const last = same.flights_result.return_options.length;
    script.state.threads.clear(); // a fresh trip: the scripted place agent starts its conversation again
    const mixed = await planTrip("trip", { hitl: new Hitl(["1", String(last), ""]) });

    const { options, return_options } = mixed.flights_result;
    const fare = (o: any) => o.price;
    expect(mixed.budget_status.breakdown.transport).toBe(fare(options[0]) + fare(return_options[last - 1]));
    expect(mixed.budget_status.total - same.budget_status.total).toBe(fare(return_options[last - 1]) - fare(return_options[0]));
  });
});

describe("checkResearchCompleteness", () => {
  it("detects missing research slices and validates complete state", () => {
    const emptyState = {
      requirements: {},
      weather: {},
      places: [],
      restaurants: {},
      accommodation_options: [],
      selectedAccommodation: {},
      transport_options: [],
      selectedTransport: {},
      indoor_mode: false,
      weather_declined: false,
    };
    const check = checkResearchCompleteness(emptyState);
    expect(check.complete).toBe(false);
    expect(check.missing).toEqual(["places_search", "accommodation_search", "restaurants_search"]);

    const populatedState = {
      ...emptyState,
      places: [{ name: "Tea Museum" }],
      restaurants: { lunch: [{ name: "Cafe" }] },
      accommodation_options: [{ name: "Hotel" }],
    };
    expect(checkResearchCompleteness(populatedState)).toEqual({ complete: true, missing: [] });
  });
});

