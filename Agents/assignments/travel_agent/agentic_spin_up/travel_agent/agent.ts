// Defines Agent object invokation using custom Agent Class and create agent

import { Command, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { AnyAgentMiddleware, HITLRequest, HITLResponse } from "langchain";
import { createAgent, dynamicSystemPromptMiddleware } from "langchain";
import { settings } from "./config.ts";
import { getChatModel } from "./llm.ts";
import type { McpTools, ToolGuard, ToolResultHandler } from "./mcpClient.ts";
import type { Principal } from "./rbac/rbac.ts";
import { createRbacMiddleware } from "./rbac/rbacMiddleware.ts";
import { createLoadSkillTool, skillCatalog } from "./skillLoader.ts";
import type { AgentSpec } from "./specs.ts";
import { type Dict, isDict, pyTitle } from "./tools/util.ts";

export function parseJson(text: string): any {
  const t = text.trim().replace(/^```json/, "").replace(/^```/, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(t);
  } catch (err) {
    const [start, end] = [t.indexOf("{"), t.lastIndexOf("}")];
    if (start !== -1 && end > start) return JSON.parse(t.slice(start, end + 1));
    throw err;
  }
}

export function lastMessageText(response: { messages?: { content?: unknown }[] }): string {
  const content = response.messages?.at(-1)?.content ?? "";
  if (Array.isArray(content)) return content.map((c) => (isDict(c) ? (c.text ?? "") : String(c))).join("");
  return String(content);
}

function systemPrompt(spec: AgentSpec): string {
  const withSkills = spec.body + skillCatalog(spec.skills);
  if (!spec.output) return withSkills;
  return `${withSkills}\n\nWhen you finish a turn, reply with ONLY a JSON object of this shape and nothing else:\n${spec.output}`;
}

// A sub-agent session: built once from its spec, then run one turn at a time. The checkpointer keeps the
// conversation under `sessionId`, so every later message continues where the previous turn ended.
export class Agent {
  private graph: ReturnType<typeof createAgent>;
  private sessionId: string;
  private resolveInterrupt?: (request: HITLRequest) => Promise<HITLResponse>;

  constructor(
    spec: AgentSpec,
    mcp: McpTools,
    {
      sessionId,
      checkpointer,
      principal,
      onToolResult,
      guard,
      facts,
      tools,
      middleware,
      resolveInterrupt,
    }: {
      sessionId: string;
      checkpointer: BaseCheckpointSaver;
      principal: Principal;
      onToolResult?: ToolResultHandler;
      guard?: ToolGuard;
      facts?: () => string; // appended to the system prompt on every model call
      tools?: unknown[];
      middleware?: AnyAgentMiddleware[];
      resolveInterrupt?: (request: HITLRequest) => Promise<HITLResponse>;
    },
  ) {
    this.sessionId = sessionId;
    this.resolveInterrupt = resolveInterrupt;
    const baseTools = tools ?? mcp.langchainTools(spec.tools, pyTitle(spec.name.replaceAll("_", " ")), onToolResult, guard);
    this.graph = createAgent({
      model: getChatModel({ temperature: spec.temperature, label: spec.name }),
      // The Main Agent passes its own non-MCP tools (ask_user, launch_subagent, ...) explicitly here;
      // every sub-agent still derives its tools from `spec.tools` against the MCP server as before.
      // load_skill is concatenated onto either source, scoped to exactly the skills spec.skills names —
      // never a global namespace an agent could reach beyond its own declared skills.
      tools: [...baseTools, ...(spec.skills.length ? [createLoadSkillTool(spec.skills)] : [])] as never,
      systemPrompt: systemPrompt(spec),
      checkpointer,
      middleware: [
        ...(middleware ?? []),
        ...(facts ? [dynamicSystemPromptMiddleware(facts)] : []),
        createRbacMiddleware(principal),
      ] as never,
    });
  }

  // Returns the turn's short reply; tool results reach the caller through `onToolResult`.
  async send(message: string, signal?: AbortSignal): Promise<Dict> {
    const config = {
      configurable: { thread_id: this.sessionId },
      signal,
      recursionLimit: settings.llmRecursionLimit,
    };
    let response: any = await this.graph.invoke({ messages: [{ role: "user", content: message }] }, config);
    while (response.__interrupt__?.length) {
      if (!this.resolveInterrupt) throw new Error(`Unhandled interrupt on session '${this.sessionId}'`);
      const resume = await this.resolveInterrupt(response.__interrupt__[0].value as HITLRequest);
      response = await this.graph.invoke(new Command({ resume }), config);
    }
    const text = lastMessageText(response);
    try {
      const reply = parseJson(text);
      return isDict(reply) ? reply : { notes: text };
    } catch {
      return { notes: text };
    }
  }
}
