import { settings } from "../../config.ts";
import { serperWebSearch } from "../providers/serper.ts";

const WORD_STARS: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, five: 5 };

// A class stated as a kind of hotel: "five star Luxury Resort", "a luxurious 5-star resort", "Classified 5
// Star Resort". It must be followed by a hotel word, so a guest score ("rated 4 out of 5 stars", "5 star
// reviews") is not read as a class. "4.5 star hotel" is skipped too.
const CLASS_PHRASE =
  /(?<![\d.])\b([1-5]|one|two|three|four|five)[\s-]?stars?\s+(?:[\p{L}]+\s+){0,2}?(?:hotel|resort|property|accommodation|heritage|boutique|luxury|deluxe|villa|palace)\b/iu;

const STOP_WORDS = new Set(["the", "and", "hotel", "hotels", "resort", "resorts", "spa", "by", "of", "at", "in"]);

const words = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);

// The class a web result states for this hotel, or null. A result counts only if it names the hotel
// (every distinctive word of its name, leaving out the city and words like "Resort"), so a page listing
// "Top 5 star hotels in Munnar" says nothing about it. The first result that qualifies wins.
export function classFromResults(name: string, city: string, results: { title: string; snippet: string }[]): number | null {
  const cityWords = new Set(words(city));
  const distinctive = words(name).filter((w) => w.length > 2 && !STOP_WORDS.has(w) && !cityWords.has(w));
  if (!distinctive.length) return null;
  for (const { title, snippet } of results) {
    const text = `${title}. ${snippet}`;
    const present = new Set(words(text));
    if (!distinctive.every((w) => present.has(w))) continue;
    const stated = CLASS_PHRASE.exec(text)?.[1].toLowerCase();
    if (stated) return WORD_STARS[stated] ?? Number(stated);
  }
  return null;
}

// One web search for the hotel's own class. Null when the lookup is off, fails, or finds no class.
export async function lookupHotelClass(name: string, city: string, signal?: AbortSignal): Promise<number | null> {
  if (!settings.hotelClassLookup) return null;
  const results = await serperWebSearch(`${name} ${city}`, signal);
  return results ? classFromResults(name, city, results) : null;
}
