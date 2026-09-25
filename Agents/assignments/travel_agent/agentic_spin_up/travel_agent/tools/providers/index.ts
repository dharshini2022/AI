import { settings } from "../../config.ts";
import { cached } from "../cache.ts";
import { geocode } from "../search/geo.ts";
import type { HttpFailure } from "../http.ts";
import type { Dict } from "../util.ts";
import { serpapiProvider } from "./serpapi.ts";
import { serperProvider } from "./serper.ts";
import { type MapsProvider, isEnabled, isFallback, limit, noteFailure } from "./shared.ts";

const PROVIDERS: Record<string, MapsProvider> = { serpapi: serpapiProvider, serper: serperProvider };

// The next provider is tried on these. A plain 4xx ("rejected") would fail the same way anywhere.
const TRY_NEXT = new Set<HttpFailure>(["quota", "rate_limited", "unauthorized", "timeout", "network", "server"]);

const chain = (only?: string[]) =>
  settings.mapsProviders.flatMap((name) => (isEnabled(name) && (!only || only.includes(name)) ? [PROVIDERS[name]] : []));

async function runChain(query: string, city: string, num: number, signal?: AbortSignal, only?: string[]) {
  const center = await geocode(city);
  for (const provider of chain(only)) {
    const { places, failure } = await provider.search(query, center, num, signal);
    noteFailure(provider.name, failure); // a success clears an earlier failure
    if (!failure) return { value: places, fallback: isFallback(provider.name) };
    if (!TRY_NEXT.has(failure)) return null;
  }
  return null;
}

// Places for a maps query from the first provider that answers. An empty list is a real answer and
// does not try the next provider. `only` limits the search to named providers (for example when only
// SerpAPI can supply a price).
export async function mapsSearch(query: string, city: string, num: number, signal?: AbortSignal, only?: string[]): Promise<Dict[]> {
  if (!chain(only).length) return [];
  const key = `maps|${only?.join("+") ?? "*"}|${query}|${city}|${num}`.toLowerCase();
  const places = await cached<Dict[]>(key, () => limit(() => runChain(query, city, num, signal, only)));
  return places ?? [];
}
