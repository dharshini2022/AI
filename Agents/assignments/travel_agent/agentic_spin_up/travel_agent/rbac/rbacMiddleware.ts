import { ToolMessage } from "@langchain/core/messages";
import type { AnyAgentMiddleware } from "langchain";
import { type Principal, can } from "./rbac.ts";

export function createRbacMiddleware(principal: Principal): AnyAgentMiddleware {
  return {
    name: "RbacAuthorizationMiddleware",
    wrapToolCall: async (request: any, handler: any) => {
      const toolName = request?.toolCall?.name ?? "";
      if (!can(principal, toolName)) {
        console.warn(`  [Main Agent] [RBAC] Denied: Role '${principal.role}' cannot execute '${toolName}'`);
        return new ToolMessage({
          content: `Permission denied: Role '${principal.role}' is not authorized to execute '${toolName}'. Only admin can perform this action.`,
          name: toolName,
          tool_call_id: request.toolCall.id,
          status: "error",
        });
      }
      return await handler(request);
    },
  };
}
