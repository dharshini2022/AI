import { join } from "node:path";
import type { DynamicStructuredTool } from "@langchain/core/tools";
import { loadMcpTools } from "@langchain/mcp-adapters";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { LoggingMessageNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { tool } from "langchain";
import { PKG_ROOT, ROOT, settings } from "./config.ts";
import { type Limiter, createLimiter } from "./limiter.ts";
import { startTimer } from "./timing.ts";
import { type Dict, isDict } from "./tools/util.ts";

const TOOL_DESCRIPTIONS: Record<string, string> = {
  transport_search: "[transport] Searching transport options (flight / train / bus)",
  weather_search: "[weather] Fetching weather forecast via Open-Meteo",
  places_search: "[place] Discovering top attractions & sights",
  restaurants_search: "[restaurant] Fetching restaurant & dining details",
  accommodation_search: "[accommodation] Searching hotels & accommodation options",
  merge_plan: "[itinerary] Assembling day-by-day itinerary layout",
  budget_check: "[budget] Calculating trip budget & expenses",
};

export type ToolResultHandler = (tool: string, result: unknown, input: Dict) => void;
// Runs before an LLM-issued call: the arguments to actually send, and a notice for the model if any were replaced.
export type ToolGuard = (tool: string, input: Dict) => { input: Dict; notice?: string };

// The server flags an empty result caused by an outage with `search_problem`. The model is told; the recorded
// result stays as the tool produced it, so consumers such as the itinerary builder never see the extra key.
function splitSearchProblem(result: unknown): [unknown, string | undefined] {
  if (!isDict(result) || !("search_problem" in result)) return [result, undefined];
  const { search_problem, ...rest } = result;
  return [rest, String(search_problem)];
}

function defaultCommand(): string[] {
  if (settings.mcpServerCmd) {
    return [...settings.mcpServerCmd.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);
  }
  return [process.execPath, join(ROOT, "mcp_server", "server.ts")];
}

export class McpTools {
  private client = new Client({ name: "trip-planner", version: "1.0.0" });
  private transport: StdioClientTransport;
  private timeoutMs: number;
  private limit: Limiter;
  // Built by @langchain/mcp-adapters from the server's tool list; used for schema conversion only.
  // Concurrency limiting, timing and JSON parsing are ours (see `call`), because afterToolCall does not
  // fire when a tool call fails — confirmed by direct test — so it cannot be trusted to release a limiter slot.
  private tools: DynamicStructuredTool[] = [];

  constructor({
    command = defaultCommand(),
    timeoutMs = 180_000,
    maxConcurrency = settings.mcpMaxConcurrency,
    env = {},
  }: { command?: string[]; timeoutMs?: number; maxConcurrency?: number; env?: Record<string, string> } = {}) {
    this.timeoutMs = timeoutMs;
    this.limit = createLimiter(maxConcurrency);
    this.transport = new StdioClientTransport({
      command: command[0],
      args: command.slice(1),
      cwd: PKG_ROOT,
      env: { ...(process.env as Record<string, string>), ...env },
      stderr: "inherit",
    });
  }

  async open(): Promise<this> {
    this.client.setNotificationHandler(LoggingMessageNotificationSchema, ({ params }) => {
      if (params.data) console.log(`    [MCP Server] ${params.data}`);
    });
    await this.client.connect(this.transport);
    this.tools = await loadMcpTools("trip-planner", this.client, { defaultToolTimeout: this.timeoutMs });
    return this;
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  toolNames(): string[] {
    return this.tools.map((t) => t.name);
  }

  // The one place every MCP tool call goes through — code-issued (merge_plan, budget_check, per-option
  // totals) and LLM-issued (via langchainTools below) alike — so both share the same limiter, timing and
  // JSON parsing, and a failed call cannot leak a limiter slot.
  call(name: string, args: Dict = {}): Promise<any> {
    const target = this.tools.find((t) => t.name === name);
    if (!target) throw new Error(`Unknown MCP tool '${name}'`);
    return this.limit(async () => {
      const done = startTimer(`mcp ${name}`);
      try {
        const text = await target.invoke(args);
        try {
          return JSON.parse(text);
        } catch {
          return text;
        }
      } finally {
        done();
      }
    });
  }

  // `onResult` receives every raw tool result (with the arguments actually sent), so sub-agents never have to
  // repeat data in their replies. `guard` can correct the arguments before the call goes out.
  langchainTools(names: string[] | null = null, agentLabel = "", onResult?: ToolResultHandler, guard?: ToolGuard) {
    return this.tools
      .filter((t) => names === null || names.includes(t.name))
      .map((t) =>
        tool(
          async (raw: Dict) => {
            const { input, notice } = guard ? guard(t.name, raw) : { input: raw, notice: undefined };
            const prefix = agentLabel ? `  [${agentLabel}] ` : "  ";
            console.log(`${prefix}${TOOL_DESCRIPTIONS[t.name] ?? `Calling ${t.name}`} using ${t.name} tool...`);
            const [recorded, problem] = splitSearchProblem(await this.call(t.name, input));
            onResult?.(t.name, recorded, input);
            return notice || problem ? { ...(recorded as Dict), guard_notice: notice, search_problem: problem } : recorded;
          },
          { name: t.name, description: t.description, schema: t.schema },
        ),
      );
  }
}
