import { settings } from "../config.ts";
import { type LatLon, geocode } from "./geo.ts";
import { haversineKm } from "./itinerary.ts";
import { serpapi } from "./serpapi.ts";
import { type Dict, addDays, fmtFixed, get, isDict, numStr, pyOr, pyQuote, pyRound, pyStr, truthy } from "./util.ts";

// Every price in the planner is INR (domestic-India trips, INR budget cap).
const PRICE_LEVEL_COST: Record<string, number> = {
  "$": 150, "$$": 450, "$$$": 1200, "$$$$": 2500,
  inexpensive: 150, moderate: 450, expensive: 1200, "very expensive": 2500,
};
const MEAL_DEFAULT_COST: Record<string, number> = { Breakfast: 150, Lunch: 350, Dinner: 450 };

// Rough per-person entry fee (INR) by attraction kind, keyword-matched on name / type.
const ATTRACTION_COST: [string[], number][] = [
  [["national park", "wildlife", "sanctuary", "tiger reserve"], 250],
  [["museum", "gallery", "palace", "fort", "zoo", "aquarium", "amusement",
    "theme park", "adventure park", "garden", "botanical"], 200],
  [["falls", "waterfall", "dam", "point", "view", "lake", "bridge", "beach",
    "temple", "church", "market", "bazaar"], 30],
];
const ATTRACTION_DEFAULT_COST = 100;

const NON_ATTRACTION = ["restaurant", "hotel", "motel", "lodging", "atm", "bank",
  "gas station", "car repair", "parking"];

const PRICE_KEYS = ["price", "priceLevel", "price_level", "price_range", "priceRange"];

function withinRadius(v: Dict, center: LatLon, maxKm = 80): boolean {
  if (center[0] === null || center[1] === null) return true;
  if (v.lat == null || v.lon == null) return true;
  return haversineKm(center as [number, number], [v.lat, v.lon]) <= maxKm;
}

function attractionCost(name: string, types: string[]): number {
  const blob = [name || "", ...types].join(" ").toLowerCase();
  for (const [keywords, cost] of ATTRACTION_COST) {
    if (keywords.some((k) => blob.includes(k))) return cost;
  }
  return ATTRACTION_DEFAULT_COST;
}

function amounts(s: unknown): number[] {
  return (pyStr(s).match(/\d[\d,]*/g) ?? []).map((x) => Number(x.replaceAll(",", "")));
}

// A dollar amount ("$31", "US$23-31"), not a Google price band ("$$").
function isUsd(s: string): boolean {
  return /(?:US\$|USD|\$)\s?\d/.test(s);
}

const FOR_TWO = /\bfor\s*(?:two|2)\b|\bper\s*couple\b/i;
const FOR_TWO_ALL = new RegExp(FOR_TWO.source, "gi");

function isForTwo(s: string): boolean {
  return FOR_TWO.test(s);
}

// The "for two" clause is stripped first so its digit isn't read as an amount.
function amountsInr(s: string): number[] {
  const body = s.replace(FOR_TWO_ALL, "");
  const nums = amounts(body);
  return nums.length && isUsd(body) ? nums.map((n) => pyRound(n * settings.usdToInr, 2)) : nums;
}

export function costFromPriceLevel(level: unknown, fallback: number): number {
  if (!truthy(level)) return fallback;
  const s = pyStr(level).trim();
  const key = s.toLowerCase();
  if (Object.hasOwn(PRICE_LEVEL_COST, key)) return PRICE_LEVEL_COST[key];
  const nums = amountsInr(s);
  if (nums.length) {
    let cost = nums.reduce((a, b) => a + b, 0) / nums.length;
    if (isForTwo(s)) cost /= 2;
    return pyRound(cost, 2);
  }
  const dollars = s.length - s.replace(/^\$+/, "").length;
  if (dollars) return PRICE_LEVEL_COST["$".repeat(Math.min(dollars, 4))] ?? fallback;
  return fallback;
}

export function normPriceLevel(v: unknown): string | null {
  if (!truthy(v)) return null;
  const s = pyStr(v).replace(/\s+/g, " ").trim();
  if (/^\$+$/.test(s) || Object.hasOwn(PRICE_LEVEL_COST, s.toLowerCase())) return s;
  const nums = amountsInr(s);
  if (!nums.length) return null;
  return "₹" + nums.map((n) => fmtFixed(n, 0)).join("–") + (isForTwo(s) ? " for two" : "");
}

