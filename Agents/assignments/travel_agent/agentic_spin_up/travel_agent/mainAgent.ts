import { MemorySaver } from "@langchain/langgraph";
import { humanInTheLoopMiddleware, tool } from "langchain";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { settings } from "./config.ts";
import { formatBookingBox, formatWeatherBox, Hitl } from "./hitl.ts";
import { McpTools } from "./mcpClient.ts";
import { type Principal, type Role, resolvePrincipal } from "./rbac.ts";
import { createRbacMiddleware } from "./rbacMiddleware.ts";
import type { AgentSpec } from "./specs.ts";
import { SpinUp } from "./spinUp.ts";
import type { StdinChannel } from "./stdin.ts";
import { type BudgetRecheck, bookFlight } from "./tools/index.ts";
import { type Dict, fmtFixed, get, isDict, pyOr, truthy } from "./tools/util.ts";
import { TripRequirementsSchema, isValidFutureDate, validateRequirements } from "./validation.ts";

// Flow: an LLM tool loop gathers requirements, launches the research sub-agents in the background, collects
// their results and asks the user to choose; then code assembles the plan from the sub-agents' recorded tool
// results, re-checks the budget by continuing the place agent's session, and asks the user if it still doesn't fit.

const TRANSPORT = "transportation_agent";
const PLACES = "place_agent";

const SYSTEM = `You are the trip-planning Main Agent. You own ALL interaction with the user;
sub-agents only research and never talk to the user.

Today's date is: ${new Date().toISOString().split("T")[0]}.

STEP 1 — Requirements (STRICT GATE). From the user's message determine:
- source (departure city/location, string)
- destination (destination city, string)
- start_date (YYYY-MM-DD, must be a future date)
- num_days (trip duration in days, integer >= 1)
- num_travellers (number of travellers, integer >= 1)
- interests (list of strings, default to empty list)
- budget (a number in INR, or null for "no limit")

Extract every field you can from the user's message first. Then, for each field that is still
missing or unclear, call the ask_user tool exactly once for that ONE field only
(e.g. "What is your source location?"). Wait for the user's answer before asking
about the next missing field. Never bundle two or more missing fields into a single
question, and never reply with plain assistant text listing what's missing —
every clarification MUST go through the ask_user tool, one field at a time.
Do not guess a value the user didn't give.
Do NOT proceed to STEP 2 or emit the STEP 5 final JSON until ALL required fields above are obtained.

STEP 2 — Research. You MUST call launch_subagent for both specs below before doing
anything else in this step — do not skip straight to STEP 5 once requirements are
complete. Call launch_subagent("transportation_agent", {source, destination,
start_date, travellers, budget_cap}) and launch_subagent("place_agent",
{destination, interests, num_days, start_date, travellers}). Both return a task_id
immediately and keep working in the background. Then call
wait_for_subagents(until="any"): it returns as soon as a sub-agent finishes, asks a
question or fails, and shows every task's current status. Handle what it shows, then
call it again (until="any") until no task is "running" or "needs_clarification".
- If a task has status "needs_clarification", answer its question yourself from the
  requirements when you can, otherwise ask the user first; then call
  send_message_to_subagent with the answer and wait again. When the question is the
  place agent asking whether to switch to indoor activities because the forecast is
  poor, use set_indoor_mode rather than ask_user. Send the place agent a structured decision message:
  JSON.stringify({ action: "user_decision", indoor_mode: <bool>, destination: "<destination>",
                   instruction: "Execute places_search(indoor_only=<bool>), restaurants_search, and accommodation_search in parallel now for <destination>." })
  and remember indoor_mode for STEP 5.
- If a task "failed", you may launch that spec again once.
- You may use check_subagent_status to look without waiting, send_message_to_subagent
  to add a comment, and stop_subagent to cancel work that is no longer needed.
- set_indoor_mode requires the user's approval before it runs. If its result comes back as
  "User rejected the tool call for 'set_indoor_mode'...", treat that as the user's decision
  (indoor_mode=false) and continue — do not retry the call or treat it as an error.

STEP 3 — Transport choice & Booking. Call choose_transport. It shows the user every transport
option with an estimated trip total and records their pick. If requested to book tickets or
when authorized, call book_flight. book_flight also requires the user's approval before it runs;
if it comes back rejected, the booking was not made — tell the user and continue without it.

STEP 5 — Finish. Do not emit this JSON until STEP 2 is actually complete — you must
have called launch_subagent for both transportation_agent and place_agent and
waited on them with wait_for_subagents. Reply with ONLY this JSON (no prose, no tool call):
{
  "requirements": {source, destination, start_date, num_days, num_travellers,
                   interests, budget},
  "indoor_mode": <bool>
}
Do not attempt to merge the plan or compute the budget yourself.

STEP 6 — Plan Revision. After STEP 5, you may receive a follow-up message shaped like
{"action": "plan_feedback", "message": "<user's text>", "budget_cap": <num|null>, "budget_total": <num>}.
Decide what the user wants and reply with ONLY one of these JSON shapes (no prose, no tool call):
- {"action": "recheck_budget"} — they want to reduce cost or fit the budget
- {"action": "edit_plan", "instruction": "<clear instruction for the place agent describing the requested change>"} — they want to change places/restaurants/activities/accommodation
- {"action": "answer", "message": "<your answer>"} — they're asking a question that doesn't require changing anything
`;


