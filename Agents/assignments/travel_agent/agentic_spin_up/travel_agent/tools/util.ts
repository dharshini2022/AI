export type Dict = Record<string, any>;

export function isDict(v: unknown): v is Dict {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function get(d: unknown, key: string, fallback: any = null): any {
  return isDict(d) && Object.hasOwn(d, key) ? d[key] : fallback;
}

export function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (isDict(v)) return Object.keys(v).length > 0;
  return Boolean(v);
}

// Python `a or b or c`: the first truthy operand, else the last one.
export function pyOr(...vals: unknown[]): any {
  for (const v of vals) if (truthy(v)) return v;
  return vals.at(-1) ?? null;
}

export function pyStr(v: unknown): string {
  if (v === null || v === undefined) return "None";
  if (typeof v === "boolean") return v ? "True" : "False";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

// Python prints float values with a trailing ".0" (12.0); JS drops it.
export function numStr(v: unknown): string {
  return typeof v === "number" && Number.isInteger(v) ? `${v}.0` : pyStr(v);
}

// Python round(): rounds the exact binary value, ties to even (Math.round ties up).
export function pyRound(x: number, ndigits = 0): number {
  if (!Number.isFinite(x) || Math.abs(x) >= 1e21) return x;
  const [intPart, frac] = Math.abs(x).toFixed(100).split(".");
  const scaled = BigInt(intPart + frac.slice(0, ndigits));
  const rest = frac.slice(ndigits);
  const up = rest[0] > "5" || (rest[0] === "5" && (/[1-9]/.test(rest.slice(1)) || scaled % 2n === 1n));
  const r = Number(up ? scaled + 1n : scaled) / 10 ** ndigits;
  return x < 0 ? -r : r;
}

export function fmtFixed(x: number, ndigits: number): string {
  return pyRound(Number(x), ndigits).toFixed(ndigits);
}

export function pyTitle(s: string): string {
  return s.replace(/\p{L}+/gu, (w) => w[0].toUpperCase() + w.slice(1).toLowerCase());
}

// urllib.parse.quote: keeps "/" and escapes !'()* unlike encodeURIComponent.
export function pyQuote(s: string): string {
  return encodeURIComponent(s)
    .replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)
    .replaceAll("%2F", "/");
}

export function parseIsoDate(s: unknown): Date | null {
  const m = typeof s === "string" ? /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s) : null;
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]) - 1, Number(m[3])];
  const dt = new Date(0);
  dt.setUTCFullYear(y, mo, d);
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo && dt.getUTCDate() === d ? dt : null;
}

export function isoDate(dt: Date): string {
  return [
    String(dt.getUTCFullYear()).padStart(4, "0"),
    String(dt.getUTCMonth() + 1).padStart(2, "0"),
    String(dt.getUTCDate()).padStart(2, "0"),
  ].join("-");
}

export function addDays(iso: unknown, days: number): string | null {
  const dt = parseIsoDate(iso);
  if (!dt) return null;
  dt.setUTCDate(dt.getUTCDate() + days);
  return isoDate(dt);
}

export function todayIso(): string {
  const now = new Date();
  return isoDate(new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate())));
}
