import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";

type Reply = { body: any; failure: string | null };

const h = vi.hoisted(() => ({
  settings: {} as Record<string, any>,
  calls: [] as { method: string; url: string; opts: any }[],
  handler: (_url: string, _opts: any): { body: any; failure: string | null } => ({ body: null, failure: "network" }),
}));

vi.mock("../travel_agent/config.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../travel_agent/config.ts")>();
  Object.assign(h.settings, mod.settings);
  return { ...mod, settings: h.settings };
});
// Munnar unless the city is one of these, so most tests need no coordinates of their own.
const CITIES: Record<string, [number, number]> = { chennai: [13.0827, 80.2707], coimbatore: [11.0168, 76.9558] };

vi.mock("../travel_agent/tools/http.ts", () => ({
  requestJson: async (_method: string, url: string, opts: any) => {
    if (!url.includes("geocoding-api")) return null;
    const [latitude, longitude] = CITIES[String(opts.params.name).toLowerCase()] ?? [10.0889, 77.0595];
    return { results: [{ latitude, longitude }] };
  },
  requestJsonDetailed: async (method: string, url: string, opts: any) => {
    h.calls.push({ method, url, opts });
    return h.handler(url, opts);
  },
}));

// A real Serper /maps response for "top tourist attractions in Munnar" (first six places).
const SERPER = JSON.parse(readFileSync(new URL("./fixtures/serper_maps.json", import.meta.url), "utf8"));
const SERPAPI = { local_results: [{ title: "SerpAPI Falls", gps_coordinates: { latitude: 10.09, longitude: 77.06 }, rating: 4.4 }] };

const ok = (body: unknown): Reply => ({ body, failure: null });
const fail = (failure: string): Reply => ({ body: null, failure });
const host = (url: string) => new URL(url).host;
const hostsCalled = () => h.calls.map((c) => host(c.url));
const titles = (places: any[]) => places.map((p) => p.title ?? p.name);

// A new process: fresh modules (so the breaker and the cache start empty), then the settings for the test.
async function setup(overrides: Record<string, any> = {}, handler?: typeof h.handler) {
  vi.resetModules();
  h.calls.length = 0;
  h.handler = handler ?? ((url) => (url.includes("serpapi.com") ? ok(SERPAPI) : ok(SERPER)));
  const providers = await import("../travel_agent/tools/providers/index.ts");
  const cache = await import("../travel_agent/tools/cache.ts");
  Object.assign(h.settings, {
    serpapiApiKey: "serpapi-key",
    serperApiKey: "serper-key",
    mapsProviders: ["serpapi", "serper"],
    searchCacheTtlMs: 0,
    searchFallbackCacheTtlMs: 0,
    ...overrides,
  });
  return { ...providers, ...cache };
}

