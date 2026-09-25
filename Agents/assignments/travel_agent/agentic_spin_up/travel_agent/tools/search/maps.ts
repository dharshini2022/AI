import { settings } from "../../config.ts";
import { type LatLon, geocode } from "./geo.ts";
import { haversineKm } from "../itinerary.ts";
import { amountsInr, costFromPriceLevel, extractPriceAndUrl, normPriceLevel } from "../pricing/prices.ts";
import { lookupHotelClass } from "../pricing/hotelClass.ts";
import { estimateNightlyRate, hotelStars } from "../pricing/hotelRates.ts";
import { mapsSearch } from "../providers/index.ts";
import { serpapiHotels } from "../providers/serpapi.ts";
import { isEnabled } from "../providers/shared.ts";
import { type Dict, addDays, get, isDict, numStr, pyOr, pyQuote, pyStr, truthy } from "../util.ts";

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
  const priceLevel = normPriceLevel(rawPrice);
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
    price_level: priceLevel,
    est_cost: costFromPriceLevel(rawPrice, estCost),
    estimated: !truthy(priceLevel), // no listed price: the cost is a default or a keyword guess
  };
}

function looksLikeAttraction(shaped: Dict): boolean {
  const blob = [pyStr(pyOr(shaped.category, "")), ...get(shaped, "types", [])].join(" ").toLowerCase();
  return !NON_ATTRACTION.some((bad) => blob.includes(bad));
}

// The user's exclusions (e.g. "temples"): true when a term appears in the place's name, category or types.
// Types are snake_case ("hindu_temple"), and a plural term also matches its singular.
function isExcluded(shaped: Dict, exclude: string[]): boolean {
  if (!exclude.length) return false;
  const blob = [shaped.name, pyStr(pyOr(shaped.category, "")), ...get(shaped, "types", [])].join(" ").toLowerCase().replaceAll("_", " ");
  return exclude.some((term) => {
    const t = term.trim().toLowerCase();
    return t !== "" && blob.includes(t.length > 3 ? t.replace(/s$/, "") : t);
  });
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
  exclude: string[] = [],
): Promise<Dict[]> {
  const kind = indoorOnly ? "indoor museum gallery activity" : "spots attractions";
  const queries = [
    ...(indoorOnly ? DISCOVERY_INDOOR : DISCOVERY_OUTDOOR).map((template) => template(destination)),
    ...(interests ?? []).map((term) => `${term} ${kind} in ${destination}`),
  ];

  const deadline = toolDeadline();
  const center = await geocode(destination);
  // Queries run together; Promise.all keeps their order, so dedupe and ranking are unchanged.
  const batches = await Promise.all(queries.map((q) => mapsSearch(q, destination, 20, deadline)));

  const shaped: Dict[] = [];
  for (const p of batches.flat()) {
    if (isClosed(p)) continue;
    const v = shape(p, destination, { category: "attraction", indoor: indoorOnly, estCost: ATTRACTION_DEFAULT_COST });
    if (!looksLikeAttraction(v) || !withinRadius(v, center) || isExcluded(v, exclude)) continue;
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
  exclude: string[] = [],
): Promise<Dict> {
  const deadline = toolDeadline();
  const center = await geocode(destination);
  const veg = (interests ?? []).some((i) => i.toLowerCase().includes("veg")) ? "vegetarian " : "";
  const perMeal = await Promise.all(
    MEALS.map(async ([meal, phrase]) => {
      const raw = await mapsSearch(`best ${veg}${phrase} in ${destination}`, destination, 8, deadline);
      const shaped = dedupe(
        raw
          .filter((p) => !isClosed(p))
          .map((p) => shape(p, destination, { category: `${meal.toLowerCase()} spot`, indoor: true, estCost: MEAL_DEFAULT_COST[meal] })),
      ).filter((v) => withinRadius(v, center) && !isExcluded(v, exclude));
      return [meal, capByCost(shaped, "est_cost", maxCostPerPerson, 5).slice(0, 5)] as const;
    }),
  );
  return Object.fromEntries(perMeal);
}

// Real nightly rates via google_hotels when dates are known; otherwise a maps listing whose rate is an estimate from its star class.
export async function searchAccommodation(
  destination: string,
  numTravellers: number,
  startDate: string | null = null,
  nights: number | null = null,
  maxPricePerNight: number | null = null,
): Promise<Dict[]> {
  const deadline = toolDeadline();
  const center = await geocode(destination);
  const useSerpapi = isEnabled("serpapi");

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
        estimated: false,
      };
      if (withinRadius(item, center)) out.push(item);
    }
    if (out.length) return capByCost(out, "price_per_night", maxPricePerNight, 3);
  }

  const raw = await mapsSearch(`top hotels resorts stays in ${destination}`, destination, 6, deadline);
  // Each listing (and its optional detail lookup) is independent, so they resolve together.
  const items = await Promise.all(
    raw.slice(0, 6).map(async (p, i) => {
      const name = cleanName(pyStr(pyOr(p.title, p.name, "Hotel")));
      const [lat, lon] = coords(p);
      const addr = get(p, "address");
      let [ps, bookingUrl]: [unknown, unknown] = extractPriceAndUrl(p);
      if (!truthy(bookingUrl)) bookingUrl = pyOr(p.booking_url, p.link);
      if ((!truthy(ps) || !truthy(bookingUrl)) && useSerpapi && i < 4) {
        const detail = await mapsSearch(`${name} ${destination}`, destination, 1, deadline, ["serpapi"]);
        if (detail.length) {
          const [detailPrice, detailUrl] = extractPriceAndUrl(detail[0]);
          ps = pyOr(ps, detailPrice, detail[0].price);
          bookingUrl = pyOr(bookingUrl, detailUrl, detail[0].booking_url);
        }
      }
      const nums = truthy(ps) ? amountsInr(pyStr(ps)) : [];
      // Only a stay with no price needs a class, and a search is spent only if the listing does not state one.
      const stars = nums.length ? null : (hotelStars(p) ?? (await lookupHotelClass(name, destination, deadline)));
      return {
        name,
        price_per_night: nums.length ? Math.min(...nums) : estimateNightlyRate(destination, stars),
        rating: pyOr(p.rating, p.overall_rating),
        address: pyOr(addr, destination),
        lat,
        lon,
        maps_url: mapsUrl({ name, city: destination, cid: pyOr(p.cid, p.data_cid), lat, lon, address: addr }),
        booking_url: bookingUrl,
        url: bookingUrl,
        estimated: !nums.length,
      };
    }),
  );
  return capByCost(items.filter((item) => withinRadius(item, center)), "price_per_night", maxPricePerNight, 3);
}