const MAIN_AGENT_SPEC: AgentSpec = {
  name: "main_agent",
  description: "Owns all interaction with the user",
  tools: [],
  body: SYSTEM,
  model: null,
  temperature: settings.llmTemperature,
  output: null,
};

interface Plan {
  requirements: Dict;
  flightsResult: Dict;
  placesResult: Dict;
  itinerary: Dict;
  budget: Dict;
}

// Shared mutable state for one trip, written by set_indoor_mode/choose_transport and read by
// buildPlan — avoids buildPlan recomputing what choose_transport already assembled for the pick.
interface TransportSelection {
  transportIndex: number | null;
  indoorMode: boolean;
  cache: { requirements: Dict; flightsResult: Dict; placesResult: Dict; itinerary: Dict; budget: Dict } | null;
}

// The Main Agent's own session — one Agent, one thread, turns queued while busy.
export class MainAgentSession {
  private agent: Agent;
  private busy = false;
  private inbox: { message: string; resolve: (reply: Dict) => void }[] = [];

  constructor(agent: Agent) {
    this.agent = agent;
  }

  // Idle: runs the turn now. Busy: queued, resolved once its own turn actually runs.
  send(message: string): Promise<Dict> {
    if (!this.busy) return this.runTurn(message);
    return new Promise((resolve) => this.inbox.push({ message, resolve }));
  }

  private async runTurn(message: string): Promise<Dict> {
    this.busy = true;
    let reply: Dict;
    try {
      reply = await this.agent.send(message);
    } finally {
      this.busy = false;
    }
    const next = this.inbox.shift();
    if (next !== undefined) void this.runTurn(next.message).then(next.resolve);
    return reply;
  }
}

function transportResearch(spin: SpinUp): Dict {
  return get(spin.latest(TRANSPORT)?.tools, "transport_search", {});
}

export interface ConsolidatedTripState {
  requirements: Dict;
  weather: Dict;
  places: Dict[];
  restaurants: Dict;
  accommodation_options: Dict[];
  selectedAccommodation: Dict;
  transport_options: Dict[];
  selectedTransport: Dict;
  indoor_mode: boolean;
  weather_declined: boolean;
}

export function getConsolidatedState(spin: SpinUp, indoor: boolean, requirements: Dict = {}): ConsolidatedTripState {
  const placeTools = spin.latest(PLACES)?.tools ?? {};
  const transportTools = spin.latest(TRANSPORT)?.tools ?? {};

  const weather = pyOr(get(placeTools, "weather_search"), { days: [], unavailable: true, source: "unavailable" });
  const places: Dict[] = pyOr(get(get(placeTools, "places_search", {}), "places"), []);
  const restaurants: Dict = pyOr(get(placeTools, "restaurants_search"), {});
  const accommodation_options: Dict[] = pyOr(get(get(placeTools, "accommodation_search", {}), "accommodation_options"), []);
  const price = (c: Dict) => get(c, "price_per_night", 1e12);
  const selectedAccommodation = accommodation_options.length
    ? accommodation_options.reduce((best, c) => (price(c) < price(best) ? c : best))
    : {};
  const transport_options: Dict[] = pyOr(get(get(transportTools, "transport_search", {}), "options"), []);
  const selectedTransport = transport_options.length ? transport_options[0] : {};

  return {
    requirements,
    weather,
    places,
    restaurants,
    accommodation_options,
    selectedAccommodation,
    transport_options,
    selectedTransport,
    indoor_mode: indoor,
    weather_declined: truthy(get(weather, "bad_weather")) && !indoor,
  };
}

