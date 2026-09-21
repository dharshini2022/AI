import { startTimer } from "../timing.ts";

export interface RequestOptions {
  headers?: Record<string, string>;
  params?: Record<string, unknown>;
  json?: unknown;
  timeoutMs?: number;
  signal?: AbortSignal;
}

const isRetryable = (status: number) => status === 429 || status >= 500;

// Up to two attempts on network errors, timeouts, 429 and 5xx; any other failure returns null at once.
// A down upstream API must not crash the MCP server.
export async function requestJson(
  method: string,
  url: string,
  { headers, params, json, timeoutMs = 8000, signal }: RequestOptions = {},
): Promise<any> {
  const target = new URL(url);
  for (const [k, v] of Object.entries(params ?? {})) {
    if (v != null) target.searchParams.set(k, String(v));
  }
  const done = startTimer(`http ${method} ${target.host}${target.pathname}`);

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
        return body;
      }
      if (!isRetryable(resp.status)) {
        done(String(resp.status));
        return null;
      }
    } catch {
      // network error or timeout: retry below unless the caller's deadline has passed
    }
    if (attempt === 0 && !signal?.aborted) await new Promise((resolve) => setTimeout(resolve, 400 + Math.random() * 400));
  }
  done("failed");
  return null;
}
