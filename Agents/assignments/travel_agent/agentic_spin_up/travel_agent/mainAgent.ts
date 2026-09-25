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
import { MAX_PROPOSAL_TRIES } from "./tools/proposals.ts";
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

// Plan-assembly state for one trip, updated by choose_transport/present_plan and read by buildPlan. Facts the
// agents share (requirements, preferences, research results) live in the Scratchpad instead. Named methods,
// rather than raw field access, so each place that changes plan state says what it's doing at the call site.
class TripPlanState {
  private transportIndex: number | null = null;
  private returnIndex: number | null = null; // null when the research has no return options
  private plan: Plan | null = null; // the plan last shown to the user
  private planVersion = -1; // scratchpad version that plan was built from
  private presentations = 0;
  private recheck: BudgetRecheck | null = null;
  private attempts: Dict[] = []; // budget re-check attempts made so far

  // choose_transport records every pick here; "switch to a cheaper transport" (from the over-budget menu)
  // also calls this after the user re-picks.
  recordTransportChoice(index: number, returnIndex: number | null): void {
    this.transportIndex = index;
    this.returnIndex = returnIndex;
  }

  get transportIndices(): { transportIndex: number | null; returnIndex: number | null } {
    return { transportIndex: this.transportIndex, returnIndex: this.returnIndex };
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

// One option's line in a transport prompt: what it is and its fare only — no per-option budget math.
// The trip-total effect of a pick is shown later, once, by buildPlan/present_plan.
function optionLabel(option: Dict): string {
  const notes = truthy(option.notes) ? ` (${option.notes})` : "";
  const modeTag = option.mode ? `[${option.mode}] ` : "";
  return `${modeTag}${option.option} via ${option.provider} — ${option.travel_time} — ${fareText(option)}${notes}`;
}

type Leg = { label: string; flightsResult: Dict };

// Plain synchronous mapping from researched options to their labels — no MCP calls, no assembly.
// The full itinerary/budget is only computed once, after the user has picked, by buildPlan.
function computeLegs(legOptions: Dict[], flights: (option: Dict) => Dict): Leg[] {
  return legOptions.map((option) => ({ label: optionLabel(option), flightsResult: flights(option) }));
}

// Each outbound option is priced with the cheapest return, until the user picks the return.
function computeTransportOptions(transport: Dict): Leg[] {
  const cheapestReturn: Dict | null = pyOr(transport.return_options, [])[0] ?? null;
  return computeLegs(pyOr(transport.options, []), (option) => flightsFor(transport, option, cheapestReturn));
}

// Each return option priced together with the chosen outbound option.
function computeReturnOptions(transport: Dict, selected: Dict): Leg[] {
  return computeLegs(pyOr(transport.return_options, []), (back) => flightsFor(transport, selected, back));
}

// Asks for the outbound option and then, when the research has return options, the return option.
// `picked` is only the fare-level pick — no assembled itinerary/budget; that comes later from buildPlan.
async function askTransport(
  hitl: Hitl,
  transport: Dict,
  computed: Leg[],
): Promise<{ index: number; returnIndex: number | null; picked: Leg }> {
  const returnOptions: Dict[] = pyOr(transport.return_options, []);
  const { index } = await hitl.handleTransportChoice(
    `Choose your ${returnOptions.length ? "outbound " : ""}transport (fares are per person, one way):`,
    computed.map((c) => c.label),
  );
  const outbound = computed[index];
  if (!returnOptions.length) return { index, returnIndex: null, picked: outbound };

  const back = computeReturnOptions(transport, outbound.flightsResult.selected);
  const { index: returnIndex } = await hitl.handleTransportChoice(
    `Choose your return transport (${transport.return_route} on ${transport.return_date}; fares are per person, one way):`,
    back.map((c) => c.label),
  );
  return { index, returnIndex, picked: back[returnIndex] };
}

// The same style of before/after box as formatChangeBox (tools/proposals.ts), for the one lever that isn't
// an LLM proposal: transport is picked by the user directly from a list, so there's nothing for
// humanInTheLoopMiddleware to intercept — see current_implementation.md step 7's noted limitation.
function formatTransportChangeBox(current: Plan, picked: Leg, newBudget: Dict, attempt: number): string {
  const lines = [
    `\nSwitch transport?\n`,
    `┌ Proposed Change (try ${attempt} of ${MAX_PROPOSAL_TRIES}) ─────────────────────────────`,
    `│ To      : ${picked.label}`,
    `│ Trip total: ₹${fmtFixed(current.budget.total, 0)} → ₹${fmtFixed(newBudget.total, 0)}`,
    `└───────────────────────────────────────────────────────────────────`,
  ];
  return lines.join("\n");
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
      // Same draft → propose → approve flow as a budget re-check (current_implementation.md step 8): the
      // user's own edit requests get the same before/after approval as an automatic cost cut. The
      // clarification loop is handled here too (rather than handed back to the Main Agent, the way STEP 2's
      // launch does) so staging — and with it, propose_change's ability to find a draft — stays open across
      // it; closing and reopening staging around a round trip through the Main Agent would otherwise discard
      // the very search results a clarification answer is about to unblock.
      scratchpad.setStaging(true);
      try {
        spin.send(place.id, JSON.stringify({ description }));
        await spin.wait([place.id]);
        while (place.status === "needs_clarification") {
          const { answer } = await hitl.askUser(`The place agent asks: ${place.reply?.needs_clarification}`);
          spin.send(place.id, answer);
          await spin.wait([place.id]);
        }
      } finally {
        scratchpad.setStaging(false);
        hitl.proposals.clear();
      }
      return { task_id: place.id, status: place.status, question: null };
    },
    {
      name: "request_place_edit",
      description:
        "Ask place_agent to apply a change the user described after seeing the plan (e.g. 'no temples', 'swap the museum'). " +
        "If they said what they do not want (or want back), pass it as add_exclude / remove_exclude too. Waits for the " +
        "result, answering any clarifying question place_agent asks along the way itself — you'll never see a " +
        "needs_clarification status back from this call.",
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
  // lets buildPlan assemble with the real indoor setting instead of guessing.
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
      const computed = computeTransportOptions(transport);
      const pick = await askTransport(hitl, transport, computed);
      state.recordTransportChoice(pick.index, pick.returnIndex);
      return { index: pick.index, return_index: pick.returnIndex, choice: pick.picked.label };
    },
    {
      name: "choose_transport",
      description:
        "Show the user every researched outbound transport option by fare and travel time, then the return options, and record their picks. " +
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
        "If the plan is over budget, this shows the user a 4-way menu itself (change a place, switch transport, " +
        "switch accommodation, or proceed anyway) and handles it before returning. Pass recheck_budget=true when " +
        "the user asks to fit the budget after already seeing the plan, to show that menu again.",
      schema: z.object({ recheck_budget: z.boolean().nullish() }),
    },
  );

