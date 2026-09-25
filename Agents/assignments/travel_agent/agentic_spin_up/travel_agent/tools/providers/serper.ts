import { settings } from "../../config.ts";
import { cached } from "../cache.ts";
import { requestJsonDetailed } from "../http.ts";
import { type Dict, get, numStr, pyOr, pyStr } from "../util.ts";
import { type MapsProvider, isEnabled, limit, noteFailure } from "./shared.ts";

const SERPER_URL = "https://google.serper.dev/maps";
const SERPER_WEB_URL = "https://google.serper.dev/search";

// Serper's places already use the field names `shape()` reads (title, latitude, longitude, rating,
// ratingCount, type, types, phoneNumber, website, openingHours, cid), so nothing is renamed here.
// They carry no price fields, so every price from Serper is an estimate.
export const serperProvider: MapsProvider = {
  name: "serper",
  async search(query, [lat, lon], num, signal) {
    const body: Dict = { q: query, gl: "in", hl: "en" };
    if (lat !== null) body.ll = `@${numStr(lat)},${numStr(lon)},12z`;
    const { body: data, failure } = await requestJsonDetailed("POST", SERPER_URL, {
      headers: { "X-API-KEY": settings.serperApiKey },
      json: body,
      timeoutMs: settings.searchTimeoutMs,
      signal,
    });
    if (failure) return { places: [], failure };
    // Serper ignores `num` and returns about 20 places per call, so the list is trimmed here.
    return { places: (pyOr(get(data, "places"), []) as Dict[]).slice(0, num), failure: null };
  },
};

// The title and snippet of the top web results for a query (1 credit a call), or null if the search failed.
// A failure is not cached; an answer is, since these facts change slowly.
export async function serperWebSearch(query: string, signal?: AbortSignal): Promise<{ title: string; snippet: string }[] | null> {
  if (!isEnabled("serper")) return null;
  return cached<{ title: string; snippet: string }[]>(`web|${query}`.toLowerCase(), () =>
    limit(async () => {
      const { body, failure } = await requestJsonDetailed("POST", SERPER_WEB_URL, {
        headers: { "X-API-KEY": settings.serperApiKey },
        json: { q: query, gl: "in", hl: "en", num: 5 },
        timeoutMs: settings.searchTimeoutMs,
        signal,
      });
      noteFailure("serper", failure);
      if (failure) return null;
      const organic = (pyOr(get(body, "organic"), []) as Dict[]).slice(0, 5);
      return { value: organic.map((r) => ({ title: pyStr(pyOr(r.title, "")), snippet: pyStr(pyOr(r.snippet, "")) })), fallback: false };
    }),
  );
}
