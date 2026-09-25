import { join } from "node:path";
import { MemorySaver } from "@langchain/langgraph";
import { humanInTheLoopMiddleware, tool } from "langchain";
import { z } from "zod";
import { Agent } from "./agent.ts";
import { ROOT, settings } from "./config.ts";
import { offerBooking } from "./bookingFlow.ts";
import { formatWeatherBox, Hitl } from "./hitl.ts";
import { McpTools } from "./mcpClient.ts";
import { type Principal, type Role, resolvePrincipal } from "./rbac/rbac.ts";
import { Scratchpad } from "./scratchpad.ts";
import { type AgentSpec, loadSpec } from "./specs.ts";
import { SpinUp } from "./spinUp.ts";
import type { StdinChannel } from "./stdin.ts";
import { type BudgetRecheck, fareText } from "./tools/index.ts";
import { type Dict, fmtFixed, get, isDict, pyOr, todayIso, truthy } from "./tools/util.ts";
import { ExtractedRequirementsSchema, REQUIRED_FIELDS, parseAndValidateField, validateRequirements } from "./validation.ts";
export { offerBooking } from "./bookingFlow.ts";

// The Main Agent's own spec lives in its own subfolder, not directly in agent_specs/: that top-level directory
// also feeds launch_subagent's list of specs the model may launch (spinUp.ts, listSpecs()), which only lists
// *.md files directly inside it (readdirSync is not recursive) — a subfolder never appears there, so this can
// use the same markdown+frontmatter format as sub-agent specs without ever offering the Main Agent as one.
const MAIN_AGENT_SPEC_DIR = join(ROOT, "agent_specs", "main");

// Flow: one Main Agent tool loop gathers requirements (saved to the shared scratchpad), launches the research
// sub-agents in the background, collects their results and asks the user to choose transport, then shows the plan
// and runs the confirm loop through ask_user. Code only assembles the plan from the results recorded in the
// scratchpad, re-checks the budget by continuing the place agent's session, and asks the user if it still doesn't fit.

const TRANSPORT = "transportation_agent";
const PLACES = "place_agent";
const MAX_PLAN_REVISION_TURNS = 5;

// Temperature is the app-wide configured default here (unlike a sub-agent spec, which hardcodes its own),
// so it's applied after loading rather than written into the spec file.
const MAIN_AGENT_SPEC: AgentSpec = { ...loadSpec("main_agent", MAIN_AGENT_SPEC_DIR), temperature: settings.llmTemperature };

// Requirements gathering: code-driven slot-filling with fixed question templates.
class RequirementsDraft {
  extracted: Dict = {};
  answers: Dict = {};
}

const FIELD_QUESTIONS: Record<string, string> = {
  source: "Where are you travelling from?",
  destination: "Where do you want to go?",
  start_date: "What date does the trip start? (YYYY-MM-DD)",
  num_days: "How many days is the trip?",
  num_travellers: "How many travellers?",
  budget: "What's your budget in INR? (press Enter for no limit)",
  interests: "Any particular interests for the trip? (press Enter to skip)",
  exclude: "Anything you'd like to avoid (e.g. temples, seafood)? (press Enter to skip)",
};
// Fields the intake loop always asks for when extraction didn't determine them, then the optional ones —
// derived from the schema so the two never drift apart. `exclude` is a preference, not a trip requirement, so
// it isn't in the schema; it's asked last, the same way as any other optional field.
const OPTIONAL_FIELDS = ["budget", "interests", "exclude"] as const;
const MAX_FIELD_RETRIES = 3;

export interface Plan {
  requirements: Dict;
  flightsResult: Dict;
  placesResult: Dict;
  itinerary: Dict;
  budget: Dict;
}

type PlanCache = { requirements: Dict; flightsResult: Dict; placesResult: Dict; itinerary: Dict; budget: Dict; version: number };

// Plan-assembly state for one trip, updated by choose_transport/present_plan and read by buildPlan — avoids
// buildPlan recomputing what choose_transport already assembled for the pick. Facts the agents share
// (requirements, preferences, research results) live in the Scratchpad instead. Named methods, rather than raw
// field access, so each place that changes plan state says what it's doing at the call site.
class TripPlanState {
  private transportIndex: number | null = null;
  private returnIndex: number | null = null; // null when the research has no return options
  private adjustPlaces = false; // user chose to keep the cheapest transport and trim places to fit the budget
  // The preview computed when the transport was picked; only valid while no new research has been recorded since.
  private cache: PlanCache | null = null;
  private plan: Plan | null = null; // the plan last shown to the user
  private planVersion = -1; // scratchpad version that plan was built from
  private presentations = 0;
  private recheck: BudgetRecheck | null = null;
  private attempts: Dict[] = []; // budget re-check attempts made so far