  return [...spin.langchainTools(), extractRequirements, askUser, updatePreferences, requestPlaceEdit, chooseTransport, setIndoorMode, presentPlanTool];
}


// One day's centre point, averaged from its activities' coordinates — used so a "cheaper stay" search can be
// scoped to stay within reach of every day, the same centroid buildDayCards already computes per day for meal
// picking (travel_agent/tools/itinerary.ts). Days with no located activities are skipped.
function dayCenters(itinerary: Dict): [number, number][] {
  const cards: Dict[] = get(itinerary, "cards", []);
  return cards
    .map((c) => (get(c, "activities", []) as Dict[]).filter((a) => a.lat != null && a.lon != null))
    .filter((pts) => pts.length)
    .map((pts) => [pts.reduce((s, p) => s + p.lat, 0) / pts.length, pts.reduce((s, p) => s + p.lon, 0) / pts.length] as [number, number]);
}

// `lever` scopes what place_agent is allowed to change this re-check — the user's explicit budget-menu pick
// (current_implementation.md step 6). See agent-skills/budget_cut. There's no unscoped "any" any more: the
// automatic pre-menu cut it used to describe was removed (decision 3 — no cutting without the user choosing
// a lever first).
function budgetFeedback(attempt: number, plan: Plan, lever: "places" | "accommodation"): Dict {
  const cards: Dict[] = get(plan.itinerary, "cards", []);
  const stay = get(plan.itinerary, "accommodation", {});
  return {
    attempt,
    lever,
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
    // Only meaningful for lever "accommodation" — the day-centre points accommodation_search's `near`
    // argument should be given, so a cheaper stay is never proposed far from the trip's planned places.
    ...(lever === "accommodation" ? { day_centers: dayCenters(plan.itinerary) } : {}),
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
  lever: "places" | "accommodation",
): Promise<Plan> {
  const place = spin.latest(PLACES);
  if (!place) return plan;
  let current = plan;
  // Search results place_agent writes this turn are drafts, published only through an approved
  // propose_change — see current_implementation.md steps 2-4. Closing staging (in `finally`) discards
  // anything left un-approved, so a rejected or abandoned search never leaks into the next read.
  spin.scratchpad.setStaging(true);
  // The radius guardrail (step 5): code injects the day centres into every accommodation_search call for
  // this lever, so it never depends on the model remembering to pass `near` itself.
  if (lever === "accommodation") spin.scratchpad.setAccommodationRadius(dayCenters(current.itinerary));
  try {
    for (let n = 0; n < maxAttempts && !truthy(current.budget.ok); n++) {
      const attempt = state.budgetAttempts.length + 1;
      console.log(`  [Main Agent] [budget] Over by ₹${fmtFixed(current.budget.overage, 0)} — asking place agent to re-check (attempt ${attempt}, lever: ${lever})`);
      spin.send(place.id, JSON.stringify({ budget_feedback: budgetFeedback(attempt, current, lever) }));
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
  } finally {
    spin.scratchpad.setStaging(false);
    spin.scratchpad.setAccommodationRadius(null);
    // A retry limit used up (or a candidate rejected) during this visit shouldn't carry into an unrelated
    // later request — see ProposalTracker.clear() and current_implementation.md's review notes.
    hitl.proposals.clear();
  }
  return current;
}

type BudgetLever = "places" | "transport" | "accommodation";

const LEVER_LABEL: Record<BudgetLever, string> = {
  places: "Change a place to something cheaper",
  transport: "Switch to a cheaper transport",
  accommodation: "Switch to cheaper accommodation",
};

// Transport isn't an LLM proposal (it's the user's own pick from a list — see formatTransportChangeBox above),
// so it gets its own approval loop here rather than going through propose_change. Up to MAX_PROPOSAL_TRIES
// re-picks, each shown as a before/after box, matching the same "try N of 3" rule as every other lever.
async function switchTransport(mcp: McpTools, spin: SpinUp, hitl: Hitl, plan: Plan, state: TripPlanState): Promise<Plan> {
  const transport = transportResearch(spin.scratchpad);
  if (!pyOr(transport.options, []).length) return plan;
  for (let attempt = 1; attempt <= MAX_PROPOSAL_TRIES; attempt++) {
    const computed = computeTransportOptions(transport);
    const { index, returnIndex, picked } = await askTransport(hitl, transport, computed);
    const assembled = await assemble(mcp, plan.requirements, picked.flightsResult, plan.placesResult, plan.itinerary);
    console.log(formatTransportChangeBox(plan, picked, assembled.budget, attempt));
    const { answer } = await hitl.askYesNo("Apply this transport change?");
    if (answer) {
      state.recordTransportChoice(index, returnIndex);
      return { ...plan, flightsResult: picked.flightsResult, ...assembled };
    }
  }
  console.log(`\nKept your current transport — ${MAX_PROPOSAL_TRIES} different options were tried and none were approved.`);
  return plan;
}

// The 4-way over-budget menu (current_implementation.md step 6): no automatic cutting — the user always
// picks the lever. A `while` loop, not recursion, so repeat visits are bounded by removing a lever that
// produced no saving, rather than relying on MAX_PLAN_REVISION_TURNS (which only counts present_plan calls,
// not menu visits inside one). Every place/restaurant/accommodation change inside a lever is itself approved
// per item through propose_change (recheckBudget → the place_agent turn); this loop only decides *which*
// lever to try and when to stop offering it.
async function resolveOverBudget(mcp: McpTools, spin: SpinUp, hitl: Hitl, plan: Plan, state: TripPlanState): Promise<Plan> {
  let current = plan;
  let available: BudgetLever[] = ["places", "transport", "accommodation"];

  while (!truthy(current.budget.ok) && available.length) {
    const proceedLabel = `Proceed with this plan anyway (₹${fmtFixed(current.budget.total, 0)})`;
    const { index } = await hitl.handleBudgetResolution(
      `The plan is still over your ₹${fmtFixed(current.budget.cap, 0)} budget by ₹${fmtFixed(current.budget.overage, 0)}. What would you like to do?`,
      [...available.map((l) => LEVER_LABEL[l]), proceedLabel],
    );
    if (index >= available.length) return current; // "proceed"

    const lever = available[index];
    const before = current.budget.total;
    current =
      lever === "transport"
        ? await switchTransport(mcp, spin, hitl, current, state)
        : await recheckBudget(mcp, spin, hitl, current, settings.budgetRetryLimit, state, lever);

    if (current.budget.total >= before) {
      // Nothing was approved for this lever — drop it so the user isn't offered a dead end again.
      available = available.filter((l) => l !== lever);
      if (lever === "accommodation") {
        // Deliberately lever-neutral: this fires whether nothing cheaper was found, nothing was within reach
        // of the planned places, or the user rejected every candidate offered — code can't tell which from
        // here without more plumbing than the distinction is worth.
        console.log("\nNo cheaper accommodation was approved.");
      }
    }
  }
  return current;
}

// Assembles the plan once from the research recorded in the scratchpad and the transport indices
// choose_transport recorded. There is no cache to reuse any more — with the per-option precompute gone
// (see step 1 of current_implementation.md), this is already the only assemble() call for a normal
// present_plan turn, so there is nothing left to save by caching it.
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

  const placesResult = buildPlacesResult(scratchpad);
  console.log("  [Main Agent] [itinerary] Assembling day-by-day itinerary layout");
  console.log("  [Main Agent] [budget] Calculating trip budget & expenses");
  return { requirements, flightsResult, placesResult, ...(await assemble(mcp, requirements, flightsResult, placesResult, state.previousItinerary)) };
}

// No automatic cutting (current_implementation.md decision 3) — straight to the 4-way menu, which is the
// only thing that changes the plan from here.
async function fitPlanToBudget(mcp: McpTools, spin: SpinUp, hitl: Hitl, plan: Plan, state: TripPlanState): Promise<Plan> {
  const initialTotal = plan.budget.total;
  const next = await resolveOverBudget(mcp, spin, hitl, plan, state);
  state.recordRecheckSummary(initialTotal, next.budget.total);
  return next;
}

// Builds the plan from the scratchpad, shows it, and remembers it as the plan the user last saw. The
// over-budget menu appears on its own the first time a plan is over budget, and again whenever present_plan
// is called with recheck_budget:true (current_implementation.md decision 2) — never automatically otherwise.
async function presentPlan(mcp: McpTools, spin: SpinUp, hitl: Hitl, state: TripPlanState, recheck: boolean): Promise<Plan> {
  let plan = await buildPlan(mcp, spin, state);
  if (!truthy(plan.budget.ok) && (recheck || state.isFirstPresentation)) {
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
    const spin = new SpinUp(mcp, summarizeResearch, authPrincipal, scratchpad, channel);
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
