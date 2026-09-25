import { settings } from "../config.ts";
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

const placeKey = (p: Dict) => pyStr(p.name ?? "").toLowerCase().trim();

// The closest point to `from` among a day's own places, or `fallback` (the stay) when it has none yet —
// so a day that lost every place anchors on the accommodation, exactly like the very first build does.
function nearestAnchor(dayList: Dict[], fallback: Point | null): Point | null {
  const coords = dayList.map(xy).filter((p): p is Point => p !== null);
  return coords.length ? coords[coords.length - 1] : fallback;
}

// Places still present after an edit keep the day they were already on; only the delta (removed slots,
// newly-ranked replacements) gets placed, nearest to whatever's already anchored on that day — its own
// remaining places, or the accommodation for a day that lost all of them. This is what keeps an edit from
// reshuffling days the user never touched, and it's why a replacement naturally lands near its neighbours
// (or near the stay, for a first/last stop) without any hardcoded distance rule.
function clusterByPreviousLayout(
  places: Dict[], accommodation: Dict, numDays: number, perDay: number, previousLayout: Map<string, number>,
): Dict[][] {
  const daysPlaces: Dict[][] = Array.from({ length: numDays }, () => []);
  const fresh: Dict[] = [];
  for (const p of places) {
    const day = previousLayout.get(placeKey(p));
    if (day != null && day < numDays && daysPlaces[day].length < perDay) daysPlaces[day].push(p);
    else fresh.push(p);
  }

  const stayCoord = xy(accommodation);
  const remaining = [...fresh];
  while (remaining.length) {
    const target = daysPlaces.reduce((min, day) => (day.length < min.length ? day : min));
    if (target.length >= perDay) {
      // Every day is at (or over) capacity from kept places alone — the rest have nowhere reasonable to go.
      if (daysPlaces.every((d) => d.length >= perDay)) break;
      continue;
    }
    const anchor = nearestAnchor(target, stayCoord);
    let best = 0;
    let bestKm = anchor && xy(remaining[0]) ? haversineKm(anchor, xy(remaining[0])!) : 0;
    if (anchor) {
      for (let k = 1; k < remaining.length; k++) {
        const p = xy(remaining[k]);
        const km = p ? haversineKm(anchor, p) : Infinity;
        if (km < bestKm) [best, bestKm] = [k, km];
      }
    }
    const [next] = remaining.splice(best, 1);
    target.push(next);
  }
  return daysPlaces;
}

