import { settings } from "../config.ts";
import { createLimiter } from "../limiter.ts";
import { cached } from "./cache.ts";
import { requestJson } from "./http.ts";

const SERPAPI_URL = "https://serpapi.com/search";
const limit = createLimiter(settings.serpapiConcurrency);

// All SerpAPI traffic goes through here: bounded concurrency, a shared response cache, and the search timeout.
export function serpapi(params: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
  return cached(`serpapi:${JSON.stringify(params)}`, () =>
    limit(() =>
      requestJson("GET", SERPAPI_URL, {
        params: { ...params, api_key: settings.serpapiApiKey },
        timeoutMs: settings.searchTimeoutMs,
        signal,
      }),
    ),
  );
}