  // choose_transport records every pick here. "Switch to a cheaper transport" (from resolveOverBudget) also
  // calls this, with only the two indices — omitting `cache`/`adjustPlaces` leaves them as they were.
  recordTransportChoice(index: number, returnIndex: number | null, cache?: PlanCache, adjustPlaces?: boolean): void {
    this.transportIndex = index;
    this.returnIndex = returnIndex;
    if (cache) this.cache = cache;
    if (adjustPlaces !== undefined) this.adjustPlaces = adjustPlaces;
  }

  get transportIndices(): { transportIndex: number | null; returnIndex: number | null } {
    return { transportIndex: this.transportIndex, returnIndex: this.returnIndex };
  }

  get shouldAdjustPlaces(): boolean {
    return this.adjustPlaces;
  }

  // The assembled result from when the transport was chosen, if it's still valid for this rebuild: same
  // picks, same budget cap and traveller count, and no new research recorded since.
  cachedAssembly(scratchpadVersion: number, flightsResult: Dict, requirements: Dict): { placesResult: Dict; itinerary: Dict; budget: Dict } | null {
    const cache = this.cache;
    const valid =
      cache &&
      cache.version === scratchpadVersion &&
      cache.flightsResult.selected === flightsResult.selected &&
      cache.flightsResult.selected_return === flightsResult.selected_return &&
      get(cache.requirements, "budget") === get(requirements, "budget") &&
      get(cache.requirements, "num_travellers") === get(requirements, "num_travellers");
    return valid && cache ? { placesResult: cache.placesResult, itinerary: cache.itinerary, budget: cache.budget } : null;
  }

  get isFirstPresentation(): boolean {
    return this.plan === null;
  }

  // The last shown plan's itinerary, regardless of whether the scratchpad has moved on since — this is the
  // point: after an edit, the version has changed, but clusterPlaces still wants to know where things were.
  get previousItinerary(): Dict | null {
    return this.plan?.itinerary ?? null;
  }

  recordShownPlan(plan: Plan, scratchpadVersion: number): void {
    this.plan = plan;
    this.planVersion = scratchpadVersion;
    this.presentations++;
  }

  // The plan already shown, only if it still matches the scratchpad's current version.
  planIfCurrent(scratchpadVersion: number): Plan | null {
    return this.plan !== null && this.planVersion === scratchpadVersion ? this.plan : null;
  }

  get presentationCount(): number {
    return this.presentations;
  }

  recordBudgetAttempt(attempt: Dict): void {
    this.attempts.push(attempt);
  }

  get budgetAttempts(): Dict[] {
    return this.attempts;
  }

  recordRecheckSummary(from: number, to: number): void {
    if (this.attempts.length) this.recheck = { attempts: this.attempts.length, from, to };
  }