type PriceAndUrl = [string | null, string | null];

function extractOffer(o: unknown): PriceAndUrl {
  if (typeof o === "string") return [o, null];
  if (!isDict(o)) return [null, null];
  const price = pyOr(o.price, o.rate, get(pyOr(o.rate_per_night, {}), "lowest"));
  const link = pyOr(o.link, o.url, o.booking_url, o.booking_link);
  return [truthy(price) ? pyStr(price) : null, truthy(link) ? pyStr(link) : null];
}

function cheapestOffer(offers: unknown): PriceAndUrl {
  if (!truthy(offers)) return [null, null];
  const items: unknown[] = [];
  if (Array.isArray(offers)) {
    items.push(...offers);
  } else if (isDict(offers)) {
    // {"Agoda": {"price": ..., "link": ...}} or {"Agoda": "$10"}
    for (const [source, v] of Object.entries(offers)) {
      if (isDict(v)) items.push(v);
      else if (typeof v === "string") items.push({ source, price: v });
    }
  }

  const candidates: [number, string, string | null][] = [];
  for (const item of items) {
    const [price, link] = extractOffer(item);
    if (!price) continue;
    const inr = amountsInr(price);
    const nums = inr.length ? inr : amounts(price);
    if (nums.length) candidates.push([nums[0], price, link]);
  }
  if (!candidates.length) return [null, null];
  candidates.sort((a, b) => a[0] - b[0]);
  return [candidates[0][1], candidates[0][2]];
}

// Price band first, then the cheapest OTA offer, then google_hotels `prices`, then any price text.
export function extractPriceAndUrl(p: Dict): PriceAndUrl {
  for (const key of PRICE_KEYS) {
    if (truthy(p[key]) && /^\$+$/.test(pyStr(p[key]).trim())) return [pyStr(p[key]).trim(), null];
  }
  for (const holder of [p, pyOr(p.knowledge_graph, {})]) {
    if (!isDict(holder)) continue;
    const pricing = pyOr(holder.pricing, {});
    if (isDict(pricing)) {
      const [price, url] = cheapestOffer(pricing.offers);
      if (price) return [price, url];
    }
  }
  const prices = pyOr(p.prices, []);
  if (Array.isArray(prices)) {
    const [price, url] = cheapestOffer(prices);
    if (price) return [price, url];
  }
  for (const key of PRICE_KEYS) {
    if (truthy(p[key])) return [pyStr(p[key]), null];
  }
  return [null, null];
}

export function cleanName(name: string): string {
  const cleaned = name.split("|")[0].split(" - ")[0].trim().replace(/^(top|best|\d+\.?)\s+/i, "").trim();
  return cleaned || "Place";
}

export function mapsUrl({ name, city, cid, lat, lon, address }: {
  name: string; city: string; cid?: unknown; lat?: unknown; lon?: unknown; address?: unknown;
}): string {
  if (truthy(cid)) return `https://www.google.com/maps?cid=${pyStr(cid)}`;
  const q = pyQuote(`${name}, ${pyStr(pyOr(address, city))}`);
  if (lat != null && lon != null) {
    return `https://www.google.com/maps/search/?api=1&query=${q}&center=${numStr(lat)},${numStr(lon)}`;
  }
  return `https://www.google.com/maps/search/?api=1&query=${q}`;
}

export function hoursStr(v: unknown): string | null {
  if (!truthy(v)) return null;
  const squash = (s: string) => s.replace(/\s+/g, " ").trim() || null;
  if (typeof v === "string") return squash(v);
  if (isDict(v)) {
    const distinct = [...new Set(Object.values(v))];
    const joined = distinct.length === 1
      ? distinct[0]
      : Object.entries(v).map(([day, hrs]) => `${day.slice(0, 3)} ${pyStr(hrs)}`).join("; ");
    return squash(pyStr(joined));
  }
  return squash(pyStr(v));
}

function coords(p: Dict): [any, any] {
  const g = pyOr(p.gps_coordinates, {});
  return [get(p, "latitude", get(g, "latitude")), get(p, "longitude", get(g, "longitude"))];
}

