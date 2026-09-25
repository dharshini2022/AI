import { randomUUID } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  settings: {} as Record<string, any>,
  real: {} as Record<string, any>,
  handler: (_url: string, _opts: any): { body: any; failure: string | null } => ({ body: null, failure: "network" }),
}));

vi.mock("../travel_agent/config.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../travel_agent/config.ts")>();
  h.real = { ...mod.settings };
  Object.assign(h.settings, mod.settings);
  return { ...mod, settings: h.settings };
});

// Munnar unless the city is listed here.
const CITIES: Record<string, [number, number]> = {
  chennai: [13.0827, 80.2707],
  coimbatore: [11.0168, 76.9558],
  pondicherry: [11.9416, 79.8083],
  bangalore: [12.9716, 77.5946],
  bengaluru: [12.9716, 77.5946],
};
vi.mock("../travel_agent/tools/http.ts", () => ({
  requestJson: async (_method: string, url: string, opts: any) => {
    if (!url.includes("geocoding-api")) return null;
    const [latitude, longitude] = CITIES[String(opts.params.name).toLowerCase()] ?? [10.0889, 77.0595];
    return { results: [{ latitude, longitude }] };
  },
  requestJsonDetailed: async (_method: string, url: string, opts: any) => h.handler(url, opts),
}));

const ok = (body: unknown) => ({ body, failure: null });