describe("provider chain", () => {
  it("falls through to Serper when SerpAPI fails", async () => {
    const { mapsSearch } = await setup({}, (url) => (url.includes("serpapi.com") ? fail("server") : ok(SERPER)));
    const places = await mapsSearch("tea in Munnar", "Munnar", 3);
    expect(titles(places)).toEqual(["The Blossom Hydel Park", "Tea Museum", "Munnar views"]);
    expect(hostsCalled()).toEqual(["serpapi.com", "google.serper.dev"]);
  });

  it("does not try Serper when SerpAPI answers with an empty list", async () => {
    const { mapsSearch } = await setup({}, (url) => (url.includes("serpapi.com") ? ok({ local_results: [] }) : ok(SERPER)));
    expect(await mapsSearch("nothing in Munnar", "Munnar", 5)).toEqual([]);
    expect(hostsCalled()).toEqual(["serpapi.com"]);
  });

  it("skips SerpAPI for later calls once it reports no quota", async () => {
    const { mapsSearch } = await setup({}, (url) => (url.includes("serpapi.com") ? fail("quota") : ok(SERPER)));
    await mapsSearch("first", "Munnar", 2);
    await mapsSearch("second", "Munnar", 2);
    expect(hostsCalled()).toEqual(["serpapi.com", "google.serper.dev", "google.serper.dev"]);
  });

  it("does the same when the key is refused", async () => {
    const { mapsSearch } = await setup({}, (url) => (url.includes("serpapi.com") ? fail("unauthorized") : ok(SERPER)));
    await mapsSearch("first", "Munnar", 2);
    await mapsSearch("second", "Munnar", 2);
    expect(hostsCalled().filter((x) => x === "serpapi.com")).toHaveLength(1);
  });

  it("falls through on a rate limit but does not switch SerpAPI off", async () => {
    const { mapsSearch } = await setup({}, (url) => (url.includes("serpapi.com") ? fail("rate_limited") : ok(SERPER)));
    await mapsSearch("first", "Munnar", 2);
    await mapsSearch("second", "Munnar", 2);
    expect(hostsCalled()).toEqual(["serpapi.com", "google.serper.dev", "serpapi.com", "google.serper.dev"]);
  });

  it("does not try the next provider for a rejected request", async () => {
    const { mapsSearch } = await setup({}, (url) => (url.includes("serpapi.com") ? fail("rejected") : ok(SERPER)));
    expect(await mapsSearch("bad", "Munnar", 2)).toEqual([]);
    expect(hostsCalled()).toEqual(["serpapi.com"]);
  });

  it("skips a provider that has no key", async () => {
    const { mapsSearch } = await setup({ serpapiApiKey: "" });
    expect(titles(await mapsSearch("tea", "Munnar", 2))).toHaveLength(2);
    expect(hostsCalled()).toEqual(["google.serper.dev"]);
  });

  it("makes no request at all when no provider is configured", async () => {
    const { mapsSearch } = await setup({ serpapiApiKey: "", serperApiKey: "" });
    expect(await mapsSearch("tea", "Munnar", 2)).toEqual([]);
    expect(h.calls).toHaveLength(0);
  });

  it("uses providers in the order MAPS_PROVIDER lists them", async () => {
    const { mapsSearch } = await setup({ mapsProviders: ["serper", "serpapi"] });
    await mapsSearch("tea", "Munnar", 2);
    expect(hostsCalled()).toEqual(["google.serper.dev"]);
  });

  it("limits `only` to the named provider and returns nothing if it is off", async () => {
    const { mapsSearch } = await setup({}, (url) => (url.includes("serpapi.com") ? fail("quota") : ok(SERPER)));
    expect(await mapsSearch("detail", "Munnar", 1, undefined, ["serpapi"])).toEqual([]);
    expect(await mapsSearch("detail two", "Munnar", 1, undefined, ["serpapi"])).toEqual([]);
    expect(hostsCalled()).toEqual(["serpapi.com"]);
  });
});

describe("Serper request", () => {
  it("posts the query with the key in a header and the city's coordinates", async () => {
    const { mapsSearch } = await setup({ serpapiApiKey: "" });
    await mapsSearch("tea in Munnar", "Munnar", 5);
    const [call] = h.calls;
    expect(call.method).toBe("POST");
    expect(call.url).toBe("https://google.serper.dev/maps");
    expect(call.opts.headers).toEqual({ "X-API-KEY": "serper-key" });
    expect(call.opts.json).toEqual({ q: "tea in Munnar", gl: "in", hl: "en", ll: "@10.0889,77.0595,12z" });
  });

  it("trims Serper's list to the number asked for, since Serper ignores `num`", async () => {
    const { mapsSearch } = await setup({ serpapiApiKey: "" });
    expect(SERPER.places.length).toBe(6);
    expect(await mapsSearch("tea in Munnar", "Munnar", 4)).toHaveLength(4);
  });
});