function isClosed(p: Dict): boolean {
  if (truthy(p.permanentlyClosed) || truthy(p.permanently_closed)) return true;
  const status = pyStr(pyOr(p.businessStatus, p.business_status, "")).toUpperCase();
  if (status === "CLOSED_PERMANENTLY" || status === "CLOSED_TEMPORARILY") return true;
  return pyStr(pyOr(p.open_state, "")).toLowerCase().includes("permanently closed");
}

// Rating weighted by review count, so a 4.8 with 20k reviews outranks a 4.9 with 12.
function popularity(p: Dict): number {
  return Number(pyOr(p.rating, 0)) * Math.log1p(Number(pyOr(p.rating_count, 0)));
}

function shape(p: Dict, city: string, { category, indoor, estCost }: { category: string; indoor: boolean; estCost: number }): Dict {
  const name = cleanName(pyStr(pyOr(p.title, p.name, "Unknown")));
  const [lat, lon] = coords(p);
  const addr = get(p, "address");
  const [rawPrice] = extractPriceAndUrl(p);
  return {
    name,
    category: pyOr(p.category, p.type, category),
    types: (pyOr(p.types, []) as unknown[]).map(pyStr),
    address: pyOr(addr, city),
    rating: get(p, "rating"),
    rating_count: pyOr(p.ratingCount, p.reviews),
    hours: hoursStr(pyOr(p.openingHours, p.hours, p.workingHours, p.operating_hours)),
    phone: pyOr(p.phoneNumber, p.phone),
    website: get(p, "website"),
    lat,
    lon,
    maps_url: mapsUrl({ name, city, cid: pyOr(p.cid, p.data_cid), lat, lon, address: addr }),
    indoor,
    price_level: normPriceLevel(rawPrice),
    est_cost: costFromPriceLevel(rawPrice, estCost),
  };
}

function looksLikeAttraction(shaped: Dict): boolean {
  const blob = [pyStr(pyOr(shaped.category, "")), ...get(shaped, "types", [])].join(" ").toLowerCase();
  return !NON_ATTRACTION.some((bad) => blob.includes(bad));
}