export function checkResearchCompleteness(state: ConsolidatedTripState): { complete: boolean; missing: string[] } {
  const missing: string[] = [];
  if (!state.places || state.places.length === 0) missing.push("places_search");
  if (!state.accommodation_options || state.accommodation_options.length === 0) missing.push("accommodation_search");
  if (!state.restaurants || Object.keys(state.restaurants).length === 0) missing.push("restaurants_search");
  return { complete: missing.length === 0, missing };
}

function buildPlacesResult(spin: SpinUp, indoor: boolean): Dict {
  const state = getConsolidatedState(spin, indoor);
  return {
    places: state.places,
    restaurants: state.restaurants,
    accommodation: state.selectedAccommodation,
    accommodation_options: state.accommodation_options,
    weather: state.weather,
    indoor_mode: state.indoor_mode,
    weather_declined: state.weather_declined,
  };
}

async function ensurePlaceResearch(spin: SpinUp, indoor: boolean, maxRetries = 2) {
  const place = spin.latest(PLACES);
  if (!place) return;

  for (let i = 0; i < maxRetries; i++) {
    const state = getConsolidatedState(spin, indoor);
    const { complete, missing } = checkResearchCompleteness(state);
    if (complete) break;

    console.log(`  [Main Agent] [place] Incomplete research (missing: ${missing.join(", ")}). Prompting place_agent...`);
    const task = place.task ?? {};
    const prompt = JSON.stringify({
      action: "execute_missing_tools",
      destination: task.destination,
      start_date: task.start_date,
      num_days: task.num_days,
      travellers: task.travellers,
      interests: task.interests,
      indoor_only: indoor,
      missing_tools: missing,
      instruction: `Execute the missing tools for destination "${task.destination}" (indoor_only=${indoor}): ${missing.join(", ")}.`,
    });
    spin.send(place.id, prompt);
    await spin.wait([place.id]);
    if (place.status !== "done") break;
  }
}

// What the Main Agent sees instead of the full research, keeping its context small.
function summarizeResearch(tools: Dict): Dict {
  const summary: Dict = {};
  const transport = get(tools, "transport_search");
  if (isDict(transport)) summary.transport_options = pyOr(transport.options, []).length;
  const weather = get(tools, "weather_search");
  if (isDict(weather)) Object.assign(summary, { bad_weather: truthy(weather.bad_weather), weather_source: weather.source });
  const places = get(tools, "places_search");
  if (isDict(places)) summary.places = pyOr(places.places, []).length;
  const restaurants = get(tools, "restaurants_search");
  if (isDict(restaurants)) {
    summary.restaurants = Object.fromEntries(Object.entries(restaurants).map(([meal, v]) => [meal, Array.isArray(v) ? v.length : 0]));
  }
  const stays = get(tools, "accommodation_search");
  if (isDict(stays)) summary.stays = pyOr(stays.accommodation_options, []).length;
  return summary;
}

async function assemble(mcp: McpTools, requirements: Dict, flightsResult: Dict, placesResult: Dict) {
  const merged = await mcp.call("merge_plan", { requirements, flights_result: flightsResult, places_result: placesResult });
  const itinerary: Dict = get(merged, "itinerary", merged);
  const checked = await mcp.call("budget_check", {
    requirements,
    places_result: placesResult,
    itinerary,
    budget_cap: get(requirements, "budget"),
  });
  return { itinerary, budget: get(checked, "budget_status", checked) as Dict };
}

// Before the Main Agent's final answer, the requirements are known only from the tasks it gave the sub-agents.
function requirementsFromTasks(spin: SpinUp): Dict {
  const transport = spin.latest(TRANSPORT)?.task ?? {};
  const places = spin.latest(PLACES)?.task ?? {};
  return {
    source: transport.source,
    destination: pyOr(places.destination, transport.destination),
    start_date: pyOr(places.start_date, transport.start_date),
    num_days: places.num_days,
    num_travellers: pyOr(places.travellers, transport.travellers, 1),
    budget: pyOr(transport.budget_cap, null),
  };
}

