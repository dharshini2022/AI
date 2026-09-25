import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

vi.mock("../travel_agent/config.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../travel_agent/config.ts")>();
  return {
    ...mod,
    settings: { ...mod.settings, serpapiApiKey: "test-key", mapsProviders: ["serpapi"], usdToInr: 82.5, badWeatherRainPct: 60, searchCacheTtlMs: 0, searchFallbackCacheTtlMs: 0 },
  };
});
vi.mock("../travel_agent/tools/http.ts", async () => {
  const { fakeRequestJson, fakeRequestJsonDetailed } = await import("./fixtures/fakeHttp.ts");
  return { requestJson: fakeRequestJson, requestJsonDetailed: fakeRequestJsonDetailed };
});

const { checkBudget } = await import("../travel_agent/tools/pricing/budget.ts");
const { buildItinerary, haversineKm, renderCards } = await import("../travel_agent/tools/itinerary.ts");
const maps = await import("../travel_agent/tools/search/maps.ts");
const prices = await import("../travel_agent/tools/pricing/prices.ts");
const { searchTransport, slugify } = await import("../travel_agent/tools/search/transportation.ts");
const { getForecast, isBadWeather, shiftYear } = await import("../travel_agent/tools/search/weather.ts");
const { addDays, pyTitle } = await import("../travel_agent/tools/util.ts");

// Outputs recorded from the Python tools against the same canned HTTP responses.
const P = JSON.parse(readFileSync(new URL("./fixtures/parity.json", import.meta.url), "utf8"));

type Case = { args: any[]; kwargs?: Record<string, any>; out: any };

// The Python recordings predate the `estimated` flag, so parity compares everything else.
const withoutEstimated = (v: any): any =>
  Array.isArray(v)
    ? v.map(withoutEstimated)
    : v && typeof v === "object"
      ? Object.fromEntries(Object.entries(v).filter(([k]) => k !== "estimated").map(([k, x]) => [k, withoutEstimated(x)]))
      : v;

// The Python recording predates proximity-based meal tie-breaking: when two candidates are equally eligible
// (same "unused" tier), the TS version now prefers whichever is nearer the day's places, so the exact meal
// picked — and the stay-distance figures that depend on its coordinates — can differ from the recording.
// Structure, activities, transport, accommodation and everything else are still compared exactly.
const withoutMealPlacement = (itinerary: any): any => ({
  ...itinerary,
  total_travel_km: null,
  cards: itinerary.cards.map((c: any) => ({
    ...c,
    from_stay_km: null,
    to_stay_km: null,
    day_km: null,
    meals: c.meals.map((m: any) => ({ meal: m.meal, time: m.time })),
  })),
});

describe("parity with the Python tools", () => {
  it("check_budget", () => {
    for (const c of P.budget as Case[]) {
      // Nothing is flagged as an estimate in these cases, so the estimated part of the total is 0.
      const { estimated_total, ...status } = checkBudget(...(c.args as Parameters<typeof checkBudget>));
      expect(status).toEqual(c.out);
      expect(estimated_total).toBe(0);
    }
  });

  it("haversine_km", () => {
    for (const c of P.haversine as Case[]) expect(haversineKm(c.args[0], c.args[1])).toBeCloseTo(c.out, 9);
  });

  const helpers: Record<string, (...args: any[]) => unknown> = {
    cost_from_price_level: prices.costFromPriceLevel,
    norm_price_level: prices.normPriceLevel,
    clean_name: maps.cleanName,
    hours_str: maps.hoursStr,
    extract_price_and_url: prices.extractPriceAndUrl,
    slugify,
    title: pyTitle,
    add_days: addDays,
    shift_year: shiftYear,
  };
  for (const [name, fn] of Object.entries(helpers)) {
    it(name, () => {
      for (const c of P.helpers[name] as Case[]) expect(fn(...c.args), JSON.stringify(c.args)).toEqual(c.out);
    });
  }

  it("maps_url", () => {
    for (const c of P.helpers.maps_url as Case[]) expect(maps.mapsUrl(c.kwargs as any)).toEqual(c.out);
  });

  it("search_places", async () => {
    for (const c of P.search_places as Case[]) {
      expect(withoutEstimated(await maps.searchPlaces(c.args[0], c.args[1], c.args[2]))).toEqual(c.out);
    }
  });

  it("search_restaurants", async () => {
    for (const c of P.search_restaurants as Case[]) {
      expect(withoutEstimated(await maps.searchRestaurants(c.args[0], c.args[1]))).toEqual(c.out);
    }
  });

  it("search_accommodation", async () => {
    for (const c of P.search_accommodation as Case[]) {
      const stays = await maps.searchAccommodation(c.args[0], c.args[1], c.args[2], c.args[3]);
      // A stay with no listed price now gets a rating-based estimate instead of the Python list-position
      // guess, so those prices are not compared; every other field and every real rate still is.
      const unpriced = (stay: any) => (stay.estimated ? { ...stay, price_per_night: null } : stay);
      expect(withoutEstimated(stays.map(unpriced))).toEqual(c.out.map((stay: any, i: number) => (stays[i]?.estimated ? { ...stay, price_per_night: null } : stay)));
    }
  });

  it("search_transport", async () => {
    // The TypeScript tool sorts options cheapest first; the Python recording kept source order. It also
    // no longer searches the web for links, so `source` is always "deep_link_search" and there are none.
    // Munnar has no railhead, so the train is not offered there, and every formula fare is an estimate.
    // The fare is one number, the per-person fare the budget uses, where the Python tool printed a range.
    for (const c of P.search_transport as Case[]) {
      const noTrain = /munnar/i.test(c.args[1]);
      const expected = {
        ...c.out,
        source: "deep_link_search",
        organic_search_results: [],
        options: c.out.options
          .filter((o: any) => !(noTrain && o.mode === "train"))
          .map((o: any) => ({ ...o, approx_fare: `₹${o.price / Math.max(1, c.args[3])}`, estimated: true, fare_source: "estimate" }))
          .sort((a: any, b: any) => a.price - b.price),
      };
      expect(await searchTransport(c.args[0], c.args[1], c.args[2], c.args[3])).toEqual(expected);
    }
  });

  it("get_forecast / is_bad_weather", async () => {
    for (const c of P.get_forecast as (Case & { bad: boolean })[]) {
      const out = await getForecast(c.args[0], c.args[1], c.args[2]);
      expect(out).toEqual(c.out);
      expect(isBadWeather(out)).toBe(c.bad);
    }
  });

  it("build_itinerary / render_cards", () => {
    for (const c of P.itinerary) {
      const it = buildItinerary(c.requirements, c.flights_result, c.places_result);
      expect(withoutMealPlacement(it)).toEqual(withoutMealPlacement(c.itinerary));
      // renderCards' own formatting (independent of which meal was picked) is covered directly in
      // tests/estimates.test.ts; the exact text here would otherwise drift with the meal tie-break above.
      expect(renderCards(it, c.budget)).toContain(`  ${it.route}`);
    }
  });
});
