import { ToolMessage } from "@langchain/core/messages";
import type { AnyAgentMiddleware } from "langchain";
import { type Principal, canAccess } from "./rbac.ts";

export function createRbacMiddleware(principal: Principal): AnyAgentMiddleware {
  //returns a LangChain Middleware
  return {
    name: "RbacAuthorizationMiddleware",
    wrapToolCall: async (request: any, handler: any) => {
      const toolName = request?.toolCall?.name ?? "";
      // Check authorization
      if (!canAccess(principal, toolName)) {
        console.warn(`  [Main Agent] [RBAC] Denied: Role '${principal.role}' cannot execute '${toolName}'`);
        //return ToolMessage as ToolError for unauthorized calls
        return new ToolMessage({
          content: `Permission denied: Role '${principal.role}' is not authorized to execute '${toolName}'. Only admin can perform this action.`,
          name: toolName,
          tool_call_id: request.toolCall.id,
          status: "error",
        });
      }
      // Proceed: Call next handler in chain
      return await handler(request);
    },
  };
}
