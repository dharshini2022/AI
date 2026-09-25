import { dirname, join } from "node:path";
import dotenv from "dotenv";

export const ROOT = import.meta.dirname;
export const PKG_ROOT = dirname(ROOT);

dotenv.config({ path: join(PKG_ROOT, ".env"), quiet: true });

function floatEnv(key: string, fallback: number): number {
  const raw = (process.env[key] ?? "").trim();
  const value = Number(raw);
  return raw === "" || Number.isNaN(value) ? fallback : value;
}

function intEnv(key: string, fallback: number): number {
  const raw = (process.env[key] ?? "").trim();
  return /^[+-]?\d+$/.test(raw) ? Number.parseInt(raw, 10) : fallback;
}

// A comma-separated list, lower-cased, in the order given.
function listEnv(key: string, fallback: string[]): string[] {
  const items = (process.env[key] ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  return items.length ? items : fallback;
}

function boolEnv(key: string, fallback: boolean): boolean {
  const raw = (process.env[key] ?? "").trim().toLowerCase();
  return raw === "" ? fallback : ["1", "true", "yes", "on"].includes(raw);
}

export const settings = Object.freeze({
  llmModel: process.env.LLM_MODEL ?? "xai/grok-4.6",
  llmApiKey: process.env.LLM_API_KEY ?? "",
  llmApiBase: process.env.LLM_API_BASE ?? "",
  llmTemperature: floatEnv("LLM_TEMPERATURE", 0.2),
  llmParallelToolCalls: boolEnv("LLM_PARALLEL_TOOL_CALLS", true),
  llmRecursionLimit: intEnv("LLM_RECURSION_LIMIT", 100),

  specDir: join(ROOT, "agent_specs"),   //parent folder path of agent spec markdown files
  skillDir: join(ROOT, "agent-skills"), //parent folder path of agent skills markdown files
  mcpServerCmd: process.env.MCP_SERVER_CMD ?? "",
  mcpMaxConcurrency: intEnv("MCP_MAX_CONCURRENCY", 5),

  mapsProviders: listEnv("MAPS_PROVIDER", ["serpapi", "serper"]),
  serpapiApiKey: process.env.SERP_API_KEY ?? "",
  serperApiKey: process.env.SERPER_API_KEY ?? "",
  searchConcurrency: intEnv("SEARCH_CONCURRENCY", 4),
  searchTimeoutMs: intEnv("SEARCH_TIMEOUT_MS", 5000),
  toolDeadlineMs: intEnv("TOOL_DEADLINE_MS", 25_000),
  // Search answers are kept on disk. The first provider's answers last a day; a fallback provider's
  // answers (less complete, no prices) only an hour. A TTL of 0 turns that kind of caching off.
  searchCacheTtlMs: intEnv("SEARCH_CACHE_TTL_MS", 86_400_000),
  searchFallbackCacheTtlMs: intEnv("SEARCH_FALLBACK_CACHE_TTL_MS", 3_600_000),
  searchCacheFile: process.env.SEARCH_CACHE_FILE || join(PKG_ROOT, ".cache", "search.json"),
  // A stay with no listed price and no stated star class gets one Serper web search (1 credit) to find
  // its class. Set HOTEL_CLASS_LOOKUP=false to skip it and use the unclassified rate.
  hotelClassLookup: boolEnv("HOTEL_CLASS_LOOKUP", true),
  // Reference data you edit, kept outside the code: typical transport fares and hotel rates by rating.
  routeFaresFile: process.env.ROUTE_FARES_FILE || join(ROOT, "data", "route_fares.json"),
  hotelRatesFile: process.env.HOTEL_RATES_FILE || join(ROOT, "data", "hotel_rate_bands.json"),
  usdToInr: floatEnv("USD_TO_INR", 83.0),
  badWeatherRainPct: intEnv("BAD_WEATHER_RAIN_PCT", 60),
  // A day whose stay-to-first-stop or last-stop-to-stay distance passes this gets a note on its card — surfaced
  // for the user to act on, never a reason for code to change the accommodation or the day's places itself.
  farFromStayKm: intEnv("FAR_FROM_STAY_KM", 25),

  // Booking confirmation emails. Off (no prompt) unless both the sender address and the password are set.
  mailUser: process.env.MAIL_USER ?? "",
  mailPassword: (process.env.APP_PASSWORD ?? "").replace(/\s+/g, ""), // Google shows app passwords in groups
  mailHost: process.env.MAIL_HOST || "smtp.gmail.com",
  mailPort: intEnv("MAIL_PORT", 465),
  mailFrom: process.env.MAIL_FROM || process.env.MAIL_USER || "",

  budgetRetryLimit: intEnv("BUDGET_RETRY_LIMIT", 2),
  subagentMaxClarifications: intEnv("SUBAGENT_MAX_CLARIFICATIONS", 3),
  subagentWaitTimeoutMs: intEnv("SUBAGENT_WAIT_TIMEOUT_MS", 300_000),
  timing: boolEnv("TRIP_TIMING", false),
});
