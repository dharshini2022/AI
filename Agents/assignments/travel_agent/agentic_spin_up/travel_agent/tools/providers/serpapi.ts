import { settings } from "../../config.ts";
import { cached } from "../cache.ts";
import { requestJsonDetailed } from "../http.ts";
import { type PriceAndUrl, extractPriceAndUrl } from "../pricing/prices.ts";
import { type Dict, get, isDict, numStr, pyOr, pyStr, truthy } from "../util.ts";
import { type MapsProvider, isEnabled, isFallback, limit, noteFailure } from "./shared.ts";

const SERPAPI_URL = "https://serpapi.com/search";

const request = (params: Dict, signal?: AbortSignal) =>
  requestJsonDetailed("GET", SERPAPI_URL, {
    params: { ...params, api_key: settings.serpapiApiKey },
    timeoutMs: settings.searchTimeoutMs,
    signal,
  });

// SerpApi's response-level knowledge_graph: a price field, an offers panel, or "Restaurant · $$ · Indian".
function kgPriceAndUrl(data: Dict): PriceAndUrl {
  const kg = pyOr(data.knowledge_graph, {});
  const [price, url] = extractPriceAndUrl(kg);
  if (price) return [price, url];
  const m = /\${1,4}/.exec(pyStr(pyOr(kg.type, "")));
  return [m ? m[0] : null, null];
}

function mapsResults(data: Dict, num: number): Dict[] {
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

export const serpapiProvider: MapsProvider = {
  name: "serpapi",
  async search(query, [lat, lon], num, signal) {
    const params: Dict = { engine: "google_maps", type: "search", q: query, hl: "en", gl: "in" };
    if (lat !== null) params.ll = `@${numStr(lat)},${numStr(lon)},12z`;
    const { body, failure } = await request(params, signal);
    return failure ? { places: [], failure } : { places: mapsResults(pyOr(body, {}), num), failure: null };
  },
};

// Real nightly rates. Only SerpAPI has them, so there is no fallback: an empty list sends the caller
// to the maps listing instead.
export async function serpapiHotels(destination: string, adults: number, checkIn: string, checkOut: string, signal?: AbortSignal): Promise<Dict[]> {
  if (!isEnabled("serpapi")) return [];
  const key = `hotels|${destination}|${checkIn}|${checkOut}|${adults}`.toLowerCase();
  const properties = await cached<Dict[]>(key, () =>
    limit(async () => {
      const { body, failure } = await request(
        {
          engine: "google_hotels",
          q: `hotels in ${destination}`,
          check_in_date: checkIn,
          check_out_date: checkOut,
          adults: Math.max(1, adults),
          currency: "INR",
          gl: "in",
          hl: "en",
        },
        signal,
      );
      noteFailure("serpapi", failure);
      return failure ? null : { value: pyOr(get(pyOr(body, {}), "properties"), []), fallback: isFallback("serpapi") };
    }),
  );
  return properties ?? [];
}