// merge_plan + budget_check are local, deterministic MCP calls (no LLM, no external network — see
// mcp_server/handlers.ts), so one per option is cheap. Returns each option's full assembled result
// too, so choose_transport can cache the picked one instead of buildPlan recomputing it.
async function computeTransportOptions(
  mcp: McpTools,
  requirements: Dict,
  options: Dict[],
  placesResult: Dict,
): Promise<{ label: string; flightsResult: Dict; itinerary: Dict; budget: Dict }[]> {
  const cap = get(requirements, "budget");
  const results = [];
  for (const option of options) {
    const flightsResult = { options, selected: option };
    const { itinerary, budget } = await assemble(mcp, requirements, flightsResult, placesResult);
    const notes = truthy(option.notes) ? ` (${option.notes})` : "";
    const fit = cap == null
      ? ""
      : truthy(budget.ok)
        ? ` (within budget ₹${fmtFixed(cap, 0)})`
        : ` (over budget ₹${fmtFixed(cap, 0)} by ₹${fmtFixed(budget.overage, 0)})`;
    const modeTag = option.mode ? `[${option.mode}] ` : "";
    const label =
      `${modeTag}${option.option} via ${option.provider} — ${option.travel_time} — ${option.approx_fare}${notes}` +
      ` · trip total ≈ ₹${fmtFixed(budget.total, 0)}${fit}`;
    results.push({ label, flightsResult, itinerary, budget });
  }
  return results;
}

async function transportLabels(mcp: McpTools, requirements: Dict, options: Dict[], placesResult: Dict): Promise<string[]> {
  return (await computeTransportOptions(mcp, requirements, options, placesResult)).map((r) => r.label);
}

// ask_user and choose_transport are plain, ungated tools: they already do real synchronous
// human interaction via Hitl (readline), so they're not registered here. Only set_indoor_mode
// and book_flight are genuine "approve/reject this one proposed action" decisions, which is what
// this middleware actually models — see concepts note on why the split is this way.
export function createMainAgentHitlMiddleware(spin: SpinUp) {
  return humanInTheLoopMiddleware({
    interruptOn: {
      set_indoor_mode: {
        allowedDecisions: ["approve", "reject"],
        description: (toolCall) => formatWeatherBox(spin.latest(PLACES)?.tools.weather_search as Dict | undefined, toolCall.args.reason as string | undefined),
      },
      book_flight: {
        allowedDecisions: ["approve", "reject"],
        description: (toolCall) => formatBookingBox(toolCall.args as Dict),
      },
    },
  });
}

function mainAgentTools(
  spin: SpinUp,
  hitl: Hitl,
  mcp: McpTools,
  chosen: TransportSelection,
  principal: Principal,
) {
  const askUser = tool(({ question }) => hitl.handleSubagentClarification(question), {
    name: "ask_user",
    description: "Ask the user one free-text question and return the answer.",
    schema: z.object({ question: z.string() }),
  });

  // The interrupt (set up in createMainAgentHitlMiddleware) is the actual approval step —
  // this only runs at all once a human has approved it, so it just reports the outcome.
  // Recording the decision here (rather than trusting the model to repeat it later) is what
  // lets choose_transport preview totals with the real indoor setting instead of guessing.
  const setIndoorMode = tool(
    async ({ enabled }: { reason?: string; enabled?: boolean }) => {
      chosen.indoorMode = enabled ?? true;
      return { approved: true, decision: "approve" as const, indoor_mode: chosen.indoorMode };
    },
    {
      name: "set_indoor_mode",
      description: "Ask the user to approve or reject switching itinerary to indoor activities due to poor weather forecast.",
      schema: z.object({
        reason: z.string().optional().describe("Reason for indoor switch (e.g. forecast notice)"),
        enabled: z.boolean().optional().describe("Proposed indoor setting"),
      }),
    },
  );

  const chooseTransport = tool(
    async () => {
      await spin.wait();
      await ensurePlaceResearch(spin, chosen.indoorMode);
      const options: Dict[] = pyOr(transportResearch(spin).options, []);
      if (!options.length) return { error: "No transport options yet — launch transportation_agent first." };
      const requirements = requirementsFromTasks(spin);
      const placesResult = buildPlacesResult(spin, chosen.indoorMode);
      const computed = await computeTransportOptions(mcp, requirements, options, placesResult);
      const { index, choice } = await hitl.handleTransportChoice(
        "Choose your transport (trip totals include stay, food and activities):",
        computed.map((c) => c.label),
      );
      chosen.transportIndex = index;
      chosen.cache = { requirements, flightsResult: computed[index].flightsResult, placesResult, itinerary: computed[index].itinerary, budget: computed[index].budget };
      return { index, choice };
    },
    {
      name: "choose_transport",
      description:
        "Show the user every researched transport option with an estimated trip total and record their pick. " +
        "Waits for running research first.",
      schema: z.object({}),
    },
  );

  const bookFlightTool = tool(
    async ({
      destination,
      transport_option,
      travellers,
      fare,
    }: {
      destination: string;
      transport_option?: string;
      travellers?: number;
      fare?: string;
    }) => {
      return bookFlight(principal, {
        destination,
        transportOption: transport_option,
        travellers,
        fare,
      });
    },
    {
      name: "book_flight",
      description: "Book ticket/flight for the selected transport option (Admin only).",
      schema: z.object({
        destination: z.string().describe("Trip destination"),
        transport_option: z.string().optional().describe("Selected transport description"),
        travellers: z.number().optional().describe("Number of travellers"),
        fare: z.string().optional().describe("Approx fare"),
      }),
    },
  );

  return [...spin.langchainTools(), askUser, chooseTransport, setIndoorMode, bookFlightTool];
}


