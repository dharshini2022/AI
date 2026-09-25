import { describeLeg, type BookingDetails } from "./booking.ts";
import { addDays } from "../util.ts";

// RFC 5545 TEXT escaping: backslash first, then the characters that would otherwise end a value early,
// then real newlines become the two-character sequence "\n".
function escapeIcsText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
}

// RFC 5545 wants each physical line, continuation lines included, at 75 octets or fewer, with a single
// space starting every continuation. That space counts against the 75, so a continuation's own content
// gets one byte less room than the first line. Folding by character count would be wrong here too: a
// multi-byte character (₹, →, ⇄) must never be split across the fold, so this counts UTF-8 bytes and only
// ever breaks between whole characters.
function foldLine(line: string): string {
  const LIMIT = 75;
  const chars = Array.from(line);
  const parts: string[] = [];
  let current = "";
  let bytes = 0;
  let capacity = LIMIT;
  for (const ch of chars) {
    const chBytes = Buffer.byteLength(ch, "utf8");
    if (bytes + chBytes > capacity) {
      parts.push(current);
      current = "";
      bytes = 0;
      capacity = LIMIT - 1; // every line from here on starts with the continuation's leading space
    }
    current += ch;
    bytes += chBytes;
  }
  parts.push(current);
  return parts.map((part, i) => (i === 0 ? part : ` ${part}`)).join("\r\n");
}

const dashless = (isoDate: string) => isoDate.replaceAll("-", "");

// A stamp Google Calendar, Outlook and Apple Calendar all read the same booking reference into: stable
// across builds of the same booking, so importing the same file twice never creates two different events.
const uidFor = (reference: string) => `${reference}@agentic-spin-up`;

// Pure: one all-day, busy VEVENT for this booking, as a complete .ics file. CRLF line endings and folded
// lines, per RFC 5545, so real calendar apps import it cleanly.
export function buildIcs(details: BookingDetails, reference: string): string {
  const trip = details.source ? `${details.source} ⇄ ${details.destination}` : details.destination;
  const travellers = details.travellers ? [`Travellers: ${details.travellers}`] : [];
  const description = [`Reference: ${reference}`, ...travellers, "", ...details.legs.flatMap((leg) => [...describeLeg(leg), ""])]
    .join("\n")
    .trimEnd();

  const now = new Date().toISOString().replace(/[-:]/g, "").split(".")[0] + "Z";
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//agentic-spin-up//Trip Planner//EN",
    "METHOD:PUBLISH",
    "CALSCALE:GREGORIAN",
    "BEGIN:VEVENT",
    `UID:${uidFor(reference)}`,
    `DTSTAMP:${now}`,
    `DTSTART;VALUE=DATE:${dashless(details.trip.start)}`,
    // The iCalendar end date is exclusive, so the last day of the trip needs one day added.
    `DTEND;VALUE=DATE:${dashless(addDays(details.trip.end, 1) ?? details.trip.end)}`,
    `SUMMARY:${escapeIcsText(`Trip: ${trip}`)}`,
    `LOCATION:${escapeIcsText(details.destination)}`,
    `DESCRIPTION:${escapeIcsText(description)}`,
    "TRANSP:OPAQUE",
    "STATUS:CONFIRMED",
    "END:VEVENT",
    "END:VCALENDAR",
  ];
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
