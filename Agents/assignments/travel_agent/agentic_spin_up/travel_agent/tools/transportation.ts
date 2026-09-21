import { settings } from "../config.ts";
import { geocode } from "./geo.ts";
import { haversineKm } from "./itinerary.ts";
import { serpapi } from "./serpapi.ts";
import { type Dict, get, numStr, pyOr, pyQuote, pyRound, pyTitle, truthy } from "./util.ts";

const AIRPORT_CODES: Record<string, string> = {
  coimbatore: "CJB",
  pondicherry: "PNY",
  puducherry: "PNY",
  bangalore: "BLR",
  bengaluru: "BLR",
  chennai: "MAA",
  delhi: "DEL",
  "new delhi": "DEL",
  mumbai: "BOM",
  hyderabad: "HYD",
  kochi: "COK",
  cochin: "COK",
  munnar: "COK",
  goa: "GOI",
  madurai: "IXM",
  trichy: "TRZ",
  tiruchirappalli: "TRZ",
  jaipur: "JAI",
  kolkata: "CCU",
};

export function slugify(text: string): string {
  return (text || "")
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_\s-]/gu, "")
    .replace(/[\s_-]+/g, "-");
}

function airportCode(city: string): string {
  const key = city.trim().toLowerCase();
  return Object.hasOwn(AIRPORT_CODES, key) ? AIRPORT_CODES[key] : city.trim().slice(0, 3).toUpperCase();
}

function buildDeepLinks(source: string, destination: string, date: string) {
  const [srcSlug, dstSlug] = [slugify(source), slugify(destination)];
  const [srcClean, dstClean] = [pyTitle(source.trim()), pyTitle(destination.trim())];
  const [srcCode, dstCode] = [airportCode(source), airportCode(destination)];
  const flightQuery = pyQuote(`flights from ${srcClean} to ${dstClean} on ${date}`);

  return {
    bus_redbus: {
      title: `redBus – ${srcClean} → ${dstClean}`,
      url: `https://www.redbus.in/bus-tickets/${srcSlug}-to-${dstSlug}`,
    },
    bus_mmt: {
      title: `MakeMyTrip – ${srcClean} → ${dstClean} buses`,
      url: `https://www.makemytrip.com/bus-tickets/${srcSlug}-${dstSlug}-bus-ticket-booking.html`,
    },
    flight_ixigo: {
      title: `ixigo – ${srcCode} → ${dstCode} flights`,
      url: `https://www.ixigo.com/cheap-flights/${srcSlug}-${dstSlug}`,
    },
    flight_google: {
      title: `Google Flights – ${srcCode} → ${dstCode}`,
      url: `https://www.google.com/travel/flights?q=${flightQuery}`,
    },
    train_ixigo: {
      title: `ixigo Trains – ${srcClean} → ${dstClean}`,
      url: `https://www.ixigo.com/trains/${srcSlug}-to-${dstSlug}`,
    },
    train_confirmtkt: {
      title: `ConfirmTkt – ${srcClean} → ${dstClean}`,
      url: "https://www.confirmtkt.com/train-running-status",
    },
  };
}

async function searchSerpapiTransit(source: string, destination: string): Promise<Dict[]> {
  if (!settings.serpapiApiKey) return [];
  const data = await serpapi({
    engine: "google",
    q: `${source} to ${destination} bus train flight ticket booking`,
    num: 5,
    gl: "in",
    hl: "en",
  });
  if (!truthy(data)) return [];

  const results: Dict[] = [];
  for (const item of (pyOr(data.organic_results, []) as Dict[]).slice(0, 4)) {
    const [link, title] = [get(item, "link"), get(item, "title")];
    if (truthy(link) && truthy(title)) results.push({ title, url: link, snippet: get(item, "snippet", "") });
  }
  return results;
}