// Real files in the project's own (git-ignored) test folder.
const dir = join(import.meta.dirname, ".tmp-data");
mkdirSync(dir, { recursive: true });
afterAll(() => rmSync(dir, { recursive: true, force: true }));
function dataFile(contents: unknown): string {
  const file = join(dir, `${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

// Fresh modules (the data files are read once per process), then the settings for the test.
async function setup(overrides: Record<string, any> = {}, handler?: typeof h.handler) {
  vi.resetModules();
  h.handler = handler ?? (() => ok({}));
  const modules = {
    transport: await import("../travel_agent/tools/search/transportation.ts"),
    maps: await import("../travel_agent/tools/search/maps.ts"),
    hotelRates: await import("../travel_agent/tools/pricing/hotelRates.ts"),
    itinerary: await import("../travel_agent/tools/itinerary.ts"),
    budget: await import("../travel_agent/tools/pricing/budget.ts"),
    handlers: await import("../travel_agent/mcp_server/handlers.ts"),
  };
  Object.assign(h.settings, h.real, { searchCacheTtlMs: 0, searchFallbackCacheTtlMs: 0 }, overrides);
  return modules;
}

const modes = (options: any[]) => options.map((o) => o.mode);
const byOption = (options: any[], name: string) => options.find((o) => o.option === name);

describe("transport feasibility (Change 8a)", () => {
  it("offers all five options on a long route, every fare an estimate (the shipped fare table is empty)", async () => {
    const { transport } = await setup();
    const { options } = await transport.searchTransport("Chennai", "Coimbatore", "2026-10-02", 1);
    expect(options).toHaveLength(5);
    expect(modes(options).sort()).toEqual(["bus", "bus", "bus", "flight", "train"]);
    expect(options.every((o: any) => o.estimated === true && o.fare_source === "estimate")).toBe(true);
  });

  it("skips the flight when the straight-line distance is under 200 km", async () => {
    const { transport } = await setup();
    const { options } = await transport.searchTransport("Chennai", "Pondicherry", "2026-10-02", 1);
    expect(modes(options)).not.toContain("flight");
    expect(modes(options)).toContain("train");
  });

  it("skips the train to a place with no railhead, and from one", async () => {
    const { transport } = await setup();
    expect(modes((await transport.searchTransport("Bangalore", "Munnar", "2026-10-02", 1)).options)).not.toContain("train");
    expect(modes((await transport.searchTransport("Munnar", "Chennai", "2026-10-02", 1)).options)).not.toContain("train");
  });

  it("still lists the buses when both rules apply", async () => {
    const { transport } = await setup();
    const { options } = await transport.searchTransport("Munnar", "Kodaikanal", "2026-10-02", 1);
    expect(modes(options)).toEqual(["bus", "bus", "bus"]);
  });

  it("lists the flight when the cities cannot be located (350 km is assumed)", async () => {
    const { transport } = await setup();
    vi.spyOn(await import("../travel_agent/tools/search/geo.ts"), "geocode").mockResolvedValue([null, null]);
    expect(modes((await transport.searchTransport("Atlantis", "El Dorado", "2026-10-02", 1)).options)).toContain("flight");
  });

  it("reads the no-railhead list from the data file", async () => {
    const file = dataFile({ no_railhead: ["coimbatore"] });
    const { transport } = await setup({ routeFaresFile: file });
    const { options } = await transport.searchTransport("Chennai", "Coimbatore", "2026-10-02", 1);
    expect(modes(options)).not.toContain("train");
  });
});

describe("route fare table (Change 8b)", () => {
  const table = {
    aliases: { bangalore: "bengaluru" },
    routes: [
      {
        from: "Bengaluru",
        to: "Coimbatore",
        train: { price: 450, hours: 8 },
        flight: { price: 3900, estimated: true },
      },
    ],
  };

  it("uses the table's fare and hours for a mode it lists, per traveller, and marks it not estimated", async () => {
    const { transport } = await setup({ routeFaresFile: dataFile(table) });
    const { options } = await transport.searchTransport("Bengaluru", "Coimbatore", "2026-10-02", 2);
    const train = byOption(options, "Express / Superfast Train");
    expect(train).toMatchObject({
      approx_fare: "₹450",
      travel_time: "~8h",
      duration_hours: 8,
      price: 900,
      estimated: false,
      fare_source: "fare_table",
    });
    // The option keeps its provider and its booking links.
    expect(train.provider).toBe("Indian Railways (Express / Vande Bharat)");
    expect(train.links).toHaveLength(2);
  });

  it("respects a fare the table itself marks as an estimate", async () => {
    const { transport } = await setup({ routeFaresFile: dataFile(table) });
    const { options } = await transport.searchTransport("Bengaluru", "Coimbatore", "2026-10-02", 2);
    const flight = byOption(options, "Direct / Connecting Flight");
    expect(flight).toMatchObject({ price: 7800, approx_fare: "₹3900", estimated: true, fare_source: "fare_table" });
  });

  it("shows one fare per option, and it is the fare the budget adds up", async () => {
    const { transport } = await setup({ routeFaresFile: dataFile(table) });
    for (const route of [["Chennai", "Coimbatore"], ["Bengaluru", "Coimbatore"]]) {
      const { options } = await transport.searchTransport(route[0], route[1], "2026-10-02", 3);
      for (const o of options) {
        expect(o.approx_fare, o.option).toMatch(/^₹\d+$/);
        expect(o.price).toBe(Number(o.approx_fare.slice(1)) * 3);
        expect(o).not.toHaveProperty("fare");
      }
    }
  });

  it("falls back to the formula, as an estimate, for each mode the table lacks", async () => {
    const { transport } = await setup({ routeFaresFile: dataFile(table) });
    const { options } = await transport.searchTransport("Bengaluru", "Coimbatore", "2026-10-02", 1);
    const buses = options.filter((o: any) => o.mode === "bus");
    expect(buses).toHaveLength(3);
    expect(buses.every((o: any) => o.estimated === true && o.fare_source === "estimate")).toBe(true);
  });

  it("matches in either direction, whatever the case, and through an alias", async () => {
    const { transport } = await setup({ routeFaresFile: dataFile(table) });
    for (const [from, to] of [["Coimbatore", "Bangalore"], ["  BENGALURU ", "coimbatore"], ["Bangalore", "Coimbatore"]]) {
      const { options } = await transport.searchTransport(from, to, "2026-10-02", 1);
      expect(byOption(options, "Express / Superfast Train").fare_source, `${from} → ${to}`).toBe("fare_table");
    }
  });

  it("does not use a route for a different pair of cities", async () => {
    const { transport } = await setup({ routeFaresFile: dataFile(table) });
    const { options } = await transport.searchTransport("Chennai", "Coimbatore", "2026-10-02", 1);
    expect(options.every((o: any) => o.fare_source === "estimate")).toBe(true);
  });

  it("keeps the options sorted cheapest first after a table fare is applied", async () => {
    const { transport } = await setup({ routeFaresFile: dataFile(table) });
    const { options } = await transport.searchTransport("Bengaluru", "Coimbatore", "2026-10-02", 1);
    const prices = options.map((o: any) => o.price);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it("fails with the file's path when the table is malformed", async () => {
    const file = dataFile({ routes: [{ from: "Chennai", train: { price: -5 } }] });
    const { transport } = await setup({ routeFaresFile: file });
    await expect(transport.searchTransport("Chennai", "Coimbatore", "2026-10-02", 1)).rejects.toThrow(file);
  });
});

describe("hotel rate estimates (Change 7)", () => {
  const rates = {
    default: { stars: { "1": 1000, "2": 2000, "3": 3000, "4": 5000, "5": 9000 }, unclassified: 3500 },
    kinds: { homestay: 1, lodge: 2 },
    cities: { munnar: { stars: { "1": 500, "2": 600, "3": 700, "4": 800, "5": 900 }, unclassified: 650 } },
  };

  it("reads a class the listing states, from the name before it is cleaned, the type or the description", async () => {
    const { hotelRates } = await setup({ hotelRatesFile: dataFile(rates) });
    expect(hotelRates.hotelStars({ title: "Blanket Hotel & Spa | Luxury 5 Star Resorts in Munnar", type: "Resort hotel" })).toBe(5);
    expect(hotelRates.hotelStars({ title: "Vibe Resort Munnar / Five Star Luxury Resorts in Munnar" })).toBe(5);
    expect(hotelRates.hotelStars({ name: "Hotel X", type: "3-star hotel" })).toBe(3);
    expect(hotelRates.hotelStars({ title: "Hotel X", description: "A four-star property near the lake" })).toBe(4);
    expect(hotelRates.hotelStars({ title: "Hotel X", type: "2 stars hotel" })).toBe(2);
  });

  it("does not mistake other words for a class", async () => {
    const { hotelRates } = await setup({ hotelRatesFile: dataFile(rates) });
    expect(hotelRates.hotelStars({ title: "Studio 5 Starting Point Hotel", type: "Hotel" })).toBeNull();
    expect(hotelRates.hotelStars({ title: "Hotel Star Palace", type: "Hotel" })).toBeNull();
    expect(hotelRates.hotelStars({ title: "Room 6 star", type: "Hotel" })).toBeNull();
  });

  it("maps the primary kind of stay to a class, and says nothing for a plain Hotel or Resort hotel", async () => {
    const { hotelRates } = await setup({ hotelRatesFile: dataFile(rates) });
    expect(hotelRates.hotelStars({ title: "Green Homestay", type: "Homestay" })).toBe(1);
    expect(hotelRates.hotelStars({ title: "Old Lodge", type: " LODGE " })).toBe(2);
    expect(hotelRates.hotelStars({ title: "Big Hotel", type: "Hotel" })).toBeNull();
    expect(hotelRates.hotelStars({ title: "Big Resort", type: "Resort hotel" })).toBeNull();
    expect(hotelRates.hotelStars({ title: "No type at all" })).toBeNull();
  });

  it("looks only at the primary kind, so an extra category cannot turn a resort into a lodge", async () => {
    const { hotelRates } = await setup({ hotelRatesFile: dataFile(rates) });
    expect(hotelRates.hotelStars({ title: "Hotel White House Munnar | Luxury Resort", type: "Resort hotel", types: ["Resort hotel", "Hotel", "Lodge"] })).toBeNull();
  });

  it("prefers a stated class over the kind of stay", async () => {
    const { hotelRates } = await setup({ hotelRatesFile: dataFile(rates) });
    expect(hotelRates.hotelStars({ title: "5 Star Homestay", type: "Homestay" })).toBe(5);
  });

  it("prices by class, and ignores the guest review score", async () => {
    const { hotelRates } = await setup({ hotelRatesFile: dataFile(rates) });
    const rate = (place: object) => hotelRates.estimateNightlyRate("Ooty", hotelRates.hotelStars(place));
    expect(rate({ title: "Grand | 5 Star", type: "Hotel", rating: 3.0 })).toBe(9000);
    expect(rate({ title: "Green Homestay", type: "Homestay", rating: 5 })).toBe(1000);
    expect(rate({ title: "Plain Hotel", type: "Hotel", rating: 4.9 })).toBe(3500);
    expect(rate({ title: "Plain Hotel", type: "Hotel", rating: 1.2 })).toBe(3500);
  });

  it("uses a city's own rates when it has them, whatever the case", async () => {
    const { hotelRates } = await setup({ hotelRatesFile: dataFile(rates) });
    expect(hotelRates.estimateNightlyRate(" MUNNAR ", 5)).toBe(900);
    expect(hotelRates.estimateNightlyRate("Munnar", null)).toBe(650);
    expect(hotelRates.estimateNightlyRate("Ooty", 5)).toBe(9000);
  });

  it("rises with the class in the shipped placeholder rates", async () => {
    const { hotelRates } = await setup();
    const rate = (title: string, type = "Hotel") => hotelRates.estimateNightlyRate("Munnar", hotelRates.hotelStars({ title, type }));
    expect(rate("A | 5 Star")).toBeGreaterThan(rate("A | 3 Star"));
    expect(rate("A | 3 Star")).toBeGreaterThan(rate("A homestay", "Homestay"));
    expect(rate("Plain hotel")).toBeGreaterThan(0);
  });

  it("fails with the file's path when the rates are malformed", async () => {
    const file = dataFile({ default: { stars: { "1": 1000 }, unclassified: 3500 } });
    const { hotelRates } = await setup({ hotelRatesFile: file });
    expect(() => hotelRates.estimateNightlyRate("Ooty", null)).toThrow(file);
  });

  it("prices a stay with no listed price by its class, not by its review score or list position, and flags it", async () => {
    const at = { latitude: 10.09, longitude: 77.06 };
    const places = [
      { title: "Grand Palace | Luxury 5 Star Resorts", type: "Resort hotel", rating: 3.0, cid: "1", ...at },
      { title: "Green Homestay", type: "Homestay", rating: 5, cid: "2", ...at },
      { title: "Plain Resort", type: "Resort hotel", rating: 4.9, cid: "3", ...at },
    ];
    const { maps } = await setup(
      { hotelRatesFile: dataFile({ ...rates, cities: {} }), mapsProviders: ["serper"], serperApiKey: "k", serpapiApiKey: "" },
      () => ok({ places }),
    );
    const stays = await maps.searchAccommodation("Munnar", 2, null, null);
    expect(stays.map((s: any) => [s.name, s.price_per_night, s.estimated, s.rating])).toEqual([
      ["Grand Palace", 9000, true, 3.0],
      ["Green Homestay", 1000, true, 5],
      ["Plain Resort", 3500, true, 4.9],
    ]);
  });

  it("marks a real nightly rate as not estimated", async () => {
    const properties = [
      { name: "Real Hotel", rate_per_night: { extracted_lowest: 4200 }, overall_rating: 4.2, gps_coordinates: { latitude: 10.09, longitude: 77.06 }, link: "https://hotel.test" },
    ];
    const { maps } = await setup(
      { mapsProviders: ["serpapi"], serpapiApiKey: "k", serperApiKey: "" },
      (_url, opts) => ok(opts.params.engine === "google_hotels" ? { properties } : {}),
    );
    const stays = await maps.searchAccommodation("Munnar", 2, "2026-10-02", 2);
    expect(stays).toHaveLength(1);
    expect(stays[0]).toMatchObject({ name: "Real Hotel", price_per_night: 4200, estimated: false });
  });

  it("flags a place or restaurant as estimated only when it has no listed price", async () => {
    const local = [
      { title: "Fancy Museum", price: "$$", type: "Museum", rating: 4.5, reviews: 200, gps_coordinates: { latitude: 10.09, longitude: 77.06 } },
      { title: "Free View Point", type: "Tourist attraction", rating: 4.4, reviews: 100, gps_coordinates: { latitude: 10.09, longitude: 77.06 } },
    ];
    const { maps } = await setup(
      { mapsProviders: ["serpapi"], serpapiApiKey: "k", serperApiKey: "" },
      () => ok({ local_results: local }),
    );
    const places = await maps.searchPlaces("Munnar", [], false);
    expect(places.find((p: any) => p.name === "Fancy Museum")).toMatchObject({ price_level: "$$", est_cost: 450, estimated: false });
    expect(places.find((p: any) => p.name === "Free View Point")).toMatchObject({ price_level: null, estimated: true });
    const meals = await maps.searchRestaurants("Munnar", []);
    expect(meals.Lunch.find((r: any) => r.name === "Fancy Museum").estimated).toBe(false);
    expect(meals.Lunch.find((r: any) => r.name === "Free View Point")).toMatchObject({ est_cost: 350, estimated: true });
  });
});

describe("estimates in the budget and the plan (Change 7)", () => {
  it("checkBudget totals what is a guess, and reports 0 when nothing is", async () => {
    const { budget } = await setup();
    // transport 5000, lodging 3000 × 2 nights, food 900, activities 200 × 2 travellers
    const none = budget.checkBudget(5000, 3000, 3, 2, 200, null, 900);
    expect(none.total).toBe(12300);
    expect(none.estimated_total).toBe(0);
    const some = budget.checkBudget(5000, 3000, 3, 2, 200, null, 900, { transport: 5000, lodging: true, foodCost: 300, activityCost: 50 });
    expect(some.total).toBe(12300);
    expect(some.estimated_total).toBe(5000 + 6000 + 300 + 50 * 2);
  });

  it("budget_check works out the estimated part from the flags on the plan", async () => {
    const { handlers } = await setup();
    const itinerary = {
      transport: { price: 5000, estimated: true },
      accommodation: { price_per_night: 3000, estimated: false },
      cards: [
        {
          activities: [{ est_cost: 100, estimated: true }, { est_cost: 50, estimated: false }],
          meals: [{ est_cost: 200, estimated: true }, { est_cost: 100 }], // no flag: counted as real
        },
      ],
    };
    const { budget_status } = (await handlers.TOOLS.budget_check.run(
      { requirements: { num_days: 3, num_travellers: 2 }, places_result: {}, itinerary, budget_cap: null },
      async () => {},
    )) as any;
    // transport 5000 × 2 legs + lodging 6000 + food (200 + 100) × 2 + activities (100 + 50) × 2
    expect(budget_status.total).toBe(10000 + 6000 + 600 + 300);
    // transport 5000 × 2 legs + meal 200 × 2 + activity 100 × 2
    expect(budget_status.estimated_total).toBe(10000 + 400 + 200);
  });

  it("carries the flag onto scheduled activities and meals, and leaves it out when the source has none", async () => {
    const { itinerary } = await setup();
    const place = (name: string, extra: object) => ({ name, lat: 10.1, lon: 77.1, est_cost: 100, ...extra });
    const build = (places: object[], lunch: object[]) =>
      itinerary.buildItinerary({ num_days: 2 }, { selected: {} }, { places, restaurants: { Lunch: lunch }, accommodation: {}, weather: { days: [] } });
    const flagged = build([place("A", { estimated: true })], [place("R", { estimated: false })]);
    const activity = flagged.cards.flatMap((c: any) => c.activities)[0];
    const meal = flagged.cards.flatMap((c: any) => c.meals)[0];
    expect(activity.estimated).toBe(true);
    expect(meal.estimated).toBe(false);
    const plain = build([place("A", {})], [place("R", {})]);
    expect("estimated" in plain.cards.flatMap((c: any) => c.activities)[0]).toBe(false);
  });

  it("shows an estimated fare with a ~ and a real one without", async () => {
    const { itinerary } = await setup();
    expect(itinerary.fareText({ approx_fare: "₹5000", estimated: true })).toBe("~₹5000");
    expect(itinerary.fareText({ approx_fare: "₹5000", estimated: false })).toBe("₹5000");
    expect(itinerary.fareText({ approx_fare: "₹5000" })).toBe("₹5000");
    expect(itinerary.fareText({ price: 4200, estimated: true })).toBe("~₹4200");
  });

  it("prints the fare with its ~ and says how much of the budget is an estimate", async () => {
    const { itinerary, budget } = await setup();
    const status = budget.checkBudget(5000, 3000, 3, 2, 200, null, 900, { transport: 5000, lodging: false, foodCost: 0, activityCost: 0 });
    const plan = { route: "A → B", transport: { option: "Train", travel_time: "~8h", approx_fare: "₹450", estimated: true }, accommodation: {}, cards: [] };
    const text = itinerary.renderCards(plan, status);
    expect(text).toContain("Transport : Train — ~8h — ~₹450");
    expect(text).toContain("about ₹5000 of this is an estimate");
    expect(itinerary.renderCards(plan, budget.checkBudget(5000, 3000, 3, 2, 200, null, 900))).not.toContain("is an estimate");
  });
});

describe("stable re-layout after an edit, proximity-aware meals, far-from-stay note", () => {
  const place = (name: string, lat: number, lon: number, extra: object = {}) => ({ name, lat, lon, est_cost: 100, ...extra });
  const requirements = { num_days: 2 };
  const accommodation = { lat: 10.0, lon: 77.0 };

  it("with no previous itinerary, lays out exactly as before (regression guard)", async () => {
    const { itinerary } = await setup();
    const places = [place("A", 10.01, 77.0), place("B", 10.02, 77.0), place("C", 10.5, 77.5), place("D", 10.51, 77.5)];
    const withNone = itinerary.buildItinerary(requirements, { selected: {} }, { places, restaurants: {}, accommodation, weather: { days: [] } });
    const withNull = itinerary.buildItinerary(requirements, { selected: {} }, { places, restaurants: {}, accommodation, weather: { days: [] } }, null);
    expect(withNull).toEqual(withNone);
  });

  it("keeps a place on its previous day, and drops a removed one, when an edit re-runs the layout", async () => {
    const { itinerary } = await setup();
    const places = [place("A", 10.01, 77.0), place("B", 10.02, 77.0), place("C", 10.5, 77.5), place("D", 10.51, 77.5)];
    const first = itinerary.buildItinerary(requirements, { selected: {} }, { places, restaurants: {}, accommodation, weather: { days: [] } });
    const dayOf = (it: any, name: string) => it.cards.findIndex((c: any) => c.activities.some((a: any) => a.name === name));
    const [dayA, dayC] = [dayOf(first, "A"), dayOf(first, "C")];

    // "B" is removed (e.g. excluded by an edit); the rest are unchanged.
    const edited = [place("A", 10.01, 77.0), place("C", 10.5, 77.5), place("D", 10.51, 77.5)];
    const second = itinerary.buildItinerary(requirements, { selected: {} }, { places: edited, restaurants: {}, accommodation, weather: { days: [] } }, first);
    expect(dayOf(second, "A")).toBe(dayA);
    expect(dayOf(second, "C")).toBe(dayC);
    expect(second.cards.some((c: any) => c.activities.some((a: any) => a.name === "B"))).toBe(false);
  });

  it("places a genuinely new replacement nearest to its day's remaining places, or the stay for an emptied day", async () => {
    const { itinerary } = await setup();
    // Day 1 will end up as just "A"; day 2 loses its only place "C" entirely.
    const places = [place("A", 10.01, 77.0), place("C", 10.5, 77.5)];
    const first = itinerary.buildItinerary({ num_days: 2 }, { selected: {} }, { places, restaurants: {}, accommodation, weather: { days: [] } });
    const dayOf = (it: any, name: string) => it.cards.findIndex((c: any) => c.activities.some((a: any) => a.name === name));

    // "E" is close to "A"; "F" is close to the accommodation (near where day 2's now-empty slot anchors).
    const edited = [place("A", 10.01, 77.0), place("E", 10.011, 77.0), place("F", 10.001, 77.001)];
    const second = itinerary.buildItinerary({ num_days: 2 }, { selected: {} }, { places: edited, restaurants: {}, accommodation, weather: { days: [] } }, first);
    expect(dayOf(second, "E")).toBe(dayOf(first, "A")); // near its kept neighbour, same day as before
    expect(second.cards[dayOf(second, "F")].activities.length).toBeGreaterThan(0); // day 2 got a replacement
  });

  it("breaks a meal tie by distance to the day's places, not list order", async () => {
    const { itinerary } = await setup();
    const places = [place("A", 10.0, 77.0)];
    const far = { name: "Far Cafe", lat: 11.0, lon: 78.0, est_cost: 100 };
    const near = { name: "Near Cafe", lat: 10.001, lon: 77.001, est_cost: 100 };
    const result = itinerary.buildItinerary(
      { num_days: 1 },
      { selected: {} },
      { places, restaurants: { Breakfast: [far, near] }, accommodation, weather: { days: [] } },
    );
    expect(result.cards[0].meals[0].name).toBe("Near Cafe");
  });

  it("notes a day whose places are far from the stay, and changes nothing else about it", async () => {
    const { itinerary } = await setup({ farFromStayKm: 5 });
    const near = [place("A", 10.001, 77.001)];
    const far = [place("A", 12.0, 79.0)];
    const nearBuild = itinerary.buildItinerary({ num_days: 1 }, { selected: {} }, { places: near, restaurants: {}, accommodation, weather: { days: [] } });
    const farBuild = itinerary.buildItinerary({ num_days: 1 }, { selected: {} }, { places: far, restaurants: {}, accommodation, weather: { days: [] } });
    expect(nearBuild.cards[0].note).not.toContain("far from your stay");
    expect(farBuild.cards[0].note).toContain("far from your stay");
    // The note is the only thing this adds — the day's actual places are untouched.
    expect(farBuild.cards[0].activities).toHaveLength(1);
    expect(farBuild.cards[0].activities[0].name).toBe("A");
  });
});

describe("star class lookup", () => {
  const found = (name: string, city: string, ...results: [string, string][]) =>
    import("../travel_agent/tools/pricing/hotelClass.ts").then((m) => m.classFromResults(name, city, results.map(([title, snippet]) => ({ title, snippet }))));

  it("reads a class stated as a kind of hotel, in real snippets, from a result that names the hotel", async () => {
    await setup();
    expect(await found("The Grand Cliff Resort, Munnar", "Munnar", ["Grand Cliff Resort Munnar", "Grand Cliff Resort, Munnar is a Premium five star Luxury Resort in Munnar, Kerala."])).toBe(5);
    expect(await found("Grand Hyatt Kochi Bolgatty", "Kochi", ["Grand Hyatt Kochi Bolgatty", "Grand Hyatt Kochi Bolgatty is a luxurious 5-star resort located on Bolgatty Island."])).toBe(5);
    expect(await found("Grand Cliff Resort", "Munnar", ["Grand Cliff Resort | Munnar", "Classified 5 Star Resort approved by Govt. of India."])).toBe(5);
    expect(await found("Sunrise Palace", "Munnar", ["Sunrise Palace Munnar", "A three-star hotel with lake views."])).toBe(3);
  });

  it("does not read a guest score as a class", async () => {
    await setup();
    expect(await found("Carmel Homestay", "Munnar", ["Carmel Homestay Munnar", "Rated 4.5 out of 5 stars by 120 guests. 5 star reviews."])).toBeNull();
    expect(await found("Carmel Homestay", "Munnar", ["Carmel Homestay", "Guests give it 5 stars. A 4.5 star hotel experience."])).toBeNull();
  });

  it("ignores a result that does not name the hotel, such as a list of other hotels", async () => {
    await setup();
    expect(await found("Carmel Homestay", "Munnar", ["10 best 5 star hotels in Munnar", "Top 5 star hotels and resorts in Munnar."])).toBeNull();
    expect(await found("Carmel Homestay", "Munnar", ["Blanket Hotel", "Blanket Hotel is a 5 star hotel."])).toBeNull();
  });

  it("takes the first result that qualifies, and skips ones that do not", async () => {
    await setup();
    expect(
      await found("Quiet Resort", "Munnar", ["10 best 5 star hotels in Munnar", "Top 5 star hotels."], ["Quiet Resort Munnar", "Quiet Resort is a 4-star hotel."], ["Quiet Resort", "A 2 star hotel."]),
    ).toBe(4);
  });

  it("says nothing when the name has no distinctive word (only the city and words like Resort)", async () => {
    await setup();
    expect(await found("The Resort, Munnar", "Munnar", ["The Resort Munnar", "A 5 star resort."])).toBeNull();
  });

  describe("when pricing a stay", () => {
    const rates = { default: { stars: { "1": 1000, "2": 2000, "3": 3000, "4": 5000, "5": 9000 }, unclassified: 3500 }, kinds: { homestay: 1 }, cities: {} };
    const at = { latitude: 10.09, longitude: 77.06 };
    const hotels = [
      { title: "Quiet Resort", type: "Resort hotel", rating: 4.9, cid: "1", ...at },
      { title: "Grand Palace | Luxury 5 Star Resorts", type: "Resort hotel", cid: "2", ...at },
      { title: "Green Homestay", type: "Homestay", cid: "3", ...at },
    ];
    const run = async (organic: object[], extra: Record<string, any> = {}, places: object[] = hotels) => {
      const searches: string[] = [];
      const { maps } = await setup(
        { hotelRatesFile: dataFile(rates), mapsProviders: ["serper"], serperApiKey: "k", serpapiApiKey: "", ...extra },
        (url, opts) => {
          if (url.includes("serper.dev/search")) {
            searches.push(opts.json.q);
            return ok({ organic });
          }
          return ok({ places });
        },
      );
      const stays = await maps.searchAccommodation("Munnar", 2, null, null);
      return { searches, prices: Object.fromEntries(stays.map((s: any) => [s.name, s.price_per_night])) };
    };
    const quietIs4Star = [{ title: "Quiet Resort Munnar", snippet: "Quiet Resort is a 4-star hotel in Munnar." }];

    it("searches only for a stay whose listing states no class and whose kind says none", async () => {
      const { searches, prices } = await run(quietIs4Star);
      expect(searches).toEqual(["Quiet Resort Munnar"]);
      expect(prices).toEqual({ "Quiet Resort": 5000, "Grand Palace": 9000, "Green Homestay": 1000 });
    });

    it("uses the unclassified rate when the search finds no class", async () => {
      const { searches, prices } = await run([{ title: "Quiet Resort Munnar", snippet: "Rated 4.9 out of 5 stars." }]);
      expect(searches).toHaveLength(1);
      expect(prices["Quiet Resort"]).toBe(3500);
    });

    it("makes no search when HOTEL_CLASS_LOOKUP is off", async () => {
      const { searches, prices } = await run(quietIs4Star, { hotelClassLookup: false });
      expect(searches).toEqual([]);
      expect(prices["Quiet Resort"]).toBe(3500);
    });

    it("uses the unclassified rate, and does not fail, when the search itself fails", async () => {
      const { maps } = await setup(
        { hotelRatesFile: dataFile(rates), mapsProviders: ["serper"], serperApiKey: "k", serpapiApiKey: "" },
        (url) => (url.includes("serper.dev/search") ? { body: null, failure: "network" } : ok({ places: hotels })),
      );
      const stays = await maps.searchAccommodation("Munnar", 2, null, null);
      expect(stays.find((s: any) => s.name === "Quiet Resort")?.price_per_night).toBe(3500);
    });

    it("makes no search for a stay that has a listed price", async () => {
      const priced = [{ title: "Priced Hotel", type: "Hotel", price: "₹2,500", cid: "9", gps_coordinates: at }];
      const searches: string[] = [];
      const { maps } = await setup(
        { hotelRatesFile: dataFile(rates), mapsProviders: ["serpapi", "serper"], serpapiApiKey: "k", serperApiKey: "k" },
        (url, opts) => {
          if (url.includes("serper.dev/search")) searches.push(opts.json.q);
          return ok(url.includes("serper.dev/search") ? { organic: [] } : { local_results: priced });
        },
      );
      const stays = await maps.searchAccommodation("Munnar", 2, null, null);
      expect(stays[0]).toMatchObject({ name: "Priced Hotel", price_per_night: 2500, estimated: false });
      expect(searches).toEqual([]);
    });

    it("remembers the answer, so a repeat run spends no search", async () => {
      const cache = { searchCacheTtlMs: 60_000, searchFallbackCacheTtlMs: 60_000, searchCacheFile: join(dir, `${randomUUID()}.json`) };
      const first = await run(quietIs4Star, cache);
      expect(first.searches).toHaveLength(1);
      const second = await run(quietIs4Star, cache); // a new process, same cache file
      expect(second.searches).toEqual([]);
      expect(second.prices["Quiet Resort"]).toBe(5000);
    });
  });
});

describe("the return journey (transport counted for both legs)", () => {
  it("budget_check counts the transport price twice and says so", async () => {
    const { handlers } = await setup();
    const { budget_status } = (await handlers.TOOLS.budget_check.run(
      { requirements: { num_days: 2, num_travellers: 2 }, places_result: {}, itinerary: { transport: { price: 3000 }, accommodation: { price_per_night: 0 }, cards: [] }, budget_cap: 5000 },
      async () => {},
    )) as any;
    expect(budget_status.breakdown.transport).toBe(6000);
    expect(budget_status.total).toBe(6000);
    expect(budget_status.transport_legs).toBe(2);
    // one way fits the 5000 cap, there and back does not
    expect(budget_status.ok).toBe(false);
    expect(budget_status.overage).toBe(1000);
  });

  it("budget_check pays both fares when a return leg was chosen, and counts only the guessed leg as an estimate", async () => {
    const { handlers } = await setup();
    const { budget_status } = (await handlers.TOOLS.budget_check.run(
      {
        requirements: { num_days: 2, num_travellers: 2 },
        places_result: {},
        itinerary: {
          transport: { price: 3000, estimated: false },
          return_transport: { price: 1200, estimated: true },
          accommodation: { price_per_night: 0 },
          cards: [],
        },
        budget_cap: null,
      },
      async () => {},
    )) as any;
    expect(budget_status.breakdown.transport).toBe(4200); // not 3000 × 2
    expect(budget_status.total).toBe(4200);
    expect(budget_status.estimated_total).toBe(1200);
  });

  it("shows Outbound and Return lines when a return leg was chosen, and one Transport line when not", async () => {
    const { itinerary } = await setup();
    const out = { option: "Flight", travel_time: "~1h", approx_fare: "₹4000", links: [{ title: "ixigo", url: "https://out" }] };
    const back = { option: "Train", travel_time: "~9h", approx_fare: "₹900", booking_url: "https://back" };
    const both = itinerary.renderCards({ route: "A → B", transport: out, return_transport: back, return_date: "2026-10-04", accommodation: {}, cards: [] });
    expect(both).toContain("Outbound  : Flight — ~1h — ₹4000");
    expect(both).toContain("Return    : Train — ~9h — ₹900  on 2026-10-04");
    expect(both).toContain("[ixigo](https://out)");
    expect(both).toContain("↳ Booking : https://back");
    expect(both).not.toContain("Transport :");

    const single = itinerary.renderCards({ route: "A → B", transport: out, accommodation: {}, cards: [] });
    expect(single).toContain("Transport : Flight — ~1h — ₹4000");
    expect(single).not.toContain("Return    :");
  });

  it("buildItinerary carries the return leg only when one was chosen", async () => {
    const { itinerary } = await setup();
    const places = { places: [], restaurants: {}, accommodation: {}, weather: { days: [] } };
    const withReturn = itinerary.buildItinerary({ num_days: 2 }, { selected: { option: "Bus" }, selected_return: { option: "Train" }, return_date: "2026-10-04" }, places);
    expect(withReturn).toMatchObject({ return_transport: { option: "Train" }, return_date: "2026-10-04" });
    expect(itinerary.buildItinerary({ num_days: 2 }, { selected: { option: "Bus" } }, places)).not.toHaveProperty("return_transport");
  });

  it("the plan says the return is included in the transport figure", async () => {
    const { itinerary, budget } = await setup();
    const plan = { route: "A → B", transport: { option: "Bus", travel_time: "~7h", approx_fare: "₹600" }, accommodation: {}, cards: [] };
    const withLegs = { ...budget.checkBudget(1200, 0, 2, 1, 0, null), transport_legs: 2 };
    expect(itinerary.renderCards(plan, withLegs)).toContain("transport ₹1200 (return included)");
    expect(itinerary.renderCards(plan, budget.checkBudget(1200, 0, 2, 1, 0, null))).not.toContain("return included");
  });
});