function budgetFeedback(attempt: number, plan: Plan): Dict {
  const cards: Dict[] = get(plan.itinerary, "cards", []);
  const stay = get(plan.itinerary, "accommodation", {});
  return {
    attempt,
    cap: plan.budget.cap,
    total: plan.budget.total,
    overage: plan.budget.overage,
    breakdown: plan.budget.breakdown,
    transport_fixed: true,
    current_choices: {
      accommodation: { name: get(stay, "name"), price_per_night: get(stay, "price_per_night") },
      places: cards.flatMap((c) => get(c, "activities", []) as Dict[]).map((a) => ({ name: a.name, est_cost: a.est_cost })),
      meals: cards.flatMap((c) => get(c, "meals", []) as Dict[]).map((m) => ({ meal: m.meal, name: m.name, est_cost: m.est_cost })),
    },
  };
}

// Code decides *when* to re-check (over budget, retries left, progress made); the place agent decides *how* to cut.
// Feedback continues the place agent's own session, so it remembers the research it already did.
async function recheckBudget(
  mcp: McpTools,
  spin: SpinUp,
  hitl: Hitl,
  plan: Plan,
  indoor: boolean,
  maxAttempts: number,
  attempts: Dict[],
): Promise<Plan> {
  const place = spin.latest(PLACES);
  if (!place) return plan;
  let current = plan;
  for (let n = 0; n < maxAttempts && !truthy(current.budget.ok); n++) {
    const attempt = attempts.length + 1;
    console.log(`  [Main Agent] [budget] Over by ₹${fmtFixed(current.budget.overage, 0)} — asking place agent to re-check (attempt ${attempt})`);
    spin.send(place.id, JSON.stringify({ budget_feedback: budgetFeedback(attempt, current) }));
    await spin.wait([place.id]);

    // The Main Agent's LLM has already finished, so a question raised during a re-check goes to the user.
    while (place.status === "needs_clarification") {
      const { answer } = await hitl.askUser(`The place agent asks: ${place.reply?.needs_clarification}`);
      spin.send(place.id, answer);
      await spin.wait([place.id]);
    }
    if (place.status !== "done") {
      console.log(`  [Main Agent] [budget] Budget re-check ended: ${place.error ?? place.status}`);
      break;
    }

    const placesResult = buildPlacesResult(spin, indoor);
    const next: Plan = { ...current, placesResult, ...(await assemble(mcp, current.requirements, current.flightsResult, placesResult)) };
    attempts.push({ attempt, total: next.budget.total });
    if (next.budget.total >= current.budget.total) break;
    current = next;
  }
  return current;
}

