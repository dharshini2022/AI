import { beforeEach, describe, expect, it, vi } from "vitest";

// SpinUp's lifecycle with a scripted LLM: every sub-agent turn records the message it received per session
// (thread_id), waits `delayMs` (abortable), then replies from `replies` or throws `fail`.
const script = vi.hoisted(() => {
  type Behaviour = { delayMs?: number; replies?: Record<string, unknown>[]; fail?: string };
  const state = {
    behaviours: {} as Record<string, Behaviour>,
    threads: new Map<string, string[]>(),
    checkpointers: [] as unknown[],
  };

  function fakeCreateAgent({ systemPrompt = "", checkpointer }: { systemPrompt?: string; checkpointer?: unknown }) {
    state.checkpointers.push(checkpointer);
    const role = systemPrompt.includes("transport research specialist") ? "transport" : "place";
    return {
      async invoke(input: { messages: { content: string }[] }, config: { configurable: { thread_id: string }; signal?: AbortSignal }) {
        const history = state.threads.get(config.configurable.thread_id) ?? [];
        history.push(input.messages.at(-1)!.content);
        state.threads.set(config.configurable.thread_id, history);

        const behaviour = state.behaviours[role] ?? {};
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(resolve, behaviour.delayMs ?? 0);
          config.signal?.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(config.signal!.reason);
          }, { once: true });
        });
        if (behaviour.fail) throw new Error(behaviour.fail);
        const replies = behaviour.replies ?? [{ done: true }];
        const reply = replies[Math.min(history.length - 1, replies.length - 1)];
        return { messages: [{ content: JSON.stringify(reply) }] };
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
  return { ...mod, settings: { ...mod.settings, subagentMaxClarifications: 2, subagentWaitTimeoutMs: 5000 } };
});

const { SpinUp } = await import("../travel_agent/spinUp.ts");
const { Scratchpad } = await import("../travel_agent/scratchpad.ts");

const mcp = { langchainTools: () => [] } as any;
const newSpin = () => new SpinUp(mcp, (tools) => ({ tools: Object.keys(tools) }), { id: "user-1", role: "user" }, new Scratchpad());
const toolsOf = (spin: InstanceType<typeof SpinUp>) => Object.fromEntries(spin.langchainTools().map((t) => [t.name, t])) as Record<string, any>;