// The tools' output must not change whichever provider answered.
describe("tool output schemas", () => {
  const PLACE = ["name", "category", "types", "address", "rating", "rating_count", "hours", "phone", "website", "lat", "lon", "maps_url", "indoor", "price_level", "est_cost", "estimated"];
  const STAY = ["name", "price_per_night", "rating", "address", "lat", "lon", "maps_url", "booking_url", "url", "estimated"];
  const OPTION = ["mode", "option", "provider", "travel_time", "duration_hours", "notes", "booking_url", "links", "approx_fare", "price", "estimated", "fare_source"];

  it("places_search returns Place objects built from Serper's real fields", async () => {
    await setup({ serpapiApiKey: "" });
    const { searchPlaces } = await import("../travel_agent/tools/search/maps.ts");
    const places = await searchPlaces("Munnar", [], false);
    expect(places.length).toBeGreaterThan(0);
    for (const p of places) expect(Object.keys(p)).toEqual(PLACE);
    expect(places.find((p) => p.name === "Tea Museum")).toEqual({
      name: "Tea Museum",
      category: "Tourist attraction",
      types: ["Tourist attraction", "Museum"],
      address: "KDHP House, NH 49, Nullatanni, Munnar, Kannan Devan Hills, Keralam 685612, India",
      rating: 3.8,
      rating_count: 16698,
      hours: "9 AM–5 PM",
      phone: "+91 4868 255 000",
      website: "http://kdhptea.com/",
      lat: 10.0941757,
      lon: 77.05072,
      maps_url: "https://www.google.com/maps?cid=15303620340445659665",
      indoor: false,
      price_level: null,
      est_cost: 200,
      estimated: true, // Serper has no price, so the cost is a keyword guess
    });
  });

  it("restaurants_search returns Breakfast, Lunch and Dinner lists of Place objects", async () => {
    await setup({ serpapiApiKey: "" });
    const { searchRestaurants } = await import("../travel_agent/tools/search/maps.ts");
    const result = await searchRestaurants("Munnar", []);
    expect(Object.keys(result)).toEqual(["Breakfast", "Lunch", "Dinner"]);
    for (const meal of Object.values(result) as any[][]) {
      expect(meal.length).toBeGreaterThan(0);
      for (const r of meal) expect(Object.keys(r)).toEqual(PLACE);
    }
  });

  it("accommodation_search returns Stay objects from the maps listing", async () => {
    await setup({ serpapiApiKey: "" });
    const { searchAccommodation } = await import("../travel_agent/tools/search/maps.ts");
    const stays = await searchAccommodation("Munnar", 2, null, null);
    expect(stays.length).toBeGreaterThan(0);
    for (const s of stays) expect(Object.keys(s)).toEqual(STAY);
  });

  it("transport_search returns source, route, options and organic_search_results", async () => {
    await setup();
    const { searchTransport } = await import("../travel_agent/tools/search/transportation.ts");
    const result = await searchTransport("Chennai", "Coimbatore", "2026-10-02", 2);
    expect(Object.keys(result)).toEqual(["source", "route", "options", "organic_search_results"]);
    expect(result.route).toBe("Chennai → Coimbatore");
    expect(result.options).toHaveLength(5);
    for (const o of result.options) expect(Object.keys(o)).toEqual(OPTION);
    expect(h.calls).toHaveLength(0); // no search call for links
  });
});

