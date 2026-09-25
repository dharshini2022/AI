import { readFileSync } from "node:fs";

const R = JSON.parse(readFileSync(new URL("./http_responses.json", import.meta.url), "utf8"));

// Replays http_responses.json; the same routing produced parity.json on the Python side.
export async function fakeRequestJson(_method: string, url: string, opts: { params?: Record<string, any> } = {}): Promise<any> {
  const params = opts.params ?? {};
  if (url.includes("geocoding-api")) {
    const hit = R.geo[String(params.name).trim().toLowerCase()];
    return { results: hit ? [{ latitude: hit[0], longitude: hit[1] }] : [] };
  }
  if (url.includes("archive-api")) return params.latitude === R.geo.goa[0] ? structuredClone(R.archive) : null;
  if (url.includes("api.open-meteo.com")) return params.latitude === R.geo.munnar[0] ? structuredClone(R.forecast) : null;

  const q = String(params.q ?? "").toLowerCase();
  if (params.engine === "google_hotels") return q.includes("munnar") ? structuredClone(R.hotels) : { properties: [] };
  if (params.engine === "google_maps") {
    for (const [needle, key] of R.maps_rules) if (q.includes(needle)) return structuredClone(R[key]);
  }
  return null;
}

// Same routing as fakeRequestJson; an unrouted request counts as a rejected one.
export async function fakeRequestJsonDetailed(method: string, url: string, opts: { params?: Record<string, any> } = {}) {
  const body = await fakeRequestJson(method, url, opts);
  return { body, failure: body === null ? ("rejected" as const) : null };
}
