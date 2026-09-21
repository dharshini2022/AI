import { z } from "zod";
import {
  buildItinerary,
  checkBudget,
  getForecast,
  isBadWeather,
  searchAccommodation,
  searchPlaces,
  searchRestaurants,
  searchTransport,
} from "../tools/index.ts";
import { type Dict, get, numStr, pyOr, pyRound, truthy } from "../tools/util.ts";

export type Log = (message: string) => unknown;

export interface ToolDefinition {
  description: string;
  inputSchema: z.ZodRawShape;
  run: (args: any, log: Log) => Promise<unknown>;
}

const dict = z.record(z.string(), z.any());
const int = z.coerce.number().int();
const limit = (what: string) => z.coerce.number().nullish().describe(`Budget re-check only: ${what}`);

// Shared by the stdio MCP server and the in-process tests, so both run identical tool code.
export const TOOLS: Record<string, ToolDefinition> = {
  transport_search: {
    description: "Flight / train / bus options for a route and date, sorted cheapest first.",
    inputSchema: { source: z.string(), destination: z.string(), start_date: z.string(), travellers: int.default(1) },
    async run({ source, destination, start_date, travellers }, log) {
      await log(`[transport] Researching transport: ${source} → ${destination} for ${travellers} traveller(s) on ${start_date}`);
      return searchTransport(source, destination, start_date, travellers);
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
    },
    async run({ destination, interests, indoor_only, max_cost_per_person }, log) {
      const topics = interests.length ? interests.join(", ") : "top sights";
      await log(`[place] Searching attractions in ${destination} for: ${topics}${indoor_only ? " (indoor only)" : ""}`);
      return { places: await searchPlaces(destination, interests, indoor_only, max_cost_per_person ?? null) };
    },
  },

  restaurants_search: {
    description: "Breakfast, lunch and dinner venues, keyed by meal name.",
    inputSchema: {
      destination: z.string(),
      interests: z.array(z.string()),
      max_cost_per_person: limit("keep venues whose estimated meal cost per person is at or under this INR amount"),
    },
    async run({ destination, interests, max_cost_per_person }, log) {
      await log(`[restaurant] Finding breakfast, lunch & dinner spots in ${destination}`);
      return searchRestaurants(destination, interests, max_cost_per_person ?? null);
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
      return { accommodation_options: options };
    },
  },

  merge_plan: {
    description: "Assemble researched transport + destination data into a day-by-day itinerary.",
    inputSchema: { requirements: dict, flights_result: dict, places_result: dict },
    async run({ requirements, flights_result, places_result }, log) {
      await log(`[itinerary] Calculating geometry and assembling ${pyOr(requirements.num_days, 2)}-day itinerary layout`);
      return { itinerary: buildItinerary(requirements, flights_result, places_result) };
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
      const scheduled = cards.flatMap((c) => get(c, "activities", []) as Dict[]);
      const activityCost = scheduled.length
        ? sum(scheduled.map((a) => pyOr(get(a, "est_cost", 0), 0)))
        : sum((get(places_result, "places", []) as Dict[]).map((p) => get(p, "est_cost", 0)));
      const mealCosts = cards.flatMap((c) => get(c, "meals", []) as Dict[]).map((m) => pyOr(get(m, "est_cost", 0), 0));
      const foodCost = mealCosts.length ? pyRound(sum(mealCosts) * travellers, 2) : null;

      const status = checkBudget(
        get(get(itinerary, "transport", {}), "price", 0),
        get(get(itinerary, "accommodation", {}), "price_per_night", 0),
        pyOr(requirements.num_days, 2),
        travellers,
        activityCost,
        budget_cap ?? null,
        foodCost,
      );
      return { budget_status: status };
    },
  },
};
