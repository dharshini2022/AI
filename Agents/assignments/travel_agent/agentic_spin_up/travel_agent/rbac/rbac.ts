export type Role = "user" | "admin";

export interface Principal {
  id: string;
  role: Role;
}

const USER_PERMISSIONS = [
  "places_search",
  "restaurants_search",
  "accommodation_search",
  "weather_search",
  "transport_search",
  "set_indoor_mode",
  "choose_transport",
  "ask_user",
  "update_preferences",
  "request_place_edit",
  "present_plan",
  "launch_subagent",
  "wait_for_subagents",
  "check_subagent_status",
  "send_message_to_subagent",
  "stop_subagent",
  "load_skill",
  "extract_requirements"
];

const PERMISSIONS: Record<Role, Set<string>> = {
  user: new Set(USER_PERMISSIONS),
  admin: new Set([...USER_PERMISSIONS, "book_transportation"]),
};

export function can(principal: Principal, action: string): boolean {
  return PERMISSIONS[principal.role]?.has(action) ?? false;
}

export function resolvePrincipal(options?: { role?: Role; id?: string }): Principal {
  const envRole = process.env.ROLE?.toLowerCase() as Role | undefined;
  const role: Role = options?.role ?? (envRole === "admin" ? "admin" : "user");
  const id = options?.id ?? (role === "admin" ? "admin-1" : "user-1");
  return { id, role };
}