// Real files in the project's own (git-ignored) test folder.
const dir = join(import.meta.dirname, ".tmp-cache");
mkdirSync(dir, { recursive: true });
const tempFile = () => join(dir, `${randomUUID()}.json`);
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("disk cache", () => {
  const NOW = new Date("2026-09-21T10:00:00Z");
  afterEach(() => vi.useRealTimers());

  it("lets a later run read the file instead of making the request", async () => {
    const file = tempFile();
    const settings = { searchCacheFile: file, searchCacheTtlMs: 60_000 };
    const fetchMock = vi.fn(async () => ({ value: ["a"], fallback: false }));
    let { cached } = await setup(settings);
    expect(await cached("k", fetchMock)).toEqual(["a"]);
    expect(existsSync(file)).toBe(true);

    ({ cached } = await setup(settings)); // a new process
    expect(await cached("k", fetchMock)).toEqual(["a"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("drops an expired entry, and leaves it out of the file on the next write", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const file = tempFile();
    const { cached } = await setup({ searchCacheFile: file, searchCacheTtlMs: 1_000 });
    const fetchMock = vi.fn(async () => ({ value: ["a"], fallback: false }));
    await cached("old", fetchMock);
    vi.setSystemTime(new Date(NOW.getTime() + 2_000));
    await cached("old", fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    vi.setSystemTime(new Date(NOW.getTime() + 10_000));
    await cached("new", fetchMock);
    expect(Object.keys(JSON.parse(readFileSync(file, "utf8")))).toEqual(["new"]);
  });

  it("does not save a failure", async () => {
    const file = tempFile();
    const { cached } = await setup({ searchCacheFile: file, searchCacheTtlMs: 60_000 });
    const failing = vi.fn(async () => null);
    expect(await cached("k", failing)).toBeNull();
    expect(await cached("k", failing)).toBeNull();
    expect(failing).toHaveBeenCalledTimes(2);
    expect(existsSync(file)).toBe(false);
  });

  it("keeps a fallback provider's answer for less time than the first provider's", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { cached } = await setup({ searchCacheFile: tempFile(), searchCacheTtlMs: 100_000, searchFallbackCacheTtlMs: 1_000 });
    const first = vi.fn(async () => ({ value: 1, fallback: false }));
    const backup = vi.fn(async () => ({ value: 2, fallback: true }));
    await cached("first", first);
    await cached("backup", backup);
    vi.setSystemTime(new Date(NOW.getTime() + 5_000));
    await cached("first", first);
    await cached("backup", backup);
    expect(first).toHaveBeenCalledTimes(1);
    expect(backup).toHaveBeenCalledTimes(2);
  });

  it("is off when both TTLs are 0", async () => {
    const file = tempFile();
    const { cached } = await setup({ searchCacheFile: file, searchCacheTtlMs: 0, searchFallbackCacheTtlMs: 0 });
    const fetchMock = vi.fn(async () => ({ value: 1, fallback: false }));
    await cached("k", fetchMock);
    await cached("k", fetchMock);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(existsSync(file)).toBe(false);
  });

  it("shares one request between identical calls made at the same time", async () => {
    const { cached } = await setup({ searchCacheFile: tempFile(), searchCacheTtlMs: 60_000 });
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { value: { n: 1 }, fallback: false };
    });
    const [a, b] = await Promise.all([cached("k", fetchMock), cached("k", fetchMock)]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
  });

  it("gives every caller its own copy", async () => {
    const { cached } = await setup({ searchCacheFile: tempFile(), searchCacheTtlMs: 60_000 });
    const fetchMock = async () => ({ value: [{ n: 1 }], fallback: false });
    const first: any = await cached("k", fetchMock);
    first[0].n = 99;
    expect(await cached("k", fetchMock)).toEqual([{ n: 1 }]);
  });

  it("starts empty when the file is unreadable, and still works when it cannot be written", async () => {
    const corrupt = tempFile();
    writeFileSync(corrupt, "{not json");
    let { cached } = await setup({ searchCacheFile: corrupt, searchCacheTtlMs: 60_000 });
    expect(await cached("k", async () => ({ value: 1, fallback: false }))).toBe(1);

    const blocker = tempFile();
    writeFileSync(blocker, "a file, not a folder");
    ({ cached } = await setup({ searchCacheFile: join(blocker, "search.json"), searchCacheTtlMs: 60_000 }));
    expect(await cached("k", async () => ({ value: 2, fallback: false }))).toBe(2);
  });

  it("mapsSearch: a repeat run makes no request", async () => {
    const settings = { searchCacheFile: tempFile(), searchCacheTtlMs: 60_000, searchFallbackCacheTtlMs: 60_000 };
    let { mapsSearch } = await setup(settings);
    const first = await mapsSearch("tea in Munnar", "Munnar", 3);
    expect(h.calls).toHaveLength(1);

    ({ mapsSearch } = await setup(settings)); // a new process
    expect(await mapsSearch("Tea in Munnar", "munnar", 3)).toEqual(first);
    expect(h.calls).toHaveLength(0);
  });

  it("mapsSearch: keeps Serper's answer for the short time when SerpAPI is the first provider", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const handler = (url: string) => (url.includes("serpapi.com") ? fail("server") : ok(SERPER));
    const { mapsSearch } = await setup({ searchCacheFile: tempFile(), searchCacheTtlMs: 100_000, searchFallbackCacheTtlMs: 1_000 }, handler);
    await mapsSearch("tea", "Munnar", 2);
    const made = h.calls.length;
    vi.setSystemTime(new Date(NOW.getTime() + 5_000));
    await mapsSearch("tea", "Munnar", 2);
    expect(h.calls.length).toBeGreaterThan(made);
  });

  it("mapsSearch: treats Serper as the first provider when SerpAPI has no key", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
    const { mapsSearch } = await setup({ serpapiApiKey: "", searchCacheFile: tempFile(), searchCacheTtlMs: 100_000, searchFallbackCacheTtlMs: 1_000 });
    await mapsSearch("tea", "Munnar", 2);
    vi.setSystemTime(new Date(NOW.getTime() + 5_000));
    await mapsSearch("tea", "Munnar", 2);
    expect(h.calls).toHaveLength(1);
  });
});

