import { Hitl } from "./travel_agent/hitl.ts";
import { planTrip } from "./travel_agent/mainAgent.ts";
import { type Role, resolvePrincipal } from "./travel_agent/rbac/rbac.ts";
import { StdinChannel } from "./travel_agent/stdin.ts";

const rawArgs = process.argv.slice(2);
const isAdmin = rawArgs.includes("--admin") || rawArgs.some((a) => a.toLowerCase().startsWith("--role=admin"));
const filteredArgs = rawArgs.filter((a) => a !== "--admin" && !a.toLowerCase().startsWith("--role="));

const role: Role = isAdmin ? "admin" : (process.env.ROLE?.toLowerCase() === "admin" ? "admin" : "user");
const principal = resolvePrincipal({ role });

const stdin = new StdinChannel();
const hitl = new Hitl([], stdin);
const request = filteredArgs.join(" ").trim() || (await stdin.nextLine("Describe your trip: "));

if (request) await planTrip(request, { hitl, stdin, principal });
else console.log("nothing to plan");

stdin.close();

