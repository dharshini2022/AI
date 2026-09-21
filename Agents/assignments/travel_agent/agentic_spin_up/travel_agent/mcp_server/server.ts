import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { TOOLS } from "./handlers.ts";

const server = new McpServer({ name: "trip-planner-tools", version: "1.0.0" }, { capabilities: { logging: {} } });

const log = (data: string) => server.sendLoggingMessage({ level: "info", data });

for (const [name, tool] of Object.entries(TOOLS)) {
  server.registerTool(name, { description: tool.description, inputSchema: tool.inputSchema }, async (args: any) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await tool.run(args, log)) }],
  }));
}

await server.connect(new StdioServerTransport());