export async function searchTransport(source: string, destination: string, date: string, pax = 1): Promise<Dict> {
  pax = Math.max(1, pax);

  const [src, dst, serpResults] = await Promise.all([
    geocode(source),
    geocode(destination),
    searchSerpapiTransit(source, destination),
  ]);
  let straightKm = 350;
  let roadKm = 420;
  if (src[0] !== null && dst[0] !== null) {
    straightKm = haversineKm(src as [number, number], dst as [number, number]);
    roadKm = straightKm * 1.25;
  }

  const busHours = Math.max(2.5, pyRound(roadKm / 50, 1));
  const trainHours = Math.max(2.0, pyRound(roadKm / 55, 1));
  const flightHours = straightKm > 200 ? Math.max(1.0, pyRound(straightKm / 450 + 0.5, 1)) : 1.0;
  const wholeHours = (h: number) => Math.trunc(pyRound(h));

  const links = buildDeepLinks(source, destination, date);

  const km = (factor: number) => Math.trunc(roadKm * factor);
  const baseBusFare = Math.max(300, km(1.1));
  const acBusFareLow = Math.max(600, km(1.8));
  const acBusFareHigh = Math.max(1200, km(3.2));
  const premBusFareLow = Math.max(1200, km(3.0));
  const premBusFareHigh = Math.max(2500, km(6.0));
  const flightFareBase = straightKm > 150 ? Math.max(3200, Math.trunc(straightKm * 7.5)) : 3500;

  const options = [
    {
      mode: "bus",
      option: "Non-AC / Standard Bus",
      provider: "TNSTC / KSRTC / State Transport",
      approx_fare: `₹${baseBusFare}+`,
      travel_time: `~${wholeHours(busHours)}h`,
      duration_hours: busHours,
      notes: "Cheapest",
      price: baseBusFare * pax,
      booking_url: links.bus_redbus.url,
      links: [links.bus_redbus, links.bus_mmt],
    },
    {
      mode: "bus",
      option: "AC Seater / Sleeper Bus",
      provider: "Private Sleeper / redBus / MakeMyTrip",
      approx_fare: `₹${acBusFareLow}–₹${acBusFareHigh}+`,
      travel_time: `~${wholeHours(busHours)}–${wholeHours(busHours + 2)}h`,
      duration_hours: busHours + 1.0,
      notes: "Better comfort",
      price: acBusFareLow * pax,
      booking_url: links.bus_redbus.url,
      links: [links.bus_redbus, links.bus_mmt],
    },
    {
      mode: "bus",
      option: "Premium Multi-Axle Sleeper",
      provider: "IntrCity / Orange / SRS Travels",
      approx_fare: `₹${premBusFareLow}–₹${premBusFareHigh}`,
      travel_time: `~${wholeHours(busHours)}–${wholeHours(busHours + 1)}h`,
      duration_hours: busHours,
      notes: "Depends on operator",
      price: premBusFareLow * pax,
      booking_url: links.bus_mmt.url,
      links: [links.bus_mmt, links.bus_redbus],
    },
    {
      mode: "train",
      option: "Express / Superfast Train",
      provider: "Indian Railways (Express / Vande Bharat)",
      approx_fare: `₹${Math.max(200, km(0.7))}–₹${Math.max(800, km(2.0))}+`,
      travel_time: `~${wholeHours(trainHours)}h`,
      duration_hours: trainHours,
      notes: "Scenic & economical",
      price: Math.max(400, km(1.2)) * pax,
      booking_url: links.train_ixigo.url,
      links: [links.train_ixigo, links.train_confirmtkt],
    },
    {
      mode: "flight",
      option: "Direct / Connecting Flight",
      provider: "IndiGo / Air India / ixigo",
      approx_fare: `₹${flightFareBase}–₹${flightFareBase + 3000}+`,
      travel_time: `~${numStr(flightHours)}h`,
      duration_hours: flightHours,
      notes: "Fastest",
      price: flightFareBase * pax,
      booking_url: links.flight_ixigo.url,
      links: [links.flight_ixigo, links.flight_google],
    },
  ].sort((a, b) => a.price - b.price);

  return {
    source: serpResults.length ? "live_web_search" : "deep_link_search",
    route: `${pyTitle(source.trim())} → ${pyTitle(destination.trim())}`,
    options,
    organic_search_results: serpResults,
  };
}
