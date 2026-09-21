import { type Dict, fmtFixed, get, isDict, numStr, pyOr, pyRound, pyStr, pyTitle, truthy } from "./util.ts";

type Point = [number, number];

export function haversineKm(a: Point, b: Point): number {
  const rad = Math.PI / 180;
  const [lat1, lon1, lat2, lon2] = [a[0] * rad, a[1] * rad, b[0] * rad, b[1] * rad];
  const h = Math.sin((lat2 - lat1) / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

function toFloat(v: unknown): number | null {
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return Number(v);
  if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) return Number(v);
  return null;
}

function xy(v: unknown): Point | null {
  if (!isDict(v) || v.lat == null || v.lon == null) return null;
  const lat = toFloat(v.lat);
  const lon = toFloat(v.lon);
  return lat === null || lon === null ? null : [lat, lon];
}

function byTime(a: Dict, b: Dict): number {
  return a.time < b.time ? -1 : a.time > b.time ? 1 : 0;
}

const ACTIVITY_SLOTS: Record<number, string[]> = {
  1: ["11:00"],
  2: ["10:00", "15:30"],
  3: ["09:30", "12:00", "16:00"],
  4: ["09:00", "11:00", "15:00", "17:00"],
};
const MEAL_TIMES = { Breakfast: "08:30", Lunch: "13:00", Dinner: "20:00" } as const;

function slots(n: number): string[] {
  return ACTIVITY_SLOTS[n] ?? Array.from({ length: n }, (_, i) => `${String(9 + i).padStart(2, "0")}:00`);
}

function dedupePlaces(items: Dict[]): Dict[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = pyStr(item.name ?? "").toLowerCase().trim();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// Nearest-neighbour tour from the stay, split into day buckets; rainy days get indoor stops first.
function clusterPlaces(places: Dict[], accommodation: Dict, numDays: number, weatherDays: Dict[]): Dict[] {
  numDays = Math.max(1, numDays);
  places = dedupePlaces(places);
  if (!places.length) {
    return Array.from({ length: numDays }, (_, i) => ({ day: i + 1, places: [], note: null }));
  }

  const stayCoord = xy(accommodation);
  const rainyDays = weatherDays
    .slice(0, numDays)
    .flatMap((w, i) => ((get(w, "rain_pct") || 0) >= 60 ? [i] : []));

  const coded = places.filter((p) => xy(p));
  const uncoded = places.filter((p) => !xy(p));

  let ordered: Dict[];
  if (coded.length) {
    let cur = stayCoord ?? xy(coded[0])!;
    const remaining = [...coded];
    ordered = [];
    while (remaining.length) {
      let best = 0;
      let bestKm = haversineKm(cur, xy(remaining[0])!);
      for (let k = 1; k < remaining.length; k++) {
        const km = haversineKm(cur, xy(remaining[k])!);
        if (km < bestKm) [best, bestKm] = [k, km];
      }
      const [next] = remaining.splice(best, 1);
      ordered.push(next);
      cur = xy(next)!;
    }
    ordered.push(...uncoded);
  } else {
    ordered = [...places];
  }

  const perDay = Math.max(2, Math.min(4, Math.max(1, pyRound(ordered.length / numDays))));
  const daysPlaces: Dict[][] = Array.from({ length: numDays }, () => []);

  const indoor = ordered.filter((p) => truthy(p.indoor));
  const outdoor = ordered.filter((p) => !truthy(p.indoor));

  if (rainyDays.length && indoor.length) {
    for (const d of rainyDays) {
      while (indoor.length && daysPlaces[d].length < perDay) daysPlaces[d].push(indoor.shift()!);
    }
  }

  for (const p of [...indoor, ...outdoor]) {
    const target = daysPlaces.reduce((min, day) => (day.length < min.length ? day : min));
    if (target.length < perDay) target.push(p);
  }

  return daysPlaces.map((dayList, i) => {
    dayList.forEach((p, j) => {
      const p1 = xy(p);
      const p2 = j + 1 < dayList.length ? xy(dayList[j + 1]) : null;
      p.dist_to_next_km = p1 && p2 ? pyRound(haversineKm(p1, p2), 1) : null;
    });
    const note = dayNote(dayList, i < weatherDays.length ? weatherDays[i] : null);
    return { day: i + 1, places: dayList, note };
  });
}

function dayNote(places: Dict[], weather: Dict | null): string {
  if (!places.length) return "Free exploration day.";
  const names = places.map((p) => get(p, "name", ""));
  const typesBlob = places
    .map((p) => `${p.category ?? ""} ${(get(p, "types", []) as string[]).join(" ")}`)
    .join(" ")
    .toLowerCase();
  const has = (...words: string[]) => words.some((w) => typesBlob.includes(w));

  let theme = "city highlights";
  if (has("temple", "church", "spiritual")) theme = "heritage and cultural landmarks";
  else if (has("beach", "coast")) theme = "coastal views and beachside sights";
  else if (has("park", "garden", "falls", "nature")) theme = "scenic nature and outdoor viewpoints";
  else if (has("museum", "gallery")) theme = "museums, art and indoor discoveries";

  let lead = `Explore ${theme} including ${pyStr(names[0])}`;
  if (names.length > 1) lead += ` and ${pyStr(names.at(-1))}`;
  lead += ".";

  if (truthy(weather) && (get(weather, "rain_pct") || 0) >= 50) {
    lead += ` Carry an umbrella as ${pyStr(get(weather, "condition", "rain")).toLowerCase()} is expected.`;
  }
  return lead;
}

function buildDayCards(layoutDays: Dict[], forecast: Dict, restaurants: unknown, accommodation: Dict): Dict[] {
  const fdays: Dict[] = get(forecast, "days", []);
  const stay = xy(accommodation);
  const usedTripRestaurants = new Set<string>();
  const usedTripPlaces = new Set<string>();

  return layoutDays.map((d, i) => {
    const places: Dict[] = get(d, "places", []);
    const times = slots(places.length);

    places.forEach((p) => {
      const key = pyStr(p.name ?? "").toLowerCase().trim();
      if (key) usedTripPlaces.add(key);
    });

    const activities = places.map((p, j) => ({
      time: times[j],
      name: p.name,
      category: get(p, "category", "attraction"),
      hours: get(p, "hours"),
      rating: get(p, "rating"),
      address: get(p, "address"),
      lat: get(p, "lat"),
      lon: get(p, "lon"),
      maps_url: get(p, "maps_url"),
      dist_to_next_km: get(p, "dist_to_next_km"),
      price_level: get(p, "price_level"),
      est_cost: get(p, "est_cost", 0),
    }));

    const meals: Dict[] = [];
    const usedToday = new Set<string>();
    for (const meal of ["Breakfast", "Lunch", "Dinner"] as const) {
      const options: Dict[] = isDict(restaurants) ? get(restaurants, meal, []) : [];
      if (!truthy(options)) continue;
      // Prefer an option not used anywhere in the trip or as an attraction
      let r = options.find((opt) => {
        const key = pyStr(opt.name ?? "").toLowerCase().trim();
        return !usedTripRestaurants.has(key) && !usedTripPlaces.has(key);
      });
      // Fallback: an option not used in the trip so far
      if (!r) {
        r = options.find((opt) => !usedTripRestaurants.has(pyStr(opt.name ?? "").toLowerCase().trim()));
      }
      // Fallback: an option not used today
      if (!r) {
        for (let k = 0; k < options.length; k++) {
          const candidate = options[(i + k) % options.length];
          if (!usedToday.has(candidate.name)) {
            r = candidate;
            break;
          }
        }
      }
      r = r ?? options[i % options.length];
      const normName = pyStr(r.name ?? "").toLowerCase().trim();
      usedToday.add(r.name);
      if (normName) usedTripRestaurants.add(normName);
      meals.push({
        meal,
        time: MEAL_TIMES[meal],
        name: r.name,
        hours: get(r, "hours"),
        rating: get(r, "rating"),
        address: get(r, "address"),
        maps_url: get(r, "maps_url"),
        lat: get(r, "lat"),
        lon: get(r, "lon"),
        price_level: get(r, "price_level"),
        est_cost: get(r, "est_cost", 0),
      });
    }

    const timeline = [...activities, ...meals].sort(byTime);
    const located = timeline.map(xy).filter((p): p is Point => p !== null);
    let fromStay: number | null = null;
    let toStay: number | null = null;
    let dayKm: number | null = null;
    if (stay && located.length) {
      fromStay = pyRound(haversineKm(stay, located[0]), 1);
      toStay = pyRound(haversineKm(located.at(-1)!, stay), 1);
      let hops = 0;
      for (let k = 0; k + 1 < located.length; k++) hops += haversineKm(located[k], located[k + 1]);
      dayKm = pyRound(fromStay + hops + toStay, 1);
    }

    const w = i < fdays.length ? fdays[i] : {};
    return {
      day: i + 1,
      date: pyOr(get(w, "date"), get(d, "date"), `Day ${i + 1}`),
      note: get(d, "note"),
      weather: {
        condition: get(w, "condition", "unknown"),
        temp: get(w, "temp"),
        rain_pct: get(w, "rain_pct", 0),
      },
      activities,
      meals,
      from_stay_km: fromStay,
      to_stay_km: toStay,
      day_km: dayKm,
    };
  });
}

export function buildItinerary(requirements: Dict, flightsResult: Dict, placesResult: Dict): Dict {
  const numDays = pyOr(get(requirements, "num_days"), 2);
  const weather = pyOr(get(placesResult, "weather"), {});
  const accommodation = pyOr(get(placesResult, "accommodation"), {});
  const places = pyOr(get(placesResult, "places"), []);
  const restaurants = pyOr(get(placesResult, "restaurants"), {});

  const layoutDays = clusterPlaces(places, accommodation, numDays, get(weather, "days", []));
  const cards = buildDayCards(layoutDays, weather, restaurants, accommodation);

  const dayTotals = cards.map((c) => c.day_km).filter((km) => km != null);
  const totalTravelKm = dayTotals.length ? pyRound(dayTotals.reduce((a, b) => a + b, 0), 1) : null;

  return {
    route: `${pyStr(get(requirements, "source"))} → ${pyStr(get(requirements, "destination"))}`,
    transport: get(flightsResult, "selected", {}),
    accommodation,
    cards,
    total_travel_km: totalTravelKm,
    weather_source: get(weather, "source"),
    weather_unavailable: get(weather, "unavailable", false),
    indoor_mode: get(placesResult, "indoor_mode", false),
    weather_declined: get(placesResult, "weather_declined", false),
  };
}

function priceTag(priceLevel: unknown, estCost: unknown): string | null {
  if (truthy(priceLevel)) return pyStr(priceLevel);
  if (truthy(estCost)) return `~₹${fmtFixed(Number(estCost), 0)}/pp`;
  return null;
}

const PAD = "│         ";

function venueBlock(
  time: string,
  title: string,
  { rating, price, hours, url, dist }: { rating: unknown; price: unknown; hours: unknown; url: unknown; dist: unknown },
): string[] {
  const lines = [`│  ${pyStr(time).padStart(5)}  ${title}`];
  if (truthy(rating)) lines.push(`${PAD}Rating : ★${pyStr(rating)}`);
  if (truthy(price)) lines.push(`${PAD}Price  : ${pyStr(price)}`);
  if (truthy(hours)) lines.push(`${PAD}Timings: ${pyStr(hours)}`);
  if (truthy(url)) lines.push(`${PAD}Maps   : ${pyStr(url)}`);
  if (dist != null) lines.push(`${PAD}→ ${numStr(dist)} km to next stop`);
  return lines;
}

export interface BudgetRecheck {
  attempts: number;
  from: number;
  to: number;
}

export function renderCards(itinerary: Dict, budget: Dict | null = null, recheck: BudgetRecheck | null = null): string {
  const out: string[] = [`  ${pyStr(get(itinerary, "route", ""))}`];
  const t = get(itinerary, "transport", {});
  if (truthy(t)) {
    const title = truthy(t.option) ? t.option : `${pyTitle(pyStr(get(t, "mode", "")))} via ${pyStr(get(t, "provider", ""))}`;
    const dur = truthy(t.travel_time) ? t.travel_time : `${numStr(get(t, "duration_hours", "?"))}h`;
    const fare = truthy(t.approx_fare) ? t.approx_fare : `₹${fmtFixed(get(t, "price", 0), 0)}`;
    const note = truthy(t.notes) ? ` (${pyStr(t.notes)})` : "";
    out.push(`  Transport : ${pyStr(title)} — ${pyStr(dur)} — ${pyStr(fare)}${note}`);
    const links = pyOr(t.links, []);
    if (truthy(links)) {
      const linkStrs = (links as unknown[]).map((l) => (isDict(l) ? `[${pyStr(l.title)}](${pyStr(l.url)})` : pyStr(l)));
      out.push(`              ↳ Booking : ${linkStrs.join(" · ")}`);
    } else if (truthy(t.booking_url)) {
      out.push(`              ↳ Booking : ${pyStr(t.booking_url)}`);
    }
  }

  const a = get(itinerary, "accommodation", {});
  const src = get(itinerary, "weather_source");
  if (truthy(itinerary.weather_unavailable)) {
    out.push("  Weather   : Weather Tool: Open - Metreo api server down");
  } else if (truthy(src) && src !== "open-meteo") {
    out.push(`  Weather   : ${pyStr(src)}`);
  }
  if (itinerary.total_travel_km != null) {
    out.push(`  Legwork   : ~${numStr(itinerary.total_travel_km)} km of local travel`);
  }
  out.push("");

  const width = 62;
  for (const c of get(itinerary, "cards", []) as Dict[]) {
    const w = c.weather;
    const wtxt = `${pyStr(w.condition)}${truthy(w.temp) ? `, ${pyStr(w.temp)}` : ""}, rain ${pyStr(w.rain_pct)}%`;
    out.push("┌ " + `Day ${pyStr(c.day)} · ${pyStr(c.date)} `.padEnd(width, "─"));
    if (truthy(c.note)) out.push(`│ ${pyStr(c.note)}`);
    out.push(`│ Weather : ${wtxt}`);
    let stay = pyStr(get(a, "name", "—"));
    if (truthy(a.price_per_night)) stay += `  ~₹${fmtFixed(a.price_per_night, 0)}/night`;
    out.push(`│ Stay    : ${stay}`);
    if (truthy(a.maps_url)) out.push(`│         ↳ ${pyStr(a.maps_url)}`);
    out.push("├ Plan");
    if (c.from_stay_km != null) {
      out.push(`${PAD}⌂ stay → first stop · ${numStr(c.from_stay_km)} km`);
      out.push("│");
    }

    const timeline = [
      ...(c.activities as Dict[]).map((item) => ({ kind: "act", time: item.time, item })),
      ...(c.meals as Dict[]).map((item) => ({ kind: "meal", time: item.time, item })),
    ].sort(byTime);
    for (const { kind, item } of timeline) {
      const title = kind === "act" ? pyStr(item.name) : `${pyStr(item.meal)} · ${pyStr(item.name)}`;
      out.push(
        ...venueBlock(item.time, title, {
          rating: get(item, "rating"),
          price: priceTag(get(item, "price_level"), get(item, "est_cost")),
          hours: get(item, "hours"),
          url: get(item, "maps_url"),
          dist: kind === "act" ? get(item, "dist_to_next_km") : null,
        }),
      );
      out.push("│");
    }
    if (c.to_stay_km != null) out.push(`${PAD}last stop → ⌂ stay · ${numStr(c.to_stay_km)} km`);
    if (c.day_km != null) out.push(`${PAD}day total · ${numStr(c.day_km)} km`);
    out.push("└" + "─".repeat(width + 1));
    out.push("");
  }

  if (budget && truthy(budget)) {
    const cap = truthy(budget.cap) ? ` / cap ₹${fmtFixed(budget.cap, 0)}` : "";
    const verdict = truthy(budget.ok) ? "within budget" : `OVER by ₹${fmtFixed(budget.overage, 0)}`;
    const bd = budget.breakdown;
    out.push(`  Budget    : ₹${fmtFixed(budget.total, 0)}${cap}  (${verdict})`);
    out.push(
      `              transport ₹${fmtFixed(bd.transport, 0)} · lodging ₹${fmtFixed(bd.lodging, 0)} · ` +
        `food ₹${fmtFixed(bd.food, 0)} · activities ₹${fmtFixed(bd.activities, 0)}`,
    );
    if (recheck?.attempts) {
      out.push(`              Budget re-checked ${recheck.attempts}× (₹${fmtFixed(recheck.from, 0)} → ₹${fmtFixed(recheck.to, 0)})`);
    }
  }
  if (truthy(itinerary.weather_declined)) {
    out.push("  ⚠ Indoor switch declined despite a poor forecast — outdoor plans may be disrupted.");
  }
  return out.join("\n");
}