// Nearest-neighbour tour from the stay, split into day buckets; rainy days get indoor stops first.
function clusterPlaces(
  places: Dict[], accommodation: Dict, numDays: number, weatherDays: Dict[],
  previousLayout: Map<string, number> | null = null,
): Dict[] {
  numDays = Math.max(1, numDays);
  places = dedupePlaces(places);
  if (!places.length) {
    return Array.from({ length: numDays }, (_, i) => ({ day: i + 1, places: [], note: null }));
  }

  const stayCoord = xy(accommodation);
  const rainyDays = weatherDays
    .slice(0, numDays)
    .flatMap((w, i) => ((get(w, "rain_pct") || 0) >= 60 ? [i] : []));

  const perDay = Math.max(2, Math.min(4, Math.max(1, pyRound(places.length / numDays))));

  let daysPlaces: Dict[][];
  if (previousLayout) {
    daysPlaces = clusterByPreviousLayout(places, accommodation, numDays, perDay, previousLayout);
  } else {
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

    daysPlaces = Array.from({ length: numDays }, () => []);
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

// The estimate flag travels with a venue so the budget check can total what is a guess.
const estimatedFlag = (venue: Dict): Dict => (venue.estimated === undefined ? {} : { estimated: venue.estimated });

// A fare shown with "~" when it is a guess, so it never reads as a real quote.
export function fareText(transport: Dict): string {
  const fare = truthy(transport.approx_fare) ? pyStr(transport.approx_fare) : `₹${fmtFixed(get(transport, "price", 0), 0)}`;
  return transport.estimated === true ? `~${fare}` : fare;
}

function buildDayCards(layoutDays: Dict[], forecast: Dict, restaurants: unknown, accommodation: Dict): Dict[] {
  const fdays: Dict[] = get(forecast, "days", []);
  const stay = xy(accommodation);
  const usedTripRestaurants = new Set<string>();
  const usedTripPlaces = new Set<string>();

  return layoutDays.map((d, i) => {
    const places: Dict[] = get(d, "places", []);
    const times = slots(places.length);
    // The day's own centroid, so a meal pick can prefer whichever candidate is actually nearby — null
    // when nothing has coordinates, in which case picking stays exactly as it was (first match in tier).
    const dayCoords = places.map(xy).filter((p): p is Point => p !== null);
    const centroid: Point | null = dayCoords.length
      ? [dayCoords.reduce((s, p) => s + p[0], 0) / dayCoords.length, dayCoords.reduce((s, p) => s + p[1], 0) / dayCoords.length]
      : null;
    // Nearest to the day's centroid among a tier's matches; unchanged (first match) when there's no centroid
    // or no candidate has coordinates, so this only ever breaks a tie, never overrides the tier priority.
    const nearest = (matches: Dict[]): Dict | undefined => {
      if (!centroid) return matches[0];
      const withCoords = matches.filter((m) => xy(m));
      if (!withCoords.length) return matches[0];
      return withCoords.reduce((best, m) => (haversineKm(centroid, xy(m)!) < haversineKm(centroid, xy(best)!) ? m : best));
    };

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
      ...estimatedFlag(p),
    }));

    const meals: Dict[] = [];
    const usedToday = new Set<string>();
    for (const meal of ["Breakfast", "Lunch", "Dinner"] as const) {
      const options: Dict[] = isDict(restaurants) ? get(restaurants, meal, []) : [];
      if (!truthy(options)) continue;
      // Prefer an option not used anywhere in the trip or as an attraction — among that tier's matches,
      // the one nearest to today's places wins (see `nearest` above); the priority itself is unchanged.
      let r = nearest(options.filter((opt) => {
        const key = pyStr(opt.name ?? "").toLowerCase().trim();
        return !usedTripRestaurants.has(key) && !usedTripPlaces.has(key);
      }));
      // Fallback: an option not used in the trip so far
      if (!r) {
        r = nearest(options.filter((opt) => !usedTripRestaurants.has(pyStr(opt.name ?? "").toLowerCase().trim())));
      }
      // Fallback: an option not used today
      if (!r) {
        r = nearest(options.filter((opt) => !usedToday.has(opt.name)));
      }
      r = r ?? nearest(options); // `options` is non-empty here (checked above), so `nearest` always returns one
      const picked = r!;
      const normName = pyStr(picked.name ?? "").toLowerCase().trim();
      usedToday.add(picked.name);
      if (normName) usedTripRestaurants.add(normName);
      meals.push({
        meal,
        time: MEAL_TIMES[meal],
        name: picked.name,
        hours: get(picked, "hours"),
        rating: get(picked, "rating"),
        address: get(picked, "address"),
        maps_url: get(picked, "maps_url"),
        lat: get(picked, "lat"),
        lon: get(picked, "lon"),
        price_level: get(picked, "price_level"),
        est_cost: get(picked, "est_cost", 0),
        ...estimatedFlag(picked),
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

    // Surfaced for the user to act on — never a trigger for code to change the accommodation or this day's
    // places itself; see concepts/architecture/itinerary-layout.md.
    const farKm = Math.max(fromStay ?? 0, toStay ?? 0);
    const farNote = (fromStay != null && fromStay > settings.farFromStayKm) || (toStay != null && toStay > settings.farFromStayKm)
      ? ` This day's places are far from your stay (~${numStr(pyRound(farKm, 1))} km) — consider a different day grouping or accommodation.`
      : "";

    const w = i < fdays.length ? fdays[i] : {};
    return {
      day: i + 1,
      date: pyOr(get(w, "date"), get(d, "date"), `Day ${i + 1}`),
      note: farNote ? get(d, "note") + farNote : get(d, "note"),
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

// The day each place was on last time, keyed by name — null when there's no previous itinerary (the first
// build), so clusterPlaces falls back to its original single global tour.
function previousLayoutOf(previousItinerary: Dict | null): Map<string, number> | null {
  if (!previousItinerary) return null;
  const cards: Dict[] = get(previousItinerary, "cards", []);
  const layout = new Map<string, number>();
  cards.forEach((card, day) => {
    for (const a of get(card, "activities", []) as Dict[]) {
      const key = pyStr(a.name ?? "").toLowerCase().trim();
      if (key) layout.set(key, day);
    }
  });
  return layout.size ? layout : null;
}

export function buildItinerary(requirements: Dict, flightsResult: Dict, placesResult: Dict, previousItinerary: Dict | null = null): Dict {
  const numDays = pyOr(get(requirements, "num_days"), 2);
  const weather = pyOr(get(placesResult, "weather"), {});
  const accommodation = pyOr(get(placesResult, "accommodation"), {});
  const places = pyOr(get(placesResult, "places"), []);
  const restaurants = pyOr(get(placesResult, "restaurants"), {});

  const layoutDays = clusterPlaces(places, accommodation, numDays, get(weather, "days", []), previousLayoutOf(previousItinerary));
  const cards = buildDayCards(layoutDays, weather, restaurants, accommodation);

  const dayTotals = cards.map((c) => c.day_km).filter((km) => km != null);
  const totalTravelKm = dayTotals.length ? pyRound(dayTotals.reduce((a, b) => a + b, 0), 1) : null;

  return {
    route: `${pyStr(get(requirements, "source"))} → ${pyStr(get(requirements, "destination"))}`,
    transport: get(flightsResult, "selected", {}),
    ...(truthy(get(flightsResult, "selected_return")) && {
      return_transport: flightsResult.selected_return,
      return_date: get(flightsResult, "return_date"),
    }),
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

// One leg's lines: its title, duration and fare, then its booking links.
function transportLines(label: string, t: Dict, when = ""): string[] {
  const title = truthy(t.option) ? t.option : `${pyTitle(pyStr(get(t, "mode", "")))} via ${pyStr(get(t, "provider", ""))}`;
  const dur = truthy(t.travel_time) ? t.travel_time : `${numStr(get(t, "duration_hours", "?"))}h`;
  const note = truthy(t.notes) ? ` (${pyStr(t.notes)})` : "";
  const lines = [`  ${label} : ${pyStr(title)} — ${pyStr(dur)} — ${fareText(t)}${note}${when}`];
  const links = pyOr(t.links, []);
  if (truthy(links)) {
    const linkStrs = (links as unknown[]).map((l) => (isDict(l) ? `[${pyStr(l.title)}](${pyStr(l.url)})` : pyStr(l)));
    lines.push(`              ↳ Booking : ${linkStrs.join(" · ")}`);
  } else if (truthy(t.booking_url)) {
    lines.push(`              ↳ Booking : ${pyStr(t.booking_url)}`);
  }
  return lines;
}

export function renderCards(itinerary: Dict, budget: Dict | null = null, recheck: BudgetRecheck | null = null): string {
  const out: string[] = [`  ${pyStr(get(itinerary, "route", ""))}`];
  const t = get(itinerary, "transport", {});
  const back = get(itinerary, "return_transport", null);
  if (truthy(t)) out.push(...transportLines(truthy(back) ? "Outbound " : "Transport", t));
  if (truthy(back)) out.push(...transportLines("Return   ", back, truthy(itinerary.return_date) ? `  on ${pyStr(itinerary.return_date)}` : ""));

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
      `              transport ₹${fmtFixed(bd.transport, 0)}${budget.transport_legs > 1 ? " (return included)" : ""} · lodging ₹${fmtFixed(bd.lodging, 0)} · ` +
        `food ₹${fmtFixed(bd.food, 0)} · activities ₹${fmtFixed(bd.activities, 0)}`,
    );
    if (truthy(budget.estimated_total)) {
      out.push(`              about ₹${fmtFixed(budget.estimated_total, 0)} of this is an estimate (shown with ~)`);
    }
    if (recheck?.attempts) {
      out.push(`              Budget re-checked ${recheck.attempts}× (₹${fmtFixed(recheck.from, 0)} → ₹${fmtFixed(recheck.to, 0)})`);
    }
  }
  if (truthy(itinerary.weather_declined)) {
    out.push("  ⚠ Indoor switch declined despite a poor forecast — outdoor plans may be disrupted.");
  }
  return out.join("\n");
}
