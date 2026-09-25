import { describe, expect, it, vi } from "vitest";

const tracker = vi.hoisted(() => ({ inFlight: 0, peak: 0, delayMs: 0, calls: [] as { url: string; engine?: string }[] }));

vi.mock("../travel_agent/config.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../travel_agent/config.ts")>();
  return {
    ...mod,
    settings: {
      ...mod.settings,
      serpapiApiKey: "test-key",
      mapsProviders: ["serpapi"],
      usdToInr: 82.5,
      searchConcurrency: 4,
      searchCacheTtlMs: 0,
      searchFallbackCacheTtlMs: 0,
    },
  };
});
vi.mock("../travel_agent/tools/http.ts", async () => {
  const { fakeRequestJson, fakeRequestJsonDetailed } = await import("./fixtures/fakeHttp.ts");
  return {
    requestJson: fakeRequestJson,
    requestJsonDetailed: async (method: string, url: string, opts: { params?: Record<string, any> } = {}) => {
      tracker.calls.push({ url, engine: opts.params?.engine });
      if (opts.params?.engine !== "google_maps") return fakeRequestJsonDetailed(method, url, opts);
      tracker.inFlight++;
      tracker.peak = Math.max(tracker.peak, tracker.inFlight);
      await new Promise((resolve) => setTimeout(resolve, tracker.delayMs));
      tracker.inFlight--;
      return fakeRequestJsonDetailed(method, url, opts);
    },
  };
});

const maps = await import("../travel_agent/tools/search/maps.ts");
const { searchTransport } = await import("../travel_agent/tools/search/transportation.ts");
const { TOOLS } = await import("../travel_agent/mcp_server/handlers.ts");

describe("concurrent SerpAPI calls inside a tool", () => {
  it("searchPlaces sends its queries together, capped by SEARCH_CONCURRENCY", async () => {
    tracker.delayMs = 100;
    tracker.peak = 0;
    const started = performance.now();
    const places = await maps.searchPlaces("Munnar", ["tea", "waterfalls"], false);
    const elapsed = performance.now() - started;

    expect(places.length).toBeGreaterThan(0);
    expect(tracker.peak).toBe(4);
    // 7 queries at 100 ms each: about 700 ms one after another, about 200 ms four at a time.
    expect(elapsed).toBeLessThan(600);
    tracker.delayMs = 0;
  });
});

describe("budget limit inputs", () => {
  it("accommodation_search keeps stays at or under max_price_per_night, cheapest first", async () => {
    const all = await maps.searchAccommodation("Munnar", 2, null, null);
    const capped = await maps.searchAccommodation("Munnar", 2, null, null, 3000);
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.length).toBeLessThan(all.length);
    expect(capped.every((s) => s.price_per_night <= 3000)).toBe(true);
  });

  it("accommodation_search falls back to the cheapest stays when none fit", async () => {
    const cheapest = Math.min(...(await maps.searchAccommodation("Munnar", 2, null, null)).map((s) => s.price_per_night));
    const capped = await maps.searchAccommodation("Munnar", 2, null, null, 10);
    expect(capped.length).toBeLessThanOrEqual(3);
    expect(capped[0].price_per_night).toBe(cheapest);
  });

  it("restaurants_search drops venues above max_cost_per_person", async () => {
    const capped = await maps.searchRestaurants("Munnar", [], 500);
    expect(capped.Dinner.map((r: any) => r.name)).toEqual(["Taste of Munnar"]);
  });

  it("places_search keeps only attractions within max_cost_per_person", async () => {
    const capped = await maps.searchPlaces("Munnar", ["tea"], false, 50);
    expect(capped.length).toBeGreaterThan(0);
    expect(capped.every((p) => p.est_cost <= 50)).toBe(true);
  });
});

describe("exclude", () => {
  it("places_search drops attractions matching an excluded kind, plural or singular", async () => {
    const names = async (exclude: string[]) => (await maps.searchPlaces("Munnar", ["tea"], false, null, exclude)).map((p) => p.name);
    expect((await names([])).some((n) => n.includes("Museum"))).toBe(true);

    const without = await names(["museums"]);
    expect(without.length).toBeGreaterThan(0);
    expect(without.some((n) => n.includes("Museum"))).toBe(false);
    expect(await names(["museum"])).toEqual(without);
  });

  it("places_search matches on category as well as name", async () => {
    const names = async (exclude: string[]) =>
      (await maps.searchPlaces("Munnar", ["tea"], false, null, exclude)).map((p) => p.name.toLowerCase());
    expect((await names([])).some((n) => n.includes("dam"))).toBe(true);
    expect((await names(["dam"])).some((n) => n.includes("dam"))).toBe(false);
  });

  it("restaurants_search drops venues whose category matches", async () => {
    const lunch = async (exclude: string[]) => (await maps.searchRestaurants("Munnar", [], null, exclude)).Lunch.map((r: any) => r.name);
    expect(await lunch([])).toContain("Hotel Sree Krishna");
    expect(await lunch(["vegetarian"])).not.toContain("Hotel Sree Krishna");
  });
});

describe("transport_search with a trip length", () => {
  const run = (args: Record<string, unknown>) =>
    TOOLS.transport_search.run({ source: "Bangalore", destination: "Munnar", start_date: "2026-10-02", travellers: 2, ...args }, async () => {}) as Promise<any>;

  it("also returns the options for the way back, dated on the last day of the trip", async () => {
    const result = await run({ num_days: 3 });
    expect(result.route).toBe("Bangalore → Munnar");
    expect(result.return_route).toBe("Munnar → Bangalore");
    expect(result.return_date).toBe("2026-10-04");
    expect(result.return_options.length).toBe(result.options.length);
    expect(result.return_options.map((o: any) => o.mode)).toEqual(result.options.map((o: any) => o.mode));
  });

  it("dates the return links with the return date", async () => {
    const result = await run({ num_days: 3 });
    const back = result.return_options.find((o: any) => o.mode === "flight");
    const out = result.options.find((o: any) => o.mode === "flight");
    expect(back && out).toBeTruthy();
    expect(JSON.stringify(back.links)).toContain("2026-10-04");
    expect(JSON.stringify(out.links)).toContain("2026-10-02");
  });

  it("returns only the outbound options when no trip length is given", async () => {
    const result = await run({});
    expect(result).not.toHaveProperty("return_options");
    expect(result).not.toHaveProperty("return_date");
  });

  it("a one-day trip returns on the start date", async () => {
    expect((await run({ num_days: 1 })).return_date).toBe("2026-10-02");
  });
});

describe("transport_search", () => {
  it("makes no search call for links, only geocoding", async () => {
    tracker.calls.length = 0;
    const result = await searchTransport("Bangalore", "Munnar", "2026-10-02", 2);
    expect(result.options).toHaveLength(4); // Munnar has no railhead, so no train
    expect(tracker.calls.every((c) => c.url.includes("geocoding-api") && c.engine === undefined)).toBe(true);
  });
});