  get recheckSummary(): BudgetRecheck | null {
    return this.recheck;
  }
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

function transportResearch(scratchpad: Scratchpad): Dict {
  return pyOr(scratchpad.output("transport_search"), {});
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

export function getConsolidatedState(scratchpad: Scratchpad): ConsolidatedTripState {
  const indoor = scratchpad.preferences.indoorMode;
  const weather = pyOr(scratchpad.output("weather_search"), { days: [], unavailable: true, source: "unavailable" });
  const places: Dict[] = pyOr(get(scratchpad.output("places_search"), "places"), []);
  const restaurants: Dict = pyOr(scratchpad.output("restaurants_search"), {});
  const accommodation_options: Dict[] = pyOr(get(scratchpad.output("accommodation_search"), "accommodation_options"), []);
  const price = (c: Dict) => get(c, "price_per_night", 1e12);
  const selectedAccommodation = accommodation_options.length
    ? accommodation_options.reduce((best, c) => (price(c) < price(best) ? c : best))
    : {};
  const transport_options: Dict[] = pyOr(get(scratchpad.output("transport_search"), "options"), []);
  const selectedTransport = transport_options.length ? transport_options[0] : {};

  return {
    requirements: scratchpad.requirements ?? {},
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

function buildPlacesResult(scratchpad: Scratchpad): Dict {
  const state = getConsolidatedState(scratchpad);
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

async function ensurePlaceResearch(spin: SpinUp, maxRetries = 2) {
  const place = spin.latest(PLACES);
  if (!place) return;
  const { scratchpad } = spin;

  for (let i = 0; i < maxRetries; i++) {
    const { complete, missing } = checkResearchCompleteness(getConsolidatedState(scratchpad));
    if (complete) break;

    console.log(`  [Main Agent] [place] Incomplete research (missing: ${missing.join(", ")}). Prompting place_agent...`);
    const trip = scratchpad.requireRequirements();
    const indoor = scratchpad.preferences.indoorMode;
    const prompt = JSON.stringify({
      action: "execute_missing_tools",
      destination: trip.destination,
      start_date: trip.start_date,
      num_days: trip.num_days,
      travellers: trip.num_travellers,
      interests: trip.interests,
      indoor_only: indoor,
      missing_tools: missing,
      instruction: `Execute the missing tools for destination "${trip.destination}" (indoor_only=${indoor}): ${missing.join(", ")}.`,
    });
    spin.send(place.id, prompt);
    await spin.wait([place.id]);
    if (place.status !== "done") break;
  }
}

// What the Main Agent sees instead of the full research, keeping its context small.
// `tools` is a sub-agent's latest results, keyed by tool name.
function summarizeResearch(tools: Dict): Dict {
  const summary: Dict = {};
  const transport = get(tools, "transport_search");
  if (isDict(transport)) {
    summary.transport_options = pyOr(transport.options, []).length;
    summary.return_options = pyOr(transport.return_options, []).length;
  }
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

async function assemble(mcp: McpTools, requirements: Dict, flightsResult: Dict, placesResult: Dict, previousItinerary: Dict | null = null) {
  const merged = await mcp.call("merge_plan", {
    requirements,
    flights_result: flightsResult,
    places_result: placesResult,
    // Omitted entirely rather than set to `undefined` — the tool call's JSON-schema validation rejects a
    // property that is present but undefined, even for a nullish-typed field.
    ...(previousItinerary ? { previous_itinerary: previousItinerary } : {}),
  });
  const itinerary: Dict = get(merged, "itinerary", merged);
  const checked = await mcp.call("budget_check", {
    requirements,
    places_result: placesResult,
    itinerary,
    budget_cap: get(requirements, "budget"),
  });
  return { itinerary, budget: get(checked, "budget_status", checked) as Dict };
}

// The transport research as the plan carries it: both legs' options plus the picked option for each.
function flightsFor(transport: Dict, selected: Dict, selectedReturn: Dict | null): Dict {
  return {
    options: pyOr(transport.options, []),
    selected,
    return_options: pyOr(transport.return_options, []),
    selected_return: selectedReturn ?? undefined,
    return_date: transport.return_date,
    return_route: transport.return_route,
    source: get(transport, "source", "mock"),
  };
}

// One option's line in a transport prompt: what it is, its fare, and the trip total it leads to.
function optionLabel(option: Dict, budget: Dict, cap: number | null): string {
  const notes = truthy(option.notes) ? ` (${option.notes})` : "";
  const fit = cap == null
    ? ""
    : truthy(budget.ok)
      ? ` (within budget ₹${fmtFixed(cap, 0)})`
      : ` (over budget ₹${fmtFixed(cap, 0)} by ₹${fmtFixed(budget.overage, 0)})`;
  const modeTag = option.mode ? `[${option.mode}] ` : "";
  return (
    `${modeTag}${option.option} via ${option.provider} — ${option.travel_time} — ${fareText(option)}${notes}` +
    ` · trip total ≈ ₹${fmtFixed(budget.total, 0)}${fit}`
  );
}

type Leg = { label: string; flightsResult: Dict; itinerary: Dict; budget: Dict };

// merge_plan + budget_check are local, deterministic MCP calls (no LLM, no external network — see
// mcp_server/handlers.ts), so one per option is cheap. Returns each option's full assembled result
// too, so choose_transport can cache the picked one instead of buildPlan recomputing it.
async function computeLegs(
  mcp: McpTools,
  requirements: Dict,
  placesResult: Dict,
  legOptions: Dict[],
  flights: (option: Dict) => Dict,
): Promise<Leg[]> {
  const cap = get(requirements, "budget");
  const results: Leg[] = [];
  for (const option of legOptions) {
    const flightsResult = flights(option);
    const { itinerary, budget } = await assemble(mcp, requirements, flightsResult, placesResult);
    results.push({ label: optionLabel(option, budget, cap), flightsResult, itinerary, budget });
  }
  return results;
}

// Each outbound option is priced with the cheapest return, until the user picks the return.
function computeTransportOptions(mcp: McpTools, requirements: Dict, transport: Dict, placesResult: Dict): Promise<Leg[]> {
  const cheapestReturn: Dict | null = pyOr(transport.return_options, [])[0] ?? null;
  return computeLegs(mcp, requirements, placesResult, pyOr(transport.options, []), (option) => flightsFor(transport, option, cheapestReturn));
}

// Each return option priced together with the chosen outbound option.
function computeReturnOptions(mcp: McpTools, requirements: Dict, transport: Dict, selected: Dict, placesResult: Dict): Promise<Leg[]> {
  return computeLegs(mcp, requirements, placesResult, pyOr(transport.return_options, []), (back) => flightsFor(transport, selected, back));
}

// Asks for the outbound option and then, when the research has return options, the return option. Each label
// shows the trip total that pick leads to. `picked` is the assembled result for the final pair.
async function askTransport(
  mcp: McpTools,
  hitl: Hitl,
  requirements: Dict,
  transport: Dict,
  placesResult: Dict,
  computed: Leg[],
): Promise<{ index: number; returnIndex: number | null; picked: Leg }> {
  const returnOptions: Dict[] = pyOr(transport.return_options, []);
  const { index } = await hitl.handleTransportChoice(
    `Choose your ${returnOptions.length ? "outbound " : ""}transport (fares are per person, one way; trip totals include the return journey` +
      `${returnOptions.length ? " (priced at the cheapest return until you choose it)" : ""}, stay, food and activities):`,
    computed.map((c) => c.label),
  );
  const outbound = computed[index];
  if (!returnOptions.length) return { index, returnIndex: null, picked: outbound };

  const back = await computeReturnOptions(mcp, requirements, transport, outbound.flightsResult.selected, placesResult);
  const { index: returnIndex } = await hitl.handleTransportChoice(
    `Choose your return transport (${transport.return_route} on ${transport.return_date}; fares are per person, one way; ` +
      "trip totals include your outbound choice, stay, food and activities):",
    back.map((c) => c.label),
  );
  return { index, returnIndex, picked: back[returnIndex] };
}

async function askNewBudget(hitl: Hitl): Promise<number | null> {
  const { answer } = await hitl.handleSubagentClarification("What is your new total budget in INR?");
  return Number(String(answer).replace(/[^\d.]/g, "")) || null;
}

type ComputedTransportOption = Leg;

export type TransportBudgetConflict =
  | { action: "change_transportation"; request: string }
  | { action: "adjust_places"; index: number }
  | { action: "raise_budget"; budget: number };

// Code detects "every option is over budget" and shows the menu; what happens next stays with the agents.
// Only asks and reports — it changes no state. Returns null when the menu does not apply.
export async function resolveTransportBudgetConflict(
  hitl: Hitl,
  computed: ComputedTransportOption[],
  requirements: Dict,
): Promise<TransportBudgetConflict | null> {
  const cap = get(requirements, "budget");
  if (cap == null || !computed.length || computed.some((c) => truthy(c.budget.ok))) return null;

  const cheapest = computed.reduce((best, c, i) => (c.budget.total < computed[best].budget.total ? i : best), 0);
  const pick = get(computed[cheapest].flightsResult, "selected", {});
  const mode = pick.mode ? `${pick.mode}: ` : "";
  const travellers = Number(get(requirements, "num_travellers", 1));
  const { index } = await hitl.handleBudgetResolution(
    `All transport options put your trip over your ₹${fmtFixed(cap, 0)} budget. The cheapest is ${mode}${pick.option} via ${pick.provider}, ` +
      `at a trip total of ₹${fmtFixed(computed[cheapest].budget.total, 0)} for ${travellers} traveller${travellers === 1 ? "" : "s"}. What would you like to do?`,
    ["Change transportation (different date, route or mode)", "Adjust trip places to fit the budget (keep the cheapest transport)", "Increase my budget"],
  );

  if (index === 0) {
    const { answer } = await hitl.handleSubagentClarification("What would you like to change about the transportation (for example a different date, route or mode)?");
    return answer.trim() ? { action: "change_transportation", request: answer.trim() } : null;
  }
  if (index === 1) return { action: "adjust_places", index: cheapest };

  const budget = await askNewBudget(hitl);
  return budget ? { action: "raise_budget", budget } : null;
}

// ask_user and choose_transport are plain, ungated tools: they already do real synchronous
// human interaction via Hitl (readline), so they're not registered here. Only set_indoor_mode is a
// genuine "approve/reject this one proposed action" decision, which is what this middleware
// actually models — see concepts note on why the split is this way.
export function createMainAgentHitlMiddleware(scratchpad: Scratchpad) {
  return humanInTheLoopMiddleware({
    interruptOn: {
      set_indoor_mode: {
        allowedDecisions: ["approve", "reject"],
        description: (toolCall) => formatWeatherBox(scratchpad.output("weather_search") as Dict | undefined, toolCall.args.reason as string | undefined),
      },
    },
  });
}

function mainAgentTools(spin: SpinUp, hitl: Hitl, mcp: McpTools, state: TripPlanState, draft: RequirementsDraft) {
  const { scratchpad } = spin;

  const extractRequirements = tool(
    (fields) => {
      draft.extracted = fields;
      return { extracted: fields };
    },
    {
      name: "extract_requirements",
      description:
        "Call this exactly once, as your only action, with every trip-requirement field you can " +
        "determine from the user's message. Omit a field entirely if it is not stated or unclear " +
        "— do not guess. If the user also said what they do NOT want (e.g. 'no temples'), put it " +
        "in exclude.",
      schema: ExtractedRequirementsSchema,
    },
  );

  const askUser = tool(({ question }) => hitl.handleSubagentClarification(question), {
    name: "ask_user",
    description:
      "Ask the user one free-text question and return the answer. An empty answer means the user just pressed Enter " +
      "(when you asked them to confirm the plan, that is their approval).",
    schema: z.object({ question: z.string() }),
  });

  const updatePreferences = tool(
    ({ add_exclude, remove_exclude }) => {
      scratchpad.addExclusions(add_exclude ?? []);
      scratchpad.removeExclusions(remove_exclude ?? []);
      return { exclude: scratchpad.preferences.exclude };
    },
    {
      name: "update_preferences",
      description:
        "Record what the user does NOT want (e.g. add_exclude: ['temples']) or wants back (remove_exclude). " +
        "Sub-agents receive this automatically and it is applied to their place and restaurant searches.",
      schema: z.object({
        add_exclude: z.array(z.string()).nullish().describe("Kinds of place or food to leave out"),
        remove_exclude: z.array(z.string()).nullish().describe("Earlier exclusions the user has withdrawn"),
      }),
    },
  );

  // Wraps update_preferences + send_message_to_subagent for the one case that needs both together: a plan
  // edit request. Which skill (if any) applies to this message is entirely place_agent's own call, made
  // from its spec's skill catalog — this tool sends only the plain facts of the request.
  const requestPlaceEdit = tool(
    async ({ description, add_exclude, remove_exclude }) => {
      const place = spin.latest(PLACES);
      if (!place) return { error: "place_agent has not been launched yet." };
      scratchpad.addExclusions(add_exclude ?? []);
      scratchpad.removeExclusions(remove_exclude ?? []);
      spin.send(place.id, JSON.stringify({ description }));
      await spin.wait([place.id]);
      return { task_id: place.id, status: place.status, question: place.status === "needs_clarification" ? place.reply?.needs_clarification : null };
    },
    {
      name: "request_place_edit",
      description:
        "Ask place_agent to apply a change the user described after seeing the plan (e.g. 'no temples', 'swap the museum'). " +
        "If they said what they do not want (or want back), pass it as add_exclude / remove_exclude too. Waits for the result.",
      schema: z.object({
        description: z.string().describe("The change, in the user's own words"),
        add_exclude: z.array(z.string()).nullish().describe("Kinds of place or food to leave out"),
        remove_exclude: z.array(z.string()).nullish().describe("Earlier exclusions the user has withdrawn"),
      }),
    },
  );

  // The interrupt (set up in createMainAgentHitlMiddleware) is the actual approval step —
  // this only runs at all once a human has approved it, so it just reports the outcome.
  // Recording the decision here (rather than trusting the model to repeat it later) is what
  // lets choose_transport preview totals with the real indoor setting instead of guessing.
  const setIndoorMode = tool(
    async ({ enabled }: { reason?: string; enabled?: boolean }) => {
      scratchpad.setIndoorMode(enabled ?? true);
      return { approved: true, decision: "approve" as const, indoor_mode: scratchpad.preferences.indoorMode };
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
      if (!scratchpad.requirements) return { error: "Requirements are not saved yet — the intake must finish first." };
      await spin.wait();
      await ensurePlaceResearch(spin);
      const transport = transportResearch(scratchpad);
      if (!pyOr(transport.options, []).length) return { error: "No transport options yet — launch transportation_agent first." };
      let requirements: Dict = { ...scratchpad.requireRequirements() };
      const placesResult = buildPlacesResult(scratchpad);
      let computed = await computeTransportOptions(mcp, requirements, transport, placesResult);

      const conflict = await resolveTransportBudgetConflict(hitl, computed, requirements);
      if (conflict?.action === "change_transportation") {
        return { action: "change_transportation", request: conflict.request };
      }
      if (conflict?.action === "raise_budget") {
        scratchpad.updateRequirements({ budget: conflict.budget });
        requirements = { ...scratchpad.requireRequirements() };
        computed = await computeTransportOptions(mcp, requirements, transport, placesResult);
      }

      const adjustPlaces = conflict?.action === "adjust_places";
      const hasReturn = pyOr(transport.return_options, []).length > 0;
      const pick = conflict?.action === "adjust_places"
        ? { index: conflict.index, returnIndex: hasReturn ? 0 : null, picked: computed[conflict.index] } // cheapest both ways, no return prompt
        : await askTransport(mcp, hitl, requirements, transport, placesResult, computed);
      state.recordTransportChoice(
        pick.index,
        pick.returnIndex,
        {
          requirements,
          flightsResult: pick.picked.flightsResult,
          placesResult,
          itinerary: pick.picked.itinerary,
          budget: pick.picked.budget,
          version: scratchpad.version,
        },
        adjustPlaces,
      );
      return { index: pick.index, return_index: pick.returnIndex, choice: pick.picked.label };
    },
    {
      name: "choose_transport",
      description:
        "Show the user every researched outbound transport option with an estimated trip total, then the return options, and record their picks. " +
        "If every option is over budget, asks the user what to do first (may return action change_transportation). " +
        "Waits for running research first.",
      schema: z.object({}),
    },
  );

  const presentPlanTool = tool(
    async ({ recheck_budget }) => {
      if (!scratchpad.requirements) return { error: "Requirements are not saved yet — the intake must finish first." };
      if (state.presentationCount > MAX_PLAN_REVISION_TURNS) {
        return { limit_reached: true, message: "The plan has been revised as often as allowed. Stop making changes and finish." };
      }
      const { budget } = await presentPlan(mcp, spin, hitl, state, truthy(recheck_budget));
      return {
        shown: true,
        budget: { cap: budget.cap, total: budget.total, ok: budget.ok, overage: budget.overage },
        budget_rechecks: state.recheckSummary,
      };
    },
    {
      name: "present_plan",
      description:
        "Assemble the itinerary from the research so far, show it to the user and return a short budget summary. " +
        "Pass recheck_budget=true to first ask the place agent to cut costs when the user wants the plan to fit the budget.",
      schema: z.object({ recheck_budget: z.boolean().nullish() }),
    },
  );

  return [...spin.langchainTools(), extractRequirements, askUser, updatePreferences, requestPlaceEdit, chooseTransport, setIndoorMode, presentPlanTool];
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
  maxAttempts: number,
  state: TripPlanState,
): Promise<Plan> {
  const place = spin.latest(PLACES);
  if (!place) return plan;
  let current = plan;
  for (let n = 0; n < maxAttempts && !truthy(current.budget.ok); n++) {
    const attempt = state.budgetAttempts.length + 1;
    console.log(`  [Main Agent] [budget] Over by ₹${fmtFixed(current.budget.overage, 0)} — asking place agent to re-check (attempt ${attempt})`);
    spin.send(place.id, JSON.stringify({ budget_feedback: budgetFeedback(attempt, current) }));
    await spin.wait([place.id]);

    // The Main Agent's LLM is not running during a re-check, so a question raised here goes to the user.
    while (place.status === "needs_clarification") {
      const { answer } = await hitl.askUser(`The place agent asks: ${place.reply?.needs_clarification}`);
      spin.send(place.id, answer);
      await spin.wait([place.id]);
    }
    if (place.status !== "done") {
      console.log(`  [Main Agent] [budget] Budget re-check ended: ${place.error ?? place.status}`);
      break;
    }

    const placesResult = buildPlacesResult(spin.scratchpad);
    const next: Plan = { ...current, placesResult, ...(await assemble(mcp, current.requirements, current.flightsResult, placesResult, current.itinerary)) };
    state.recordBudgetAttempt({ attempt, total: next.budget.total });
    if (next.budget.total >= current.budget.total) break;
    current = next;
  }
  return current;
}

async function resolveOverBudget(mcp: McpTools, spin: SpinUp, hitl: Hitl, plan: Plan, state: TripPlanState): Promise<Plan> {
  const { index } = await hitl.handleBudgetResolution(
    `The plan is still over your ₹${fmtFixed(plan.budget.cap, 0)} budget by ₹${fmtFixed(plan.budget.overage, 0)}. What would you like to do?`,
    [`Keep this plan (₹${fmtFixed(plan.budget.total, 0)})`, "Switch to a cheaper transport", "Raise my budget"],
  );

  if (index === 1) {
    const transport = transportResearch(spin.scratchpad);
    if (!pyOr(transport.options, []).length) return plan;
    const computed = await computeTransportOptions(mcp, plan.requirements, transport, plan.placesResult);
    const { index, returnIndex, picked } = await askTransport(mcp, hitl, plan.requirements, transport, plan.placesResult, computed);
    // Recorded so a later rebuild (after a plan edit) keeps the switched transport.
    state.recordTransportChoice(index, returnIndex);
    return { ...plan, flightsResult: picked.flightsResult, itinerary: picked.itinerary, budget: picked.budget };
  }

  if (index === 2) {
    const amount = await askNewBudget(hitl);
    if (!amount) return plan;
    spin.scratchpad.updateRequirements({ budget: amount });
    const requirements = { ...plan.requirements, budget: amount };
    const raised: Plan = { ...plan, requirements, ...(await assemble(mcp, requirements, plan.flightsResult, plan.placesResult, plan.itinerary)) };
    return recheckBudget(mcp, spin, hitl, raised, 1, state);
  }

  return plan;
}

// Assembles the plan once. Reuses choose_transport's cached assemble() result for the picked
// option when it's still valid (same budget cap, traveller count and no new research since), instead of
// recomputing the same deterministic merge_plan/budget_check call — see concepts/human-in-the-loop.md for why
// the preview now uses the real indoor_mode, which is what makes this cache trustworthy.
async function buildPlan(mcp: McpTools, spin: SpinUp, state: TripPlanState): Promise<Plan> {
  // Only waits for sub-agents the Main Agent launched; code never launches research itself.
  await spin.wait();

  const { scratchpad } = spin;
  const requirements: Dict = { ...scratchpad.requireRequirements() };
  await ensurePlaceResearch(spin);
  const transport = transportResearch(scratchpad);
  const options: Dict[] = pyOr(transport.options, []);
  const returnOptions: Dict[] = pyOr(transport.return_options, []);
  const pickFrom = (list: Dict[], i: number | null) => list[Math.max(0, Math.min(i ?? 0, list.length - 1))];
  const { transportIndex, returnIndex } = state.transportIndices;
  const flightsResult = flightsFor(
    transport,
    options.length ? pickFrom(options, transportIndex) : {},
    returnOptions.length ? pickFrom(returnOptions, returnIndex) : null,
  );

  const cached = state.cachedAssembly(scratchpad.version, flightsResult, requirements);
  if (cached) {
    console.log("  [Main Agent] [budget] Reusing the total already computed when the transport was chosen");
    return { requirements, flightsResult, ...cached };
  }

  const placesResult = buildPlacesResult(scratchpad);
  console.log("  [Main Agent] [itinerary] Assembling day-by-day itinerary layout");
  console.log("  [Main Agent] [budget] Calculating trip budget & expenses");
  return { requirements, flightsResult, placesResult, ...(await assemble(mcp, requirements, flightsResult, placesResult, state.previousItinerary)) };
}

async function fitPlanToBudget(mcp: McpTools, spin: SpinUp, hitl: Hitl, plan: Plan, state: TripPlanState): Promise<Plan> {
  const initialTotal = plan.budget.total;
  let next = await recheckBudget(mcp, spin, hitl, plan, settings.budgetRetryLimit, state);
  if (!truthy(next.budget.ok)) next = await resolveOverBudget(mcp, spin, hitl, next, state);
  state.recordRecheckSummary(initialTotal, next.budget.total);
  return next;
}

// Builds the plan from the scratchpad, trims it to the budget when asked (or when the user chose to keep the
// cheapest transport and adjust places), shows it, and remembers it as the plan the user last saw.
async function presentPlan(mcp: McpTools, spin: SpinUp, hitl: Hitl, state: TripPlanState, recheck: boolean): Promise<Plan> {
  let plan = await buildPlan(mcp, spin, state);
  if (recheck || (state.isFirstPresentation && state.shouldAdjustPlaces && !truthy(plan.budget.ok))) {
    plan = await fitPlanToBudget(mcp, spin, hitl, plan, state);
  }
  state.recordShownPlan(plan, spin.scratchpad.version);
  hitl.showPlan(plan.itinerary, plan.budget, state.recheckSummary);
  return plan;
}

// What the Main Agent still owes the workflow when it stops, so it can be sent back to finish.
function unfinishedSteps(spin: SpinUp, state: TripPlanState): string[] {
  const steps: string[] = [];
  if (!spin.latest(TRANSPORT) || !spin.latest(PLACES)) {
    steps.push("STEP 2: call launch_subagent for both transportation_agent and place_agent, then wait_for_subagents");
  }
  if (state.transportIndices.transportIndex === null) steps.push("STEP 3: call choose_transport");
  if (state.isFirstPresentation) steps.push("STEP 4: call present_plan, then ask_user to confirm the plan");
  return steps;
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
    const scratchpad = new Scratchpad();
    const spin = new SpinUp(mcp, summarizeResearch, authPrincipal, scratchpad);
    const state = new TripPlanState();
    const draft = new RequirementsDraft();
    const mainAgent = new Agent(MAIN_AGENT_SPEC, mcp, {
      sessionId: "main",
      checkpointer: new MemorySaver(),
      principal: authPrincipal,
      tools: mainAgentTools(spin, channel, mcp, state, draft),
      resolveInterrupt: (request) => channel.reviewToolCalls(request),
      middleware: [createMainAgentHitlMiddleware(scratchpad)],
      facts: () => `\n\nToday's date is: ${todayIso()}.`,
    });
    const session = new MainAgentSession(mainAgent);


    const MAX_STEP_NUDGES = 3;

    let decision = await session.send(request); // the one intake LLM call — extract_requirements

    // The user chose to stop (for example because search is down): nothing further is planned or shown.
    const cancelled = () => truthy(decision.cancelled);
    const stopped = () => {
      console.log("\nPlanning stopped.");
      return { cancelled: true, reason: decision.reason ?? null, subagent_tasks: spin.board() };
    };

    if (cancelled()) return stopped();

    // Code-driven slot-filling for whatever extraction didn't determine. A field the model actually returned
    // — even `budget: null` for "no limit", or `interests: []` for "none" — counts as given, so it's never
    // asked again; only a field genuinely absent from `draft.extracted` is missing.
    async function collectField(field: string): Promise<unknown> {
      let question = FIELD_QUESTIONS[field];
      for (let attempt = 0; attempt < MAX_FIELD_RETRIES; attempt++) {
        const { answer } = await channel.askUser(question);
        const parsed = parseAndValidateField(field, answer);
        if (parsed.ok) return parsed.value;
        question = `${parsed.error} ${FIELD_QUESTIONS[field]}`;
      }
      return undefined;
    }

    for (const field of REQUIRED_FIELDS) {
      if (field in draft.extracted && draft.extracted[field] !== "") continue;
      const value = await collectField(field);
      if (value === undefined) return stopped(); // exhausted retries on a required field
      draft.answers[field] = value;
    }
    for (const field of OPTIONAL_FIELDS) {
      if (field in draft.extracted) continue;
      const value = await collectField(field);
      if (value !== undefined) draft.answers[field] = value;
    }

    // Code saves the requirements itself — everything here was already checked, either by
    // ExtractedRequirementsSchema (extraction) or parseAndValidateField (typed answers), so there is nothing
    // left for an LLM turn to decide by copying it into a tool call. `exclude` is a preference, not a trip
    // requirement, so it's split off before validating and saved separately.
    const { exclude, ...fields } = { ...draft.extracted, ...draft.answers };
    scratchpad.setRequirements(validateRequirements(fields));
    if (exclude?.length) scratchpad.addExclusions(exclude);

    decision = await session.send(
      `Requirements saved: ${JSON.stringify(scratchpad.requirements)}` +
        (exclude?.length ? ` Excluded: ${JSON.stringify(exclude)}.` : "") +
        " Continue with STEP 2.",
    );

    if (cancelled()) return stopped();

    for (let n = 0; n < MAX_STEP_NUDGES && !cancelled(); n++) {
      const unfinished = unfinishedSteps(spin, state);
      if (!unfinished.length) break;
      decision = await session.send(`You stopped before finishing. Still to do: ${unfinished.join("; ")}. Do that now, then carry on with the remaining steps.`);
    }

    if (cancelled()) return stopped();

    // The Main Agent normally shows the final plan itself; this covers a plan that was never shown, or
    // research that changed after it was shown, so the user never confirms a stale plan.
    const plan = state.planIfCurrent(scratchpad.version) ?? (await presentPlan(mcp, spin, channel, state, false));

    const booking = await offerBooking(authPrincipal, channel, plan);

    return {
      requirements: plan.requirements,
      flights_result: plan.flightsResult,
      booking,
      itinerary: plan.itinerary,
      budget_status: plan.budget,
      budget_attempts: state.budgetAttempts,
      subagent_tasks: spin.board(),
    };
  } finally {
    await mcp.close();
  }
}
