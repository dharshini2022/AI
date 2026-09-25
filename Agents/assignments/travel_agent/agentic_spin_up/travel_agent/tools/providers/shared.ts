import { settings } from "../../config.ts";
import { createLimiter } from "../../limiter.ts";
import type { LatLon } from "../search/geo.ts";
import type { HttpFailure } from "../http.ts";
import type { Dict } from "../util.ts";

// One search adapter. It returns places in the shape `shape()` in maps.ts reads, or the reason it failed.
export interface MapsProvider {
  name: string;
  search(query: string, center: LatLon, num: number, signal?: AbortSignal): Promise<{ places: Dict[]; failure: HttpFailure | null }>;
}

// At most SEARCH_CONCURRENCY searches run at once, whichever provider answers them.
export const limit = createLimiter(settings.searchConcurrency);

const apiKey = (name: string) => (name === "serpapi" ? settings.serpapiApiKey : name === "serper" ? settings.serperApiKey : "");

// Listed in MAPS_PROVIDER and has a key.
export const isConfigured = (name: string) => settings.mapsProviders.includes(name) && Boolean(apiKey(name));

// A provider that ran out of quota, or whose key was refused, stays off for the rest of the process so
// the remaining calls in a trip do not each wait on it. A plain rate limit does not switch it off.
const off = new Set<string>();
// The last failure of each provider, cleared the next time it answers. Feeds searchProblem().
const failing = new Map<string, HttpFailure>();

export const isEnabled = (name: string) => isConfigured(name) && !off.has(name);

// Called with the outcome of every provider call: a failure is remembered, a success (null) clears it.
export function noteFailure(name: string, failure: HttpFailure | null): void {
  if (failure) failing.set(name, failure);
  else failing.delete(name);
  if (failure === "quota" || failure === "unauthorized") off.add(name);
}

// Why no search can be answered right now, or null when at least one provider can. An empty result
// together with a problem is an outage, not "nothing there".
export function searchProblem(): string | null {
  const configured = settings.mapsProviders.filter(isConfigured);
  if (!configured.length) return "no search provider is configured (set SERP_API_KEY or SERPER_API_KEY in .env)";
  const down = configured.filter((name) => failing.has(name));
  return down.length === configured.length ? down.map((name) => `${name}: ${failing.get(name)}`).join("; ") : null;
}

// True when a provider other than the first configured one answered.
export const isFallback = (name: string) => settings.mapsProviders.find(isConfigured) !== name;
