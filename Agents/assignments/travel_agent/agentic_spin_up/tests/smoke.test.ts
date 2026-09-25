import { expect, it, vi } from "vitest";

// A scripted createAgent plays all three roles (transport sub-agent, place sub-agent, Main Agent)
// through the real plumbing: MCP server subprocess, launch/wait, choose_transport, merge_plan, budget_check.
// Sub-agents only reply {"done": true}; the plan must come from their recorded tool results.
const { fakeCreateAgent } = vi.hoisted(() => {
  const done = () => ({ messages: [{ content: JSON.stringify({ done: true }) }] });

  function fakeCreateAgent({ tools = [], systemPrompt = "" }: { tools?: any[]; systemPrompt?: string }) {
    const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
    let mainTurn = 0;
    return {
      async invoke({ messages }: { messages: { content: string }[] }) {
        const userMsg = messages.at(-1)!.content;
        const task = userMsg.trim().startsWith("{") ? JSON.parse(userMsg) : {};

        if (systemPrompt.includes("transport research specialist")) {
          await byName.transport_search.invoke({
            source: task.source, destination: task.destination,
            start_date: task.start_date, travellers: task.travellers ?? 1,
          });
          return done();
        }

        if (systemPrompt.includes("destination research specialist")) {
          const numDays = task.num_days ?? 2;
          await Promise.all([
            byName.weather_search.invoke({ destination: task.destination, num_days: numDays, start_date: task.start_date ?? "" }),
            byName.places_search.invoke({ destination: task.destination, interests: task.interests ?? [], indoor_only: false }),
            byName.restaurants_search.invoke({ destination: task.destination, interests: task.interests ?? [] }),
            byName.accommodation_search.invoke({
              destination: task.destination, travellers: task.travellers ?? 1,
              start_date: task.start_date ?? "", nights: Math.max(1, numDays - 1),
            }),
          ]);
          return done();
        }

        const req = {
          source: "Bangalore", destination: "Munnar", start_date: "2026-10-02",
          num_days: 3, num_travellers: 2, interests: ["adventure", "nature"], budget: 40000, exclude: [],
        };

        // The Main Agent's own session: turn 1 extracts everything (nothing left for the intake loop to
        // ask), so turn 2 arrives already carrying "Requirements saved:" from the application code.
        mainTurn++;
        if (mainTurn === 1) {
          await byName.extract_requirements.invoke(req);
          return { messages: [{ content: JSON.stringify({ done: false }) }] };
        }

        await byName.launch_subagent.invoke({
          spec_name: "transportation_agent",
          task: {
            source: req.source, destination: req.destination, start_date: req.start_date,
            travellers: req.num_travellers, budget_cap: req.budget,
          },
        });
        await byName.launch_subagent.invoke({
          spec_name: "place_agent",
          task: {
            destination: req.destination, interests: req.interests, num_days: req.num_days,
            start_date: req.start_date, travellers: req.num_travellers,
          },
        });
        await byName.wait_for_subagents.invoke({});
        await byName.choose_transport.invoke({});
        await byName.present_plan.invoke({});
        await byName.ask_user.invoke({ question: "Press Enter to confirm." });
        return { messages: [{ content: JSON.stringify({ confirmed: true }) }] };
      },
    };
  }
  return { fakeCreateAgent };
});

vi.mock("langchain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("langchain")>()),
  createAgent: fakeCreateAgent,
}));

const { Hitl } = await import("../travel_agent/hitl.ts");
const { planTrip } = await import("../travel_agent/mainAgent.ts");

it("happy path produces an itinerary and a budget", async () => {
  // "1": cheapest transport; "" confirms the plan at the final prompt.
  const result = await planTrip("trip from Bangalore to Munnar", { hitl: new Hitl(["1", "1", ""]) });
  const itinerary = result.itinerary;
  expect(itinerary.route).toBe("Bangalore → Munnar");
  expect(itinerary).toHaveProperty("transport");
  expect(itinerary.cards).toHaveLength(3);
  const budget = result.budget_status;
  expect(budget).toHaveProperty("total");
  expect(budget).toHaveProperty("ok");
  expect(budget.cap).toBe(40000);
  expect(result.subagent_tasks.map((t: any) => t.status)).toEqual(["done", "done"]);
});
