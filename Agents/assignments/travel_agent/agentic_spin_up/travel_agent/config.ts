import { dirname, join } from "node:path";
import dotenv from "dotenv";

export const ROOT = import.meta.dirname;
export const PKG_ROOT = dirname(ROOT);
export const TRAVEL = dirname(PKG_ROOT);

// The package's own .env wins; ../langgraph2/.env only fills gaps.
dotenv.config({
  path: [join(PKG_ROOT, ".env"), join(TRAVEL, "langgraph2", ".env")],
  quiet: true,
});

function floatEnv(key: string, fallback: number): number {
  const raw = (process.env[key] ?? "").trim();
  const value = Number(raw);
  return raw === "" || Number.isNaN(value) ? fallback : value;
}

function intEnv(key: string, fallback: number): number {
  const raw = (process.env[key] ?? "").trim();
  return /^[+-]?\d+$/.test(raw) ? Number.parseInt(raw, 10) : fallback;
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

  specDir: process.env.SPEC_DIR || join(ROOT, "agent_specs"),
  mcpServerCmd: process.env.MCP_SERVER_CMD ?? "",
  mcpMaxConcurrency: intEnv("MCP_MAX_CONCURRENCY", 5),

  mapsProvider: process.env.MAPS_PROVIDER ?? "serpapi",
  serpapiApiKey: process.env.SERP_API_KEY ?? "",
  serpapiConcurrency: intEnv("SERPAPI_CONCURRENCY", 4),
  searchTimeoutMs: intEnv("SEARCH_TIMEOUT_MS", 5000),
  toolDeadlineMs: intEnv("TOOL_DEADLINE_MS", 25_000),
  cacheTtlMs: intEnv("CACHE_TTL_MS", 600_000),
  usdToInr: floatEnv("USD_TO_INR", 83.0),
  badWeatherRainPct: intEnv("BAD_WEATHER_RAIN_PCT", 60),

  budgetRetryLimit: intEnv("BUDGET_RETRY_LIMIT", 2),
  subagentMaxClarifications: intEnv("SUBAGENT_MAX_CLARIFICATIONS", 3),
  subagentWaitTimeoutMs: intEnv("SUBAGENT_WAIT_TIMEOUT_MS", 300_000),
  timing: boolEnv("TRIP_TIMING", false),
});
