import { type FareMode, hasNoRailhead, tableFare } from "../pricing/fares.ts";
import { geocode } from "./geo.ts";
import { haversineKm } from "../itinerary.ts";
import { type Dict, numStr, pyQuote, pyRound, pyTitle } from "../util.ts";

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

const wholeHours = (hours: number) => Math.trunc(pyRound(hours));

// Under this straight-line distance nobody flies, so the flight option is not offered.
const MIN_FLIGHT_KM = 200;

// A fare from the route table replaces the formula's numbers for that mode and is not an estimate
// (unless the table says so). Any mode the table lacks keeps the formula's numbers, marked as an estimate.
function withFare(source: string, destination: string, key: FareMode, { fare: formulaFare, ...option }: Dict, pax: number): Dict {
  // One person, one way. `approx_fare` is what the user reads; `price` is what the budget adds up.
  const priced = (perPerson: number): Dict => ({ ...option, approx_fare: `₹${perPerson}`, price: perPerson * pax });
  const fare = tableFare(source, destination, key);
  if (!fare) return { ...priced(formulaFare), estimated: true, fare_source: "estimate" };
  const hours = fare.hours ?? option.duration_hours;
  return {
    ...priced(fare.price),
    travel_time: fare.hours ? `~${wholeHours(hours)}h` : option.travel_time,
    duration_hours: hours,
    estimated: fare.estimated,
    fare_source: "fare_table",
  };
}

export async function searchTransport(source: string, destination: string, date: string, pax = 1): Promise<Dict> {
  pax = Math.max(1, pax);

  const [src, dst] = await Promise.all([geocode(source), geocode(destination)]);
  let straightKm = 350;
  let roadKm = 420;
  if (src[0] !== null && dst[0] !== null) {
    straightKm = haversineKm(src as [number, number], dst as [number, number]);
    roadKm = straightKm * 1.25;
  }

  const busHours = Math.max(2.5, pyRound(roadKm / 50, 1));
  const trainHours = Math.max(2.0, pyRound(roadKm / 55, 1));
  const flightHours = Math.max(1.0, pyRound(straightKm / 450 + 0.5, 1));

  const links = buildDeepLinks(source, destination, date);

  const km = (factor: number) => Math.trunc(roadKm * factor);
  const standardBusFare = Math.max(300, km(1.1));
  const trainFare = Math.max(400, km(1.2));
  const acBusFare = Math.max(600, km(1.8));
  const premBusFare = Math.max(1200, km(3.0));
  const flightFare = Math.max(3200, Math.trunc(straightKm * 7.5));

  const candidates = [
    {
      fareKey: "standard_bus" as FareMode,
      mode: "bus",
      option: "Non-AC / Standard Bus",
      provider: "TNSTC / KSRTC / State Transport",
      travel_time: `~${wholeHours(busHours)}h`,
      duration_hours: busHours,
      notes: "Cheapest",
      fare: standardBusFare,
      booking_url: links.bus_redbus.url,
      links: [links.bus_redbus, links.bus_mmt],
    },
    {
      fareKey: "ac_bus" as FareMode,
      mode: "bus",
      option: "AC Seater / Sleeper Bus",
      provider: "Private Sleeper / redBus / MakeMyTrip",
      travel_time: `~${wholeHours(busHours)}–${wholeHours(busHours + 2)}h`,
      duration_hours: busHours + 1.0,
      notes: "Better comfort",
      fare: acBusFare,
      booking_url: links.bus_redbus.url,
      links: [links.bus_redbus, links.bus_mmt],
    },
    {
      fareKey: "premium_bus" as FareMode,
      mode: "bus",
      option: "Premium Multi-Axle Sleeper",
      provider: "IntrCity / Orange / SRS Travels",
      travel_time: `~${wholeHours(busHours)}–${wholeHours(busHours + 1)}h`,
      duration_hours: busHours,
      notes: "Depends on operator",
      fare: premBusFare,
      booking_url: links.bus_mmt.url,
      links: [links.bus_mmt, links.bus_redbus],
    },
    {
      fareKey: "train" as FareMode,
      mode: "train",
      option: "Express / Superfast Train",
      provider: "Indian Railways (Express / Vande Bharat)",
      travel_time: `~${wholeHours(trainHours)}h`,
      duration_hours: trainHours,
      notes: "Scenic & economical",
      fare: trainFare,
      booking_url: links.train_ixigo.url,
      links: [links.train_ixigo, links.train_confirmtkt],
    },
    {
      fareKey: "flight" as FareMode,
      mode: "flight",
      option: "Direct / Connecting Flight",
      provider: "IndiGo / Air India / ixigo",
      travel_time: `~${numStr(flightHours)}h`,
      duration_hours: flightHours,
      notes: "Fastest",
      fare: flightFare,
      booking_url: links.flight_ixigo.url,
      links: [links.flight_ixigo, links.flight_google],
    },
  ];

  const noTrain = hasNoRailhead(source) || hasNoRailhead(destination);
  const noFlight = straightKm < MIN_FLIGHT_KM;
  const options = candidates
    .filter(({ fareKey }) => !(fareKey === "train" && noTrain) && !(fareKey === "flight" && noFlight))
    .map(({ fareKey, ...option }) => withFare(source, destination, fareKey, option, pax))
    .sort((a, b) => a.price - b.price);

  return {
    source: "deep_link_search",
    route: `${pyTitle(source.trim())} → ${pyTitle(destination.trim())}`,
    options,
    organic_search_results: [],
  };
}
