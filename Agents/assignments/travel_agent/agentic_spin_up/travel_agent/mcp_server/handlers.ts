import { z } from "zod";
import {
  TRIP_LEGS,
  buildItinerary,
  checkBudget,
  getForecast,
  isBadWeather,
  searchAccommodation,
  searchPlaces,
  searchProblem,
  searchRestaurants,
  searchTransport,
} from "../tools/index.ts";
import { type Dict, addDays, get, numStr, pyOr, pyRound, truthy } from "../tools/util.ts";

export type Log = (message: string) => unknown;

export interface ToolDefinition {
  description: string;
  inputSchema: z.ZodRawShape;
  run: (args: any, log: Log) => Promise<unknown>;
}

const dict = z.record(z.string(), z.any());
const int = z.coerce.number().int();
const limit = (what: string) => z.coerce.number().nullish().describe(`Budget re-check only: ${what}`);
const exclude = z.array(z.string()).nullish().describe("Kinds of place or food to leave out, e.g. ['temples']; matched against name, category and type");

// An empty answer while every provider is failing is an outage, not "nothing there". Say so, so the agent
// does not blame the destination or the interests.
async function flagOutage<T extends object>(result: T, empty: boolean, log: Log): Promise<T> {
  const problem = empty ? searchProblem() : null;
  if (!problem) return result;
  await log(`[search] No results: ${problem}`);
  return { ...result, search_problem: problem };
}

