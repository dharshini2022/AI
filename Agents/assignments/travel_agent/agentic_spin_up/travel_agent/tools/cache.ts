import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { settings } from "../config.ts";

// `fallback` is true when a backup provider answered, so the answer is kept for less time.
export interface Sourced<T> {
  value: T;
  fallback: boolean;
}

interface Entry {
  value: unknown;
  expires: number;
}

// Mirrors the cache file. The MCP server is a new process on every run, so this is what lets a
// repeat run skip searches it has already paid for.
let entries: Map<string, Entry> | null = null;
const inFlight = new Map<string, Promise<Sourced<unknown> | null>>();

function readEntries(): Map<string, Entry> {
  if (entries) return entries;
  const now = Date.now();
  try {
    const saved: Record<string, Entry> = JSON.parse(readFileSync(settings.searchCacheFile, "utf8"));
    entries = new Map(Object.entries(saved).filter(([, entry]) => entry.expires > now));
  } catch {
    entries = new Map(); // no file yet, or one we cannot read: start empty
  }
  return entries;
}

// Written to a temp name and renamed, so a crash cannot leave half a file.
function writeEntries(all: Map<string, Entry>): void {
  const now = Date.now();
  const live = Object.fromEntries([...all].filter(([, entry]) => entry.expires > now));
  const temp = `${settings.searchCacheFile}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(settings.searchCacheFile), { recursive: true });
    writeFileSync(temp, JSON.stringify(live));
    renameSync(temp, settings.searchCacheFile);
  } catch {
    // a cache that cannot be written must never fail a search
  }
}

function remember(key: string, { value, fallback }: Sourced<unknown>): void {
  const ttl = fallback ? settings.searchFallbackCacheTtlMs : settings.searchCacheTtlMs;
  if (ttl <= 0) return;
  const all = readEntries();
  all.set(key, { value, expires: Date.now() + ttl });
  writeEntries(all);
}

// Shares identical requests that are in flight and keeps answers on disk. `fetch` returns null on a
// failure, and failures are not kept. Every caller gets its own copy because tools mutate the listings.
export async function cached<T>(key: string, fetch: () => Promise<Sourced<T> | null>): Promise<T | null> {
  if (settings.searchCacheTtlMs <= 0 && settings.searchFallbackCacheTtlMs <= 0) return (await fetch())?.value ?? null;

  const hit = readEntries().get(key);
  if (hit && hit.expires > Date.now()) return structuredClone(hit.value) as T;

  let pending = inFlight.get(key);
  if (!pending) {
    pending = fetch()
      .then((result) => {
        if (result) remember(key, result);
        return result;
      })
      .finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  const result = (await pending) as Sourced<T> | null;
  return result ? structuredClone(result.value) : null;
}
