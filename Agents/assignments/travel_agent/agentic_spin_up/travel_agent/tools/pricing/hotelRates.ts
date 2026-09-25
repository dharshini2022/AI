import { z } from "zod";
import { settings } from "../../config.ts";
import { type Dict, pyOr, pyStr, readJsonFile } from "../util.ts";

const Rates = z.object({
  stars: z.object({
    "1": z.number().positive(),
    "2": z.number().positive(),
    "3": z.number().positive(),
    "4": z.number().positive(),
    "5": z.number().positive(),
  }),
  unclassified: z.number().positive(),
});
const HotelRates = z.object({
  default: Rates,
  kinds: z.record(z.string(), z.number().int().min(1).max(5)).default({}),
  cities: z.record(z.string(), Rates).default({}),
});

let loaded: { file: string; data: z.infer<typeof HotelRates> } | null = null;

function data() {
  if (loaded?.file !== settings.hotelRatesFile) loaded = { file: settings.hotelRatesFile, data: readJsonFile(settings.hotelRatesFile, HotelRates) };
  return loaded.data;
}

const WORD_STARS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };
const STAR_TEXT = /\b([1-5]|one|two|three|four|five)[\s-]?stars?\b/i;

// The hotel's star class (1 to 5), or null when the listing does not say. Search results carry no class
// field, so it is read from the listing's own words. The name is read before it is cleaned, because
// "Hotel X | Luxury 5 Star Resorts" loses its second half there. Failing that, the primary category
// ("Homestay", "Lodge") maps to a class through the data file; "Hotel" and "Resort hotel" say nothing.
export function hotelStars(place: Dict): number | null {
  const text = [pyOr(place.title, place.name, ""), place.type, place.description].filter(Boolean).map(pyStr).join(" | ");
  const stated = STAR_TEXT.exec(text)?.[1].toLowerCase();
  if (stated) return WORD_STARS[stated] ?? Number(stated);
  return data().kinds[pyStr(pyOr(place.type, "")).trim().toLowerCase()] ?? null;
}

// Nightly rate for a stay with no listed price, from its star class (null when unknown), using the city's
// own rates if it has any. The guest review score plays no part: a 4.8-rated guest house is still a guest
// house. The caller marks the result as an estimate.
export function estimateNightlyRate(city: string, stars: number | null): number {
  const { default: fallback, cities } = data();
  const rates = cities[city.trim().toLowerCase()] ?? fallback;
  return stars === null ? rates.unclassified : rates.stars[String(stars) as "1" | "2" | "3" | "4" | "5"];
}