beforeEach(() => {
  script.state.behaviours = {};
  script.state.threads.clear();
  script.state.checkpointers = [];
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("the Main Agent can never launch itself as a sub-agent", () => {
  it("is not offered in launch_subagent's description", async () => {
    const tools = toolsOf(newSpin());
    expect(tools.launch_subagent.description).not.toContain("main_agent");
    expect(tools.launch_subagent.description).toContain("place_agent");
  });

  it("a launch attempt is rejected, not run, even if the name is given directly", async () => {
    const spin = newSpin();
    const launched = await toolsOf(spin).launch_subagent.invoke({ spec_name: "main_agent", task: {} });
    expect(launched).toMatchObject({ error: expect.stringContaining("cannot be launched") });
    expect(() => spin.launch("main_agent", {})).toThrow("cannot be launched");
  });
});

describe("launch now, collect later", () => {
  it("launch_subagent returns a task id immediately while the sub-agent keeps running", async () => {
    script.state.behaviours.place = { delayMs: 200 };
    const spin = newSpin();
    const tools = toolsOf(spin);

    const started = performance.now();
    const launched = await tools.launch_subagent.invoke({ spec_name: "place_agent", task: { destination: "Munnar" } });
    expect(performance.now() - started).toBeLessThan(100);
    expect(launched).toMatchObject({ task_id: "place_agent-1", status: "running" });

    const [status] = await tools.check_subagent_status.invoke({ task_ids: ["place_agent-1"] });
    expect(status.status).toBe("running");

    const [result] = await tools.wait_for_subagents.invoke({});
    expect(result).toMatchObject({ task_id: "place_agent-1", status: "done", turns: 1 });
  });

  it("sub-agents launched in separate calls still run at the same time", async () => {
    script.state.behaviours = { transport: { delayMs: 200 }, place: { delayMs: 200 } };
    const spin = newSpin();
    const started = performance.now();
    spin.launch("transportation_agent", {});
    spin.launch("place_agent", {});
    const tasks = await spin.wait();
    expect(tasks.map((t) => t.status)).toEqual(["done", "done"]);
    expect(performance.now() - started).toBeLessThan(350);
  });

  it("wait until 'any' returns as soon as the first sub-agent finishes", async () => {
    script.state.behaviours = { transport: { delayMs: 30 }, place: { delayMs: 400 } };
    const spin = newSpin();
    spin.launch("transportation_agent", {});
    spin.launch("place_agent", {});
    const started = performance.now();
    const tasks = await spin.wait(null, { until: "any" });
    expect(performance.now() - started).toBeLessThan(300);
    expect(tasks.map((t) => t.status)).toEqual(["done", "running"]);
    await spin.wait();
  });

  it("a failing sub-agent becomes a failed status instead of an exception", async () => {
    script.state.behaviours.transport = { fail: "SerpAPI exploded" };
    const spin = newSpin();
    spin.launch("transportation_agent", {});
    const [task] = await spin.wait();
    expect(task).toMatchObject({ status: "failed", error: "SerpAPI exploded" });
  });

  it("an unknown task id is reported to the Main Agent as an error", async () => {
    const tools = toolsOf(newSpin());
    expect(await tools.send_message_to_subagent.invoke({ task_id: "nope-1", message: "hi" })).toEqual({
      error: "Unknown sub-agent task 'nope-1'",
    });
  });
});

describe("sub-agent memory and messages", () => {
  it("every sub-agent is created with a checkpointer", () => {
    const spin = newSpin();
    spin.launch("place_agent", {});
    expect(script.state.checkpointers[0]).toBeDefined();
  });

  it("a question is answered by continuing the same session", async () => {
    script.state.behaviours.place = {
      replies: [{ done: false, needs_clarification: "No stays under ₹1,000 — relax the limit?" }, { done: true }],
    };
    const spin = newSpin();
    const tools = toolsOf(spin);
    spin.launch("place_agent", { destination: "Munnar" });

    const [asked] = await tools.wait_for_subagents.invoke({});
    expect(asked).toMatchObject({ status: "needs_clarification", question: "No stays under ₹1,000 — relax the limit?" });

    await tools.send_message_to_subagent.invoke({ task_id: "place_agent-1", message: "Yes, up to ₹2,000." });
    const [answered] = await tools.wait_for_subagents.invoke({});
    expect(answered).toMatchObject({ status: "done", turns: 2 });
    expect(script.state.threads.get("place_agent-1")).toEqual([JSON.stringify({ destination: "Munnar" }), "Yes, up to ₹2,000."]);
  });

  it("a comment sent while the sub-agent is busy is delivered as its next turn", async () => {
    script.state.behaviours.place = { delayMs: 150 };
    const spin = newSpin();
    const tools = toolsOf(spin);
    spin.launch("place_agent", {});

    expect(await tools.send_message_to_subagent.invoke({ task_id: "place_agent-1", message: "Prefer vegetarian food." }))
      .toMatchObject({ status: "running", queued_messages: 1 });

    const [task] = await spin.wait();
    expect(task).toMatchObject({ status: "done", turns: 2 });
    expect(script.state.threads.get("place_agent-1")?.[1]).toBe("Prefer vegetarian food.");
  });

  it("stop_subagent cancels the running turn and drops queued messages", async () => {
    script.state.behaviours.place = { delayMs: 2000 };
    const spin = newSpin();
    const tools = toolsOf(spin);
    spin.launch("place_agent", {});
    spin.send("place_agent-1", "queued comment");

    const started = performance.now();
    expect(await tools.stop_subagent.invoke({ task_id: "place_agent-1", reason: "user changed destination" }))
      .toMatchObject({ stop_requested: true });
    const [task] = await spin.wait();

    expect(performance.now() - started).toBeLessThan(500);
    expect(task).toMatchObject({ status: "stopped", error: "user changed destination", inbox: [] });
    expect(script.state.threads.get("place_agent-1")).toHaveLength(1);
  });

  it("too many clarification requests fail the task", async () => {
    script.state.behaviours.place = { replies: [{ done: false, needs_clarification: "Which one?" }] };
    const spin = newSpin();
    spin.launch("place_agent", {});
    await spin.wait();
    spin.send("place_agent-1", "answer 1");
    await spin.wait();
    spin.send("place_agent-1", "answer 2");
    const [task] = await spin.wait();
    expect(task.status).toBe("failed");
    expect(task.error).toContain("beyond the limit of 2");
  });
});
