import { requestJson } from "./http.ts";
import { get, pyOr, truthy } from "./util.ts";

const GEO_URL = "https://geocoding-api.open-meteo.com/v1/search";

export type LatLon = [number, number] | [null, null];

// Promises are cached so concurrent first lookups for the same city share one request.
const cache = new Map<string, Promise<LatLon>>();

export function geocode(city: string): Promise<LatLon> {
  const key = (city || "").trim().toLowerCase();
  if (!key) return Promise.resolve([null, null]);
  let hit = cache.get(key);
  if (!hit) {
    hit = lookup(city);
    cache.set(key, hit);
  }
  return hit;
}

async function lookup(city: string): Promise<LatLon> {
  const data = await requestJson("GET", GEO_URL, { params: { name: city, count: 1 } });
  const results = pyOr(get(pyOr(data, {}), "results"), []);
  return truthy(results) ? [results[0].latitude, results[0].longitude] : [null, null];
}
