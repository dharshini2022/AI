import type { Dict } from "./tools/util.ts";

export type Role = "user" | "admin";

export interface Principal {
  id: string;
  role: Role;
}

const PERMISSIONS: Record<Role, Set<string>> = {
  user: new Set([
    "places_search",
    "restaurants_search",
    "accommodation_search",
    "weather_search",
    "transport_search",
    "set_indoor_mode",
    "choose_transport",
    "ask_user",
    "launch_subagent",
    "wait_for_subagents",
    "check_subagent_status",
    "send_message_to_subagent",
    "stop_subagent",
  ]),
  admin: new Set([
    // Admin inherits everything from user + privileged booking & overrides
    "places_search",
    "restaurants_search",
    "accommodation_search",
    "weather_search",
    "transport_search",
    "set_indoor_mode",
    "choose_transport",
    "ask_user",
    "launch_subagent",
    "wait_for_subagents",
    "check_subagent_status",
    "send_message_to_subagent",
    "stop_subagent",
    "book_flight",
    "budget_override",
  ]),
};

export function can(principal: Principal, action: string): boolean {
  return PERMISSIONS[principal.role]?.has(action) ?? false;
}

export function assertCan(principal: Principal, action: string): void {
  if (!can(principal, action)) {
    throw new Error(`Permission denied: Role '${principal.role}' is not authorized to execute '${action}'.`);
  }
}

export function resolvePrincipal(options?: { role?: Role; id?: string }): Principal {
  const envRole = process.env.ROLE?.toLowerCase() as Role | undefined;
  const role: Role = options?.role ?? (envRole === "admin" ? "admin" : "user");
  const id = options?.id ?? (role === "admin" ? "admin-1" : "user-1");
  return { id, role };
}
