import { settings } from "../../config.ts";
import { type Dict, fmtFixed, get, isDict, pyOr, pyRound, pyStr, truthy } from "../util.ts";

// Every price in the planner is INR (domestic-India trips, INR budget cap).
const PRICE_LEVEL_COST: Record<string, number> = {
  "$": 150, "$$": 450, "$$$": 1200, "$$$$": 2500,
  inexpensive: 150, moderate: 450, expensive: 1200, "very expensive": 2500,
};

const PRICE_KEYS = ["price", "priceLevel", "price_level", "price_range", "priceRange"];

function amounts(s: unknown): number[] {
  return (pyStr(s).match(/\d[\d,]*/g) ?? []).map((x) => Number(x.replaceAll(",", "")));
}

// A dollar amount ("$31", "US$23-31"), not a Google price band ("$$").
function isUsd(s: string): boolean {
  return /(?:US\$|USD|\$)\s?\d/.test(s);
}

const FOR_TWO = /\bfor\s*(?:two|2)\b|\bper\s*couple\b/i;
const FOR_TWO_ALL = new RegExp(FOR_TWO.source, "gi");

function isForTwo(s: string): boolean {
  return FOR_TWO.test(s);
}

// The "for two" clause is stripped first so its digit isn't read as an amount.
export function amountsInr(s: string): number[] {
  const body = s.replace(FOR_TWO_ALL, "");
  const nums = amounts(body);
  return nums.length && isUsd(body) ? nums.map((n) => pyRound(n * settings.usdToInr, 2)) : nums;
}

export function costFromPriceLevel(level: unknown, fallback: number): number {
  if (!truthy(level)) return fallback;
  const s = pyStr(level).trim();
  const key = s.toLowerCase();
  if (Object.hasOwn(PRICE_LEVEL_COST, key)) return PRICE_LEVEL_COST[key];
  const nums = amountsInr(s);
  if (nums.length) {
    let cost = nums.reduce((a, b) => a + b, 0) / nums.length;
    if (isForTwo(s)) cost /= 2;
    return pyRound(cost, 2);
  }
  const dollars = s.length - s.replace(/^\$+/, "").length;
  if (dollars) return PRICE_LEVEL_COST["$".repeat(Math.min(dollars, 4))] ?? fallback;
  return fallback;
}

export function normPriceLevel(v: unknown): string | null {
  if (!truthy(v)) return null;
  const s = pyStr(v).replace(/\s+/g, " ").trim();
  if (/^\$+$/.test(s) || Object.hasOwn(PRICE_LEVEL_COST, s.toLowerCase())) return s;
  const nums = amountsInr(s);
  if (!nums.length) return null;
  return "₹" + nums.map((n) => fmtFixed(n, 0)).join("–") + (isForTwo(s) ? " for two" : "");
}

export type PriceAndUrl = [string | null, string | null];

function extractOffer(o: unknown): PriceAndUrl {
  if (typeof o === "string") return [o, null];
  if (!isDict(o)) return [null, null];
  const price = pyOr(o.price, o.rate, get(pyOr(o.rate_per_night, {}), "lowest"));
  const link = pyOr(o.link, o.url, o.booking_url, o.booking_link);
  return [truthy(price) ? pyStr(price) : null, truthy(link) ? pyStr(link) : null];
}

function cheapestOffer(offers: unknown): PriceAndUrl {
  if (!truthy(offers)) return [null, null];
  const items: unknown[] = [];
  if (Array.isArray(offers)) {
    items.push(...offers);
  } else if (isDict(offers)) {
    // {"Agoda": {"price": ..., "link": ...}} or {"Agoda": "$10"}
    for (const [source, v] of Object.entries(offers)) {
      if (isDict(v)) items.push(v);
      else if (typeof v === "string") items.push({ source, price: v });
    }
  }

  const candidates: [number, string, string | null][] = [];
  for (const item of items) {
    const [price, link] = extractOffer(item);
    if (!price) continue;
    const inr = amountsInr(price);
    const nums = inr.length ? inr : amounts(price);
    if (nums.length) candidates.push([nums[0], price, link]);
  }
  if (!candidates.length) return [null, null];
  candidates.sort((a, b) => a[0] - b[0]);
  return [candidates[0][1], candidates[0][2]];
}

// Price band first, then the cheapest OTA offer, then google_hotels `prices`, then any price text.
export function extractPriceAndUrl(p: Dict): PriceAndUrl {
  for (const key of PRICE_KEYS) {
    if (truthy(p[key]) && /^\$+$/.test(pyStr(p[key]).trim())) return [pyStr(p[key]).trim(), null];
  }
  for (const holder of [p, pyOr(p.knowledge_graph, {})]) {
    if (!isDict(holder)) continue;
    const pricing = pyOr(holder.pricing, {});
    if (isDict(pricing)) {
      const [price, url] = cheapestOffer(pricing.offers);
      if (price) return [price, url];
    }
  }
  const prices = pyOr(p.prices, []);
  if (Array.isArray(prices)) {
    const [price, url] = cheapestOffer(prices);
    if (price) return [price, url];
  }
  for (const key of PRICE_KEYS) {
    if (truthy(p[key])) return [pyStr(p[key]), null];
  }
  return [null, null];
}
