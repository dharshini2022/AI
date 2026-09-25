import { describe, expect, it, vi } from "vitest";

// --- Unit tests: the loader against the real travel_agent/agent-skills/ folder. ---

const { loadSkillHeader, loadSkillBody, skillCatalog, createLoadSkillTool } = await import("../travel_agent/skillLoader.ts");

describe("loadSkillHeader", () => {
  it("reads a real skill's frontmatter", () => {
    const header = loadSkillHeader("budget_cut");
    expect(header.name).toBe("budget_cut");
    expect(header.description).toContain("budget_feedback");
  });

  it("throws for a name with no matching folder", () => {
    expect(() => loadSkillHeader("does_not_exist")).toThrow(/no skill 'does_not_exist'/);
  });

  it("rejects a name that looks like a path, before ever touching the filesystem", () => {
    expect(() => loadSkillHeader("../../etc/passwd")).toThrow(/invalid skill name/);
    expect(() => loadSkillHeader("budget_cut/../../secrets")).toThrow(/invalid skill name/);
  });
});

describe("loadSkillBody", () => {
  it("reads a real skill's body", () => {
    const body = loadSkillBody("budget_cut");
    expect(body).toContain("accommodation_search");
    // The description is the routing rule now, so it must never leak into the instructions the model acts on.
    expect(body).not.toContain("Use when a message contains");
  });

  it("throws for a name with no matching folder", () => {
    expect(() => loadSkillBody("does_not_exist")).toThrow(/no skill 'does_not_exist'/);
  });

  it("rejects a name that looks like a path, before ever touching the filesystem", () => {
    expect(() => loadSkillBody("../../etc/passwd")).toThrow(/invalid skill name/);
    expect(() => loadSkillBody("budget_cut/../../secrets")).toThrow(/invalid skill name/);
  });
});

describe("skillCatalog", () => {
  it("lists only the names given, with their descriptions", () => {
    const catalog = skillCatalog(["budget_cut"]);
    expect(catalog).toContain("budget_cut:");
    expect(catalog).not.toContain("apply_user_edit");
  });

  it("lists every name given, in order", () => {
    const catalog = skillCatalog(["budget_cut", "apply_user_edit"]);
    expect(catalog.indexOf("budget_cut:")).toBeLessThan(catalog.indexOf("apply_user_edit:"));
  });

  it("returns an empty string for an agent with no skills, so nothing is appended", () => {
    expect(skillCatalog([])).toBe("");
  });
});

describe("createLoadSkillTool", () => {
  it("returns the full body for a skill in its own allowlist", async () => {
    const tool = createLoadSkillTool(["budget_cut"]);
    const result: any = await tool.invoke({ name: "budget_cut" } as never);
    expect(result.instructions).toContain("accommodation_search");
  });

  it("refuses a skill not in its allowlist, even though the skill file exists on disk", async () => {
    // apply_user_edit is a real skill, but this tool was scoped to budget_cut only — the same shape
    // as spec.tools restricting which MCP tools an agent may call.
    const tool = createLoadSkillTool(["budget_cut"]);
    const result: any = await tool.invoke({ name: "apply_user_edit" } as never);
    expect(result.error).toMatch(/not a skill available/);
  });

  it("refuses path traversal even if the allowlist itself were built from tainted input", async () => {
    const tool = createLoadSkillTool(["../../etc/passwd"]);
    const result: any = await tool.invoke({ name: "../../etc/passwd" } as never);
    expect(result.error).toMatch(/invalid skill name/);
  });

  it("an empty allowlist refuses every name", async () => {
    const tool = createLoadSkillTool([]);
    const result: any = await tool.invoke({ name: "budget_cut" } as never);
    expect(result.error).toMatch(/not a skill available/);
  });
});

// --- Integration: Agent wires the catalog into the prompt and the load_skill tool into the tool list,
// scoped to exactly the spec's own `skills`, without needing a real LLM or MCP server. ---

vi.mock("langchain", async (importOriginal) => {
  const mod = await importOriginal<typeof import("langchain")>();
  return {
    ...mod,
    createAgent: (opts: { tools: { name: string }[]; systemPrompt: string }) => ({
      __opts: opts,
      async invoke() {
        return { messages: [{ content: "{}" }] };
      },
    }),
  };
});

const { Agent } = await import("../travel_agent/agent.ts");
const { MemorySaver } = await import("@langchain/langgraph");

const baseSpec = { name: "spec", description: "", tools: [], body: "base prompt", model: null, temperature: null, output: null };
const mcp = { langchainTools: () => [] } as any;
const principal = { id: "user-1", role: "user" as const };

describe("Agent wiring", () => {
  it("appends the catalog and the load_skill tool when the spec declares skills", () => {
    const spec = { ...baseSpec, skills: ["budget_cut"] };
    const agent = new Agent(spec, mcp, { sessionId: "s1", checkpointer: new MemorySaver(), principal });
    const opts = (agent as any).graph.__opts;

    expect(opts.systemPrompt).toContain("base prompt");
    expect(opts.systemPrompt).toContain("budget_cut:");
    expect(opts.tools.map((t: { name: string }) => t.name)).toContain("load_skill");
  });

  it("adds neither catalog text nor the load_skill tool when the spec declares no skills", () => {
    const spec = { ...baseSpec, skills: [] };
    const agent = new Agent(spec, mcp, { sessionId: "s2", checkpointer: new MemorySaver(), principal });
    const opts = (agent as any).graph.__opts;

    expect(opts.systemPrompt).toBe("base prompt");
    expect(opts.tools.map((t: { name: string }) => t.name)).not.toContain("load_skill");
  });

  it("Main Agent's own explicitly-passed tools are still concatenated with load_skill when it has skills", () => {
    const askUser = { name: "ask_user" };
    const spec = { ...baseSpec, skills: ["apply_user_edit"] };
    const agent = new Agent(spec, mcp, { sessionId: "s3", checkpointer: new MemorySaver(), principal, tools: [askUser] });
    const names = (agent as any).graph.__opts.tools.map((t: { name: string }) => t.name);

    expect(names).toContain("ask_user");
    expect(names).toContain("load_skill");
  });

  it("a load_skill call from this agent can only reach the skills its own spec declared", async () => {
    const spec = { ...baseSpec, skills: ["budget_cut"] };
    const agent = new Agent(spec, mcp, { sessionId: "s4", checkpointer: new MemorySaver(), principal });
    const loadSkill = (agent as any).graph.__opts.tools.find((t: { name: string }) => t.name === "load_skill");

    const own: any = await loadSkill.invoke({ name: "budget_cut" } as never);
    expect(own.instructions).toBeDefined();
    const other: any = await loadSkill.invoke({ name: "apply_user_edit" } as never);
    expect(other.error).toMatch(/not a skill available/);
  });
});