describe("search outages", () => {
  const allFail = (failure: string) => () => fail(failure);
  const problem = async () => (await import("../travel_agent/tools/providers/shared.ts")).searchProblem();

  it("names each provider that failed when none can answer", async () => {
    const { mapsSearch } = await setup({}, (url) => (url.includes("serpapi.com") ? fail("quota") : fail("timeout")));
    await mapsSearch("tea", "Munnar", 2);
    expect(await problem()).toBe("serpapi: quota; serper: timeout");
  });

  it("reports no problem while one provider still answers", async () => {
    const { mapsSearch } = await setup({}, (url) => (url.includes("serpapi.com") ? fail("quota") : ok(SERPER)));
    await mapsSearch("tea", "Munnar", 2);
    expect(await problem()).toBeNull();
  });

  it("clears a failure once the provider answers again", async () => {
    const { mapsSearch } = await setup({ serpapiApiKey: "" }, allFail("timeout"));
    await mapsSearch("first", "Munnar", 2);
    expect(await problem()).toBe("serper: timeout");
    h.handler = () => ok(SERPER);
    await mapsSearch("second", "Munnar", 2);
    expect(await problem()).toBeNull();
  });

  it("says so when no provider is configured", async () => {
    await setup({ serpapiApiKey: "", serperApiKey: "" });
    expect(await problem()).toContain("no search provider is configured");
  });

  it("does not call a real empty answer a problem", async () => {
    const { mapsSearch } = await setup({}, () => ok({ local_results: [] }));
    expect(await mapsSearch("nothing", "Munnar", 2)).toEqual([]);
    expect(await problem()).toBeNull();
  });
});

describe("tool results during an outage", () => {
  const run = async (tool: string, args: Record<string, unknown>, handler: typeof h.handler) => {
    await setup({}, handler);
    const { TOOLS } = await import("../travel_agent/mcp_server/handlers.ts");
    const log = vi.fn();
    const result: any = await TOOLS[tool].run({ destination: "Chennai", interests: [], indoor_only: false, travellers: 2, ...args }, log);
    return { result, log };
  };
  const down = () => fail("quota");

  it("flags an empty places result with the reason and logs it", async () => {
    const { result, log } = await run("places_search", {}, down);
    expect(result).toEqual({ places: [], search_problem: "serpapi: quota; serper: quota" });
    expect(log).toHaveBeenCalledWith("[search] No results: serpapi: quota; serper: quota");
  });

  it("flags restaurants and accommodation the same way", async () => {
    expect((await run("restaurants_search", {}, down)).result.search_problem).toBe("serpapi: quota; serper: quota");
    expect((await run("accommodation_search", {}, down)).result.search_problem).toBe("serpapi: quota; serper: quota");
  });

  it("leaves a real empty answer alone", async () => {
    const { result, log } = await run("places_search", {}, () => ok({ local_results: [] }));
    expect(result).toEqual({ places: [] });
    expect(log).not.toHaveBeenCalledWith(expect.stringContaining("[search]"));
  });

  it("adds nothing to a result that has places", async () => {
    const { result } = await run("places_search", { destination: "Munnar" }, (url) => (url.includes("serpapi.com") ? ok(SERPAPI) : ok(SERPER)));
    expect(result.places.length).toBeGreaterThan(0);
    expect(result).not.toHaveProperty("search_problem");
  });
});