async function resolveOverBudget(mcp: McpTools, spin: SpinUp, hitl: Hitl, plan: Plan, indoor: boolean, attempts: Dict[]): Promise<Plan> {
  const { index } = await hitl.handleBudgetResolution(
    `The plan is still over your ₹${fmtFixed(plan.budget.cap, 0)} budget by ₹${fmtFixed(plan.budget.overage, 0)}. What would you like to do?`,
    [`Keep this plan (₹${fmtFixed(plan.budget.total, 0)})`, "Switch to a cheaper transport", "Raise my budget"],
  );

  if (index === 1) {
    const options: Dict[] = pyOr(plan.flightsResult.options, []);
    if (!options.length) return plan;
    const labels = await transportLabels(mcp, plan.requirements, options, plan.placesResult);
    const pick = await hitl.handleTransportChoice("Choose your transport:", labels);
    const flightsResult = { ...plan.flightsResult, selected: options[pick.index] };
    return { ...plan, flightsResult, ...(await assemble(mcp, plan.requirements, flightsResult, plan.placesResult)) };
  }

  if (index === 2) {
    const { answer } = await hitl.handleSubagentClarification("What is your new total budget in INR?");
    const amount = Number(String(answer).replace(/[^\d.]/g, ""));
    if (!amount) return plan;
    const requirements = { ...plan.requirements, budget: amount };
    const raised: Plan = { ...plan, requirements, ...(await assemble(mcp, requirements, plan.flightsResult, plan.placesResult)) };
    return recheckBudget(mcp, spin, hitl, raised, indoor, 1, attempts);
  }

  return plan;
}

// Assembles the plan once. Reuses choose_transport's cached assemble() result for the picked
// option when it's still valid (same budget cap and traveller count), instead of recomputing the
// same deterministic merge_plan/budget_check call — see concepts/human-in-the-loop.md for why the
// preview now uses the real indoor_mode, which is what makes this cache trustworthy.
async function buildPlan(mcp: McpTools, spin: SpinUp, chosen: TransportSelection, decision: Dict): Promise<Plan> {
  // Only waits for sub-agents the Main Agent launched; code never launches research itself.
  await spin.wait();

  const rawRequirements = get(decision, "requirements", {});
  const requirements = validateRequirements(rawRequirements);
  const indoor = truthy(get(decision, "indoor_mode", false));
  await ensurePlaceResearch(spin, indoor);
  const transport = transportResearch(spin);
  const options: Dict[] = pyOr(transport.options, []);
  const index = options.length ? Math.max(0, Math.min(chosen.transportIndex ?? 0, options.length - 1)) : 0;
  const flightsResult = { options, selected: options.length ? options[index] : {}, source: get(transport, "source", "mock") };

  const cache = chosen.cache;
  const cacheValid =
    cache &&
    cache.flightsResult.selected === flightsResult.selected &&
    get(cache.requirements, "budget") === get(requirements, "budget") &&
    get(cache.requirements, "num_travellers") === get(requirements, "num_travellers");

  if (cacheValid && cache) {
    console.log("  [Main Agent] [budget] Reusing the total already computed when the transport was chosen");
    return { requirements, flightsResult, placesResult: cache.placesResult, itinerary: cache.itinerary, budget: cache.budget };
  }

  const placesResult = buildPlacesResult(spin, indoor);
  console.log("  [Main Agent] [itinerary] Assembling day-by-day itinerary layout");
  console.log("  [Main Agent] [budget] Calculating trip budget & expenses");
  return { requirements, flightsResult, placesResult, ...(await assemble(mcp, requirements, flightsResult, placesResult)) };
}

