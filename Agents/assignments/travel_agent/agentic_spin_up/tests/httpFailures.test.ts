import { afterEach, describe, expect, it, vi } from "vitest";
import { requestJson, requestJsonDetailed } from "../travel_agent/tools/http.ts";

const reply = (status: number, body: unknown) => new Response(typeof body === "string" ? body : JSON.stringify(body), { status });

// Each call to fetch gets the next scripted response, or throws it if it is an Error.
function stubFetch(...script: (Response | Error)[]) {
  const fetchMock = vi.fn(async () => {
    const next = script.shift();
    if (next instanceof Error) throw next;
    return next as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const call = () => requestJsonDetailed("GET", "https://example.test/search");

afterEach(() => vi.unstubAllGlobals());

describe("requestJsonDetailed", () => {
  it("returns the body and no failure on success", async () => {
    stubFetch(reply(200, { ok: 1 }));
    expect(await call()).toEqual({ body: { ok: 1 }, failure: null });
  });

  it("treats a 429 that says the account is out of searches as quota, without a retry", async () => {
    const fetchMock = stubFetch(reply(429, { error: "Your account has run out of searches." }));
    expect(await call()).toEqual({ body: null, failure: "quota" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats an out-of-credits message as quota whatever the status", async () => {
    const fetchMock = stubFetch(reply(400, { message: "Not enough credits", statusCode: 400 }));
    expect((await call()).failure).toBe("quota");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats any other 429 as rate_limited and retries once", async () => {
    const fetchMock = stubFetch(reply(429, { error: "Too many requests" }), reply(429, { error: "Too many requests" }));
    expect((await call()).failure).toBe("rate_limited");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("treats a refused key as unauthorized, without a retry (Serper's real 403)", async () => {
    const fetchMock = stubFetch(reply(403, { message: "Unauthorized.", statusCode: 403 }));
    expect((await call()).failure).toBe("unauthorized");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("treats any other 4xx as rejected, without a retry", async () => {
    const fetchMock = stubFetch(reply(400, { error: "Missing query" }));
    expect((await call()).failure).toBe("rejected");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries a 5xx once, then reports server", async () => {
    const fetchMock = stubFetch(reply(503, "down"), reply(503, "down"));
    expect((await call()).failure).toBe("server");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("recovers when the retry succeeds", async () => {
    stubFetch(reply(503, "down"), reply(200, { ok: 2 }));
    expect(await call()).toEqual({ body: { ok: 2 }, failure: null });
  });

  it("reports network for a failed connection", async () => {
    stubFetch(new TypeError("fetch failed"), new TypeError("fetch failed"));
    expect((await call()).failure).toBe("network");
  });

  it("reports timeout when the request times out", async () => {
    stubFetch(new DOMException("The operation timed out", "TimeoutError"), new DOMException("The operation timed out", "TimeoutError"));
    expect((await call()).failure).toBe("timeout");
  });

  it("reports timeout without calling fetch when the caller's deadline has already passed", async () => {
    const fetchMock = stubFetch(reply(200, { ok: 3 }));
    const result = await requestJsonDetailed("GET", "https://example.test/search", { signal: AbortSignal.abort() });
    expect(result).toEqual({ body: null, failure: "timeout" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("requestJson", () => {
  it("still returns the body on success and null on any failure", async () => {
    stubFetch(reply(200, { ok: 4 }));
    expect(await requestJson("GET", "https://example.test/search")).toEqual({ ok: 4 });
    stubFetch(reply(429, { error: "Your account has run out of searches." }));
    expect(await requestJson("GET", "https://example.test/search")).toBeNull();
  });
});