function dedupe(items: Dict[]): Dict[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = item.name.toLowerCase().trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Budget limit: items at or under `cap`, cheapest first; if none qualify, the `fallbackCount` cheapest.
function capByCost(items: Dict[], key: string, cap: number | null, fallbackCount: number): Dict[] {
  if (cap == null) return items;
  const cheapestFirst = [...items].sort((a, b) => Number(a[key] ?? 0) - Number(b[key] ?? 0));
  const within = cheapestFirst.filter((item) => Number(item[key] ?? 0) <= cap);
  return within.length ? within : cheapestFirst.slice(0, fallbackCount);
}

// A tool stops waiting on slow upstream calls after this and returns what it has.
function toolDeadline(): AbortSignal {
  return AbortSignal.timeout(settings.toolDeadlineMs);
}

// SerpApi's response-level knowledge_graph: a price field, an offers panel, or "Restaurant · $$ · Indian".
function kgPriceAndUrl(data: Dict): PriceAndUrl {
  const kg = pyOr(data.knowledge_graph, {});
  const [price, url] = extractPriceAndUrl(kg);
  if (price) return [price, url];
  const m = /\${1,4}/.exec(pyStr(pyOr(kg.type, "")));
  return [m ? m[0] : null, null];
}

async function serpapiMaps(query: string, city: string, num: number, signal: AbortSignal): Promise<Dict[]> {
  if (!settings.serpapiApiKey) return [];
  const params: Dict = { engine: "google_maps", type: "search", q: query, hl: "en", gl: "in" };
  const [lat, lon] = await geocode(city);
  if (lat !== null) params.ll = `@${numStr(lat)},${numStr(lon)},12z`;
  const data: Dict = pyOr(await serpapi(params, signal), {});

  let results: Dict[] = pyOr(data.local_results, []);
  if (!truthy(results) && isDict(data.place_results)) results = [data.place_results];
  if (!truthy(results) && isDict(data.knowledge_graph)) results = [data.knowledge_graph];
  results = results.slice(0, num);

  // Fill a missing price / booking_url from the knowledge_graph when it clearly refers to a result.
  const [kgPrice, kgUrl] = kgPriceAndUrl(data);
  const kgTitle = pyStr(pyOr(get(pyOr(data.knowledge_graph, {}), "title"), "")).toLowerCase();
  for (const r of results) {
    const [rPrice, rUrl] = extractPriceAndUrl(r);
    if (rPrice && !truthy(r.price)) r.price = rPrice;
    if (rUrl && !truthy(r.booking_url)) r.booking_url = rUrl;

    const matchesKg = results.length === 1 || (kgTitle !== "" && pyStr(pyOr(r.title, "")).toLowerCase().includes(kgTitle));
    if (matchesKg) {
      if (kgPrice && !truthy(r.price)) r.price = kgPrice;
      if (kgUrl && !truthy(r.booking_url)) r.booking_url = kgUrl;
    }
  }
  return results;
}

async function serpapiHotels(destination: string, adults: number, checkIn: string, checkOut: string, signal: AbortSignal): Promise<Dict[]> {
  if (!settings.serpapiApiKey) return [];
  const data = await serpapi({
    engine: "google_hotels",
    q: `hotels in ${destination}`,
    check_in_date: checkIn,
    check_out_date: checkOut,
    adults: Math.max(1, adults),
    currency: "INR",
    gl: "in",
    hl: "en",
  }, signal);
  return pyOr(get(pyOr(data, {}), "properties"), []);
}

// Generic queries always run so a destination's headline sights are in the pool.
const DISCOVERY_OUTDOOR = [
  (d: string) => `top tourist attractions in ${d}`,
  (d: string) => `best things to do in ${d}`,
  (d: string) => `famous landmarks and monuments in ${d}`,
  (d: string) => `museums and galleries in ${d}`,
  (d: string) => `parks gardens and viewpoints in ${d}`,
];
const DISCOVERY_INDOOR = [
  (d: string) => `indoor attractions in ${d}`,
  (d: string) => `museums and art galleries in ${d}`,
  (d: string) => `aquariums and science centres in ${d}`,
  (d: string) => `indoor activities and entertainment in ${d}`,
  (d: string) => `shopping malls and markets in ${d}`,
];
const PLACE_POOL_SIZE = 12;

export async function searchPlaces(
  destination: string,
  interests: string[],
  indoorOnly = false,
  maxCostPerPerson: number | null = null,
): Promise<Dict[]> {
  const kind = indoorOnly ? "indoor museum gallery activity" : "spots attractions";
  const queries = [
    ...(indoorOnly ? DISCOVERY_INDOOR : DISCOVERY_OUTDOOR).map((template) => template(destination)),
    ...(interests ?? []).map((term) => `${term} ${kind} in ${destination}`),
  ];

  const deadline = toolDeadline();
  const center = await geocode(destination);
  // Queries run together; Promise.all keeps their order, so dedupe and ranking are unchanged.
  const batches = await Promise.all(queries.map((q) => serpapiMaps(q, destination, 20, deadline)));

  const shaped: Dict[] = [];
  for (const p of batches.flat()) {
    if (isClosed(p)) continue;
    const v = shape(p, destination, { category: "attraction", indoor: indoorOnly, estCost: ATTRACTION_DEFAULT_COST });
    if (!looksLikeAttraction(v) || !withinRadius(v, center)) continue;
    if (!truthy(v.price_level)) v.est_cost = attractionCost(v.name, v.types);
    shaped.push(v);
  }
  const ranked = dedupe(shaped).sort((a, b) => popularity(b) - popularity(a));
  return capByCost(ranked, "est_cost", maxCostPerPerson, PLACE_POOL_SIZE).slice(0, PLACE_POOL_SIZE);
}

const MEALS: [string, string][] = [
  ["Breakfast", "breakfast cafes and tiffin spots"],
  ["Lunch", "lunch restaurants and meals"],
  ["Dinner", "dinner restaurants"],
];

export async function searchRestaurants(
  destination: string,
  interests: string[],
  maxCostPerPerson: number | null = null,
): Promise<Dict> {
  const deadline = toolDeadline();
  const center = await geocode(destination);
  const veg = (interests ?? []).some((i) => i.toLowerCase().includes("veg")) ? "vegetarian " : "";
  const perMeal = await Promise.all(
    MEALS.map(async ([meal, phrase]) => {
      const raw = await serpapiMaps(`best ${veg}${phrase} in ${destination}`, destination, 8, deadline);
      const shaped = dedupe(
        raw
          .filter((p) => !isClosed(p))
          .map((p) => shape(p, destination, { category: `${meal.toLowerCase()} spot`, indoor: true, estCost: MEAL_DEFAULT_COST[meal] })),
      ).filter((v) => withinRadius(v, center));
      return [meal, capByCost(shaped, "est_cost", maxCostPerPerson, 5).slice(0, 5)] as const;
    }),
  );
  return Object.fromEntries(perMeal);
}

// Real nightly rates via google_hotels when dates are known; otherwise a maps listing with a synthetic rate.
export async function searchAccommodation(
  destination: string,
  numTravellers: number,
  startDate: string | null = null,
  nights: number | null = null,
  maxPricePerNight: number | null = null,
): Promise<Dict[]> {
  const deadline = toolDeadline();
  const center = await geocode(destination);
  const useSerpapi = settings.mapsProvider === "serpapi" && Boolean(settings.serpapiApiKey);

  if (useSerpapi && startDate) {
    const checkOut = addDays(startDate, Math.max(1, nights || 1));
    const props = checkOut ? await serpapiHotels(destination, numTravellers, startDate, checkOut, deadline) : [];
    const out: Dict[] = [];
    for (const p of props.slice(0, 6)) {
      let rate = get(pyOr(p.rate_per_night, {}), "extracted_lowest");
      const [ps, offerUrl] = extractPriceAndUrl(p);
      const bookingUrl = truthy(pyOr(p.link, p.booking_url)) ? pyOr(p.link, p.booking_url) : offerUrl;
      if (!truthy(rate)) {
        // Some properties only carry an OTA offers list.
        const nums = ps ? amountsInr(ps) : [];
        rate = nums.length ? Math.min(...nums) : null;
      }
      if (!truthy(rate)) continue;
      const g = pyOr(p.gps_coordinates, {});
      const name = cleanName(pyStr(p.name ?? "Hotel"));
      const [lat, lon] = [get(g, "latitude"), get(g, "longitude")];
      const item = {
        name,
        price_per_night: Number(rate),
        rating: get(p, "overall_rating"),
        address: pyOr(p.address, destination),
        lat,
        lon,
        maps_url: mapsUrl({ name, city: destination, lat, lon }),
        booking_url: bookingUrl,
        url: bookingUrl,
      };
      if (withinRadius(item, center)) out.push(item);
    }
    if (out.length) return capByCost(out, "price_per_night", maxPricePerNight, 3);
  }

  const raw = await serpapiMaps(`top hotels resorts stays in ${destination}`, destination, 6, deadline);
  // Each listing (and its optional detail lookup) is independent, so they resolve together.
  const items = await Promise.all(
    raw.slice(0, 6).map(async (p, i) => {
      const name = cleanName(pyStr(pyOr(p.title, p.name, "Hotel")));
      const [lat, lon] = coords(p);
      const addr = get(p, "address");
      let [ps, bookingUrl]: [unknown, unknown] = extractPriceAndUrl(p);
      if (!truthy(bookingUrl)) bookingUrl = pyOr(p.booking_url, p.link);
      if ((!truthy(ps) || !truthy(bookingUrl)) && useSerpapi && i < 4) {
        const detail = await serpapiMaps(`${name} ${destination}`, destination, 1, deadline);
        if (detail.length) {
          const [detailPrice, detailUrl] = extractPriceAndUrl(detail[0]);
          ps = pyOr(ps, detailPrice, detail[0].price);
          bookingUrl = pyOr(bookingUrl, detailUrl, detail[0].booking_url);
        }
      }
      const nums = truthy(ps) ? amountsInr(pyStr(ps)) : [];
      return {
        name,
        price_per_night: nums.length ? Math.min(...nums) : 3000 + 1500 * (i % 4),
        rating: pyOr(p.rating, p.overall_rating),
        address: pyOr(addr, destination),
        lat,
        lon,
        maps_url: mapsUrl({ name, city: destination, cid: pyOr(p.cid, p.data_cid), lat, lon, address: addr }),
        booking_url: bookingUrl,
        url: bookingUrl,
      };
    }),
  );
  return capByCost(items.filter((item) => withinRadius(item, center)), "price_per_night", maxPricePerNight, 3);
}
