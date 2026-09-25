import { startTimer } from "../timing.ts";

export interface RequestOptions {
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  json?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

// Why a request produced no body. "quota": the account is out of searches or credits.
// "rate_limited": too many calls right now. "unauthorized": the key was refused (401/403).
// "rejected": any other 4xx, which would fail the same way on a retry.
export type HttpFailure = "quota" | "rate_limited" | "unauthorized" | "timeout" | "network" | "server" | "rejected";

export interface DetailedResponse {
  body: any;
  failure: HttpFailure | null;
}

// Wording seen on real "out of quota" errors; checked first because providers reuse 429/403/400 for it.
const QUOTA_TEXT = /out of (?:searches|credits)|not enough credits|insufficient credits|no credits|quota/i;

function classify(status: number, text: string): HttpFailure {
  if (QUOTA_TEXT.test(text)) return "quota";
  if (status === 429) return "rate_limited";
  if (status === 401 || status === 403) return "unauthorized";
  return status >= 500 ? "server" : "rejected";
}

const isRetryable = (failure: HttpFailure) =>
  failure === "rate_limited" || failure === "server" || failure === "timeout" || failure === "network";

// Up to two attempts on network errors, timeouts, rate limits and 5xx; any other failure returns at once.
// A down upstream API must not crash the MCP server.
export async function requestJsonDetailed(
  method: string,
  url: string,
  { headers, params, json, timeoutMs = 8000, signal }: RequestOptions = {},
): Promise<DetailedResponse> {
  const target = new URL(url);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v != null) target.searchParams.set(k, String(v));
  }
  const done = startTimer(`http ${method} ${target.host}${target.pathname}`);

  let failure: HttpFailure = "timeout"; // stays "timeout" when the caller's deadline has already passed
  for (let attempt = 0; attempt < 2 && !signal?.aborted; attempt++) {
    try {
      const timeout = AbortSignal.timeout(timeoutMs);
      const resp = await fetch(target, {
        method,
        headers: json === undefined ? headers : { "content-type": "application/json", ...headers },
        body: json === undefined ? undefined : JSON.stringify(json),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (resp.ok) {
        const body = await resp.json();
        done(String(resp.status));
        return { body, failure: null };
      }
      failure = classify(resp.status, await resp.text());
      if (!isRetryable(failure)) {
        done(String(resp.status));
        return { body: null, failure };
      }
    } catch (err) {
      failure = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError") ? "timeout" : "network";
    }
    if (attempt === 0 && !signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 400));
  }
  done("failed");
  return { body: null, failure };
}

// For callers (weather, geocoding) that only need the body, or null when there is none.
export async function requestJson(method: string, url: string, options: RequestOptions = {}): Promise<any> {
  return (await requestJsonDetailed(method, url, options)).body;
}