export async function planTrip(
  request: string,
  {
    hitl,
    answers,
    stdin,
    principal,
    role,
  }: {
    hitl?: Hitl;
    answers?: string[];
    stdin?: StdinChannel;
    principal?: Principal;
    role?: Role;
  } = {},
): Promise<Dict> {
  const authPrincipal = principal ?? resolvePrincipal({ role });
  const channel = hitl ?? new Hitl(answers, stdin);
  const mcp = await new McpTools().open();
  try {
    const spin = new SpinUp(mcp, summarizeResearch);
    const chosen: TransportSelection = { transportIndex: null, indoorMode: false, cache: null };
    const checkpointer = new MemorySaver();
    const mainAgent = new Agent(MAIN_AGENT_SPEC, mcp, {
      sessionId: "main",
      checkpointer,
      tools: mainAgentTools(spin, channel, mcp, chosen, authPrincipal),
      resolveInterrupt: (request) => channel.reviewToolCalls(request),
      middleware: [
        createMainAgentHitlMiddleware(spin),
        createRbacMiddleware(authPrincipal),
      ],
    });
    const session = new MainAgentSession(mainAgent);


    const MAX_TOOL_USE_NUDGES = 2;
    const MAX_RESEARCH_NUDGES = 2;
    const MAX_REQUIREMENTS_TURNS = 10;

    let decision = await session.send(request);
    let nudges = 0;

    for (let turn = 0; turn < MAX_REQUIREMENTS_TURNS; turn++) {
      if (!decision.requirements && truthy(decision.notes)) {
        if (nudges < MAX_TOOL_USE_NUDGES) {
          nudges++;
          decision = await session.send(
            "You replied with plain assistant text instead of calling a tool. " +
            "You MUST call the ask_user tool now, for exactly ONE missing field. " +
            "Do not list multiple fields and do not reply in plain text.",
          );
          continue;
        }
        // Model still won't use the tool after nudging — fall back to a direct exchange
        // rather than stalling the conversation.
        const { answer } = await channel.askUser(String(decision.notes));
        if (!answer.trim()) break;
        decision = await session.send(answer);
        nudges = 0;
        continue;
      }

      const parsed = TripRequirementsSchema.safeParse(decision.requirements);
      if (parsed.success) {
        break;
      }

      // Requirements are present as an object but missing mandatory fields or invalid
      const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "field"}: ${i.message}`).join("; ");
      decision = await session.send(
        `Trip requirements are incomplete or invalid (${issues}). ` +
        `You MUST call the ask_user tool now for ONE missing field. Do not emit final JSON until all required fields are collected.`,
      );
    }

    for (let n = 0; n < MAX_RESEARCH_NUDGES && (!spin.latest(PLACES) || !spin.latest(TRANSPORT)); n++) {
      decision = await session.send(
        "You produced the final JSON without completing STEP 2. You MUST call " +
        "launch_subagent for both transportation_agent and place_agent, then " +
        "wait_for_subagents, before replying with the final JSON. Do that now.",
      );
    }

    let plan = await buildPlan(mcp, spin, chosen, decision);
    channel.showPlan(plan.itinerary, plan.budget, null);

    const attempts: Dict[] = [];
    let recheck: BudgetRecheck | null = null;
    const MAX_PLAN_REVISION_TURNS = 5;

    for (let round = 0; round < MAX_PLAN_REVISION_TURNS; round++) {
      const { answer } = await channel.askUser(
        "Press Enter to confirm. Or ask a question, request a change to the plan, or ask to recheck the budget:",
      );
      if (!answer.trim()) break;

      const feedback = await session.send(
        JSON.stringify({ action: "plan_feedback", message: answer, budget_cap: plan.budget.cap, budget_total: plan.budget.total }),
      );
      const action = get(feedback, "action");

      if (action === "recheck_budget") {
        const indoor = truthy(get(decision, "indoor_mode", false));
        const initialTotal = plan.budget.total;
        plan = await recheckBudget(mcp, spin, channel, plan, indoor, settings.budgetRetryLimit, attempts);
        if (!truthy(plan.budget.ok)) plan = await resolveOverBudget(mcp, spin, channel, plan, indoor, attempts);
        recheck = attempts.length ? { attempts: attempts.length, from: initialTotal, to: plan.budget.total } : recheck;
        channel.showPlan(plan.itinerary, plan.budget, recheck);
      } else if (action === "edit_plan") {
        const place = spin.latest(PLACES);
        if (place) {
          spin.send(place.id, JSON.stringify({ action: "user_edit", instruction: get(feedback, "instruction", answer) }));
          await spin.wait([place.id]);
          while (place.status === "needs_clarification") {
            const { answer: clarifyAnswer } = await channel.askUser(`The place agent asks: ${place.reply?.needs_clarification}`);
            spin.send(place.id, clarifyAnswer);
            await spin.wait([place.id]);
          }
          chosen.cache = null; // research changed — the cached preview total is no longer valid
          plan = await buildPlan(mcp, spin, chosen, decision);
          channel.showPlan(plan.itinerary, plan.budget, recheck);
        }
      } else {
        console.log(`\n${get(feedback, "message", get(feedback, "notes", "")) || "(no response)"}`);
      }
    }

    return {
      requirements: plan.requirements,
      flights_result: plan.flightsResult,
      itinerary: plan.itinerary,
      budget_status: plan.budget,
      budget_attempts: attempts,
      subagent_tasks: spin.board(),
    };
  } finally {
    await mcp.close();
  }
}
