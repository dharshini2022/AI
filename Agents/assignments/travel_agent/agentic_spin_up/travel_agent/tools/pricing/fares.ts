import { z } from "zod";
import { settings } from "../../config.ts";
import { readJsonFile } from "../util.ts";

export type FareMode = "standard_bus" | "ac_bus" | "premium_bus" | "train" | "flight";

// One person, one way, in INR. `estimated` marks a fare you are unsure of.
const Fare = z.object({
  price: z.number().positive(),
  hours: z.number().positive().optional(),
  estimated: z.boolean().default(false),
});
const Route = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  standard_bus: Fare.optional(),
  ac_bus: Fare.optional(),
  premium_bus: Fare.optional(),
  train: Fare.optional(),
  flight: Fare.optional(),
});
const RouteFares = z.object({
  aliases: z.record(z.string(), z.string()).default({}),
  no_railhead: z.array(z.string()).default([]),
  routes: z.array(Route).default([]),
});

export type RouteFare = z.infer<typeof Fare>;
type Table = { aliases: Map<string, string>; noRailhead: Set<string>; routes: Map<string, z.infer<typeof Route>> };

let loaded: { file: string; table: Table } | null = null;

const clean = (city: string) => city.trim().toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, "").replace(/\s+/g, " ");

function table(): Table {
  if (loaded?.file === settings.routeFaresFile) return loaded.table;
  const data = readJsonFile(settings.routeFaresFile, RouteFares);
  const aliases = new Map(Object.entries(data.aliases).map(([from, to]) => [clean(from), clean(to)]));
  const name = (city: string) => aliases.get(clean(city)) ?? clean(city);
  const routes = new Map(data.routes.map((route) => [`${name(route.from)}|${name(route.to)}`, route]));
  loaded = { file: settings.routeFaresFile, table: { aliases, noRailhead: new Set(data.no_railhead.map(name)), routes } };
  return loaded.table;
}

const canonical = (city: string) => table().aliases.get(clean(city)) ?? clean(city);

// The typical fare for one mode on a route (either direction), or null when the table has none.
export function tableFare(source: string, destination: string, mode: FareMode): RouteFare | null {
  const [from, to] = [canonical(source), canonical(destination)];
  const route = table().routes.get(`${from}|${to}`) ?? table().routes.get(`${to}|${from}`);
  return route?.[mode] ?? null;
}

export const hasNoRailhead = (city: string) => table().noRailhead.has(canonical(city));