// Shared by the stdio MCP server and the in-process tests, so both run identical tool code.
export const TOOLS: Record<string, ToolDefinition> = {
  transport_search: {
    description:
      "Flight / train / bus options for a route and date, sorted cheapest first. " +
      "Pass num_days to also get the return options (destination → source) on the last day of the trip.",
    inputSchema: {
      source: z.string(),
      destination: z.string(),
      start_date: z.string(),
      travellers: int.default(1),
      num_days: int.nullish().describe("Trip length in days; when given, the result also has return_options"),
    },
    async run({ source, destination, start_date, travellers, num_days }, log) {
      await log(`[transport] Researching transport: ${source} → ${destination} for ${travellers} traveller(s) on ${start_date}`);
      const outbound = await searchTransport(source, destination, start_date, travellers);
      const returnDate = num_days ? addDays(start_date, num_days - 1) : null;
      if (!returnDate) return outbound;
      await log(`[transport] Researching the return: ${destination} → ${source} on ${returnDate}`);
      const back = await searchTransport(destination, source, returnDate, travellers);
      return { ...outbound, return_date: returnDate, return_route: back.route, return_options: back.options };
    },
  },

  weather_search: {
    description: "Destination forecast for the trip dates, plus a `bad_weather` flag.",
    inputSchema: { destination: z.string(), num_days: int, start_date: z.string().default("") },
    async run({ destination, num_days, start_date }, log) {
      await log(`[weather] Querying ${num_days}-day weather forecast for ${destination}`);
      const forecast = await getForecast(destination, num_days, start_date || null);
      return { ...forecast, bad_weather: isBadWeather(forecast) };
    },
  },

  places_search: {
    description: "Attractions matching the traveller's interests.",
    inputSchema: {
      destination: z.string(),
      interests: z.array(z.string()),
      indoor_only: z.boolean().default(false),
      max_cost_per_person: limit("keep attractions whose estimated entry cost per person is at or under this INR amount"),
      exclude,
    },
    async run({ destination, interests, indoor_only, max_cost_per_person, exclude }, log) {
      const topics = interests.length ? interests.join(", ") : "top sights";
      const left = exclude?.length ? ` (leaving out: ${exclude.join(", ")})` : "";
      await log(`[place] Searching attractions in ${destination} for: ${topics}${indoor_only ? " (indoor only)" : ""}${left}`);
      const places = await searchPlaces(destination, interests, indoor_only, max_cost_per_person ?? null, exclude ?? []);
      return flagOutage({ places }, !places.length, log);
    },
  },

  restaurants_search: {
    description: "Breakfast, lunch and dinner venues, keyed by meal name.",
    inputSchema: {
      destination: z.string(),
      interests: z.array(z.string()),
      max_cost_per_person: limit("keep venues whose estimated meal cost per person is at or under this INR amount"),
      exclude,
    },
    async run({ destination, interests, max_cost_per_person, exclude }, log) {
      await log(`[restaurant] Finding breakfast, lunch & dinner spots in ${destination}`);
      const meals = await searchRestaurants(destination, interests, max_cost_per_person ?? null, exclude ?? []);
      return flagOutage(meals, Object.values(meals).every((venues: any) => !venues.length), log);
    },
  },

  accommodation_search: {
    description: "Accommodation candidates; pass start_date + nights for real nightly rates.",
    inputSchema: {
      destination: z.string(),
      travellers: int,
      start_date: z.string().default(""),
      nights: int.default(0),
      max_price_per_night: limit("keep stays whose nightly rate is at or under this INR amount"),
    },
    async run({ destination, travellers, start_date, nights, max_price_per_night }, log) {
      await log(`[accommodation] Finding stays in ${destination} for ${travellers} traveller(s)`);
      const options = await searchAccommodation(destination, travellers, start_date || null, nights || null, max_price_per_night ?? null);
      return flagOutage({ accommodation_options: options }, !options.length, log);
    },
  },

  merge_plan: {
    description:
      "Assemble researched transport + destination data into a day-by-day itinerary. " +
      "Pass previous_itinerary (the last assembled itinerary) after an edit, so places that are still in " +
      "places_result keep their previous day and only the changed ones are re-placed.",
    inputSchema: { requirements: dict, flights_result: dict, places_result: dict, previous_itinerary: dict.nullish() },
    async run({ requirements, flights_result, places_result, previous_itinerary }, log) {
      await log(`[itinerary] Calculating geometry and assembling ${pyOr(requirements.num_days, 2)}-day itinerary layout`);
      return { itinerary: buildItinerary(requirements, flights_result, places_result, previous_itinerary ?? null) };
    },
  },

  // Deterministic: the LLM never approximates the budget.
  budget_check: {
    description: "Deterministic combined-trip budget check on the merged plan.",
    inputSchema: { requirements: dict, places_result: dict, itinerary: dict, budget_cap: z.number().nullable().optional() },
    async run({ requirements, places_result, itinerary, budget_cap }, log) {
      const travellers = pyOr(requirements.num_travellers, 1);
      await log(`[budget] Verifying total estimated expenses against budget cap: ₹${truthy(budget_cap) ? numStr(budget_cap) : "No Cap"}`);

      const cards: Dict[] = get(itinerary, "cards", []);
      const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);
      const cost = (item: Dict) => pyOr(get(item, "est_cost", 0), 0);
      const guessed = (item: Dict) => get(item, "estimated") === true;
      const scheduled = cards.flatMap((c) => get(c, "activities", []) as Dict[]);
      const activities: Dict[] = scheduled.length ? scheduled : get(places_result, "places", []);
      const activityCost = sum(activities.map(cost));
      const meals = cards.flatMap((c) => get(c, "meals", []) as Dict[]);
      const foodCost = meals.length ? pyRound(sum(meals.map(cost)) * travellers, 2) : null;

      // With a chosen return leg the trip pays both fares; without one the outbound fare stands in for it.
      const out = get(itinerary, "transport", {});
      const back = get(itinerary, "return_transport", null);
      const legs: Dict[] = truthy(back) ? [out, back] : Array(TRIP_LEGS).fill(out);
      const legPrice = (leg: Dict) => get(leg, "price", 0);
      const status = checkBudget(
        sum(legs.map(legPrice)),
        get(get(itinerary, "accommodation", {}), "price_per_night", 0),
        pyOr(requirements.num_days, 2),
        travellers,
        activityCost,
        budget_cap ?? null,
        foodCost,
        {
          transport: sum(legs.filter(guessed).map(legPrice)),
          lodging: guessed(get(itinerary, "accommodation", {})),
          foodCost: pyRound(sum(meals.filter(guessed).map(cost)) * travellers, 2),
          activityCost: sum(activities.filter(guessed).map(cost)),
        },
      );
      return { budget_status: { ...status, transport_legs: TRIP_LEGS } };
    },
  },
};
