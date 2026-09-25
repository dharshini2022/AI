import { describe, expect, it } from "vitest";
import type { BookingDetails } from "../travel_agent/tools/output/booking.ts";
import { buildIcs } from "../travel_agent/tools/output/ics.ts";

const outbound = { label: "Outbound" as const, route: "Chennai → Goa", date: "2026-11-05", option: "IndiGo via ixigo", fare: "~₹3200", links: [{ title: "ixigo", url: "https://ixigo.example/a" }] };
const back = { label: "Return" as const, route: "Goa → Chennai", date: "2026-11-07", option: "Volvo Bus via RedBus", fare: "₹900", links: [] };
const twoWay: BookingDetails = { destination: "Goa", source: "Chennai", travellers: 2, trip: { start: "2026-11-05", end: "2026-11-07" }, legs: [outbound, back] };

// Each unfolded property is on its own logical line: undo RFC 5545 folding (CRLF + a leading space) before
// checking content, so assertions aren't sensitive to exactly where a fold happened.
function unfold(ics: string): string[] {
  return ics.replace(/\r\n /g, "").split("\r\n").filter(Boolean);
}

describe("buildIcs", () => {
  it("is a VCALENDAR with one all-day, busy VEVENT spanning the trip, with the exclusive end date", () => {
    const lines = unfold(buildIcs(twoWay, "TRANSPORT-BK-ABC123"));
    expect(lines[0]).toBe("BEGIN:VCALENDAR");
    expect(lines).toContain("METHOD:PUBLISH");
    expect(lines).toContain("BEGIN:VEVENT");
    expect(lines).toContain("UID:TRANSPORT-BK-ABC123@agentic-spin-up");
    expect(lines).toContain("DTSTART;VALUE=DATE:20261105");
    expect(lines).toContain("DTEND;VALUE=DATE:20261108"); // one day past the trip's last day (2026-11-07)
    expect(lines).toContain("SUMMARY:Trip: Chennai ⇄ Goa");
    expect(lines).toContain("LOCATION:Goa");
    expect(lines).toContain("TRANSP:OPAQUE");
    expect(lines.some((l) => l.startsWith("DESCRIPTION:"))).toBe(true);
    expect(lines.find((l) => l.startsWith("DESCRIPTION:"))).toContain("Reference: TRANSPORT-BK-ABC123");
    expect(lines.find((l) => l.startsWith("DESCRIPTION:"))).toContain("Outbound: Chennai");
    expect(lines.find((l) => l.startsWith("DESCRIPTION:"))).toContain("Return: Goa");
    expect(lines).toContain("END:VEVENT");
    expect(lines.at(-1)).toBe("END:VCALENDAR");
  });

  it("has no Return text for a one-way booking", () => {
    const lines = unfold(buildIcs({ ...twoWay, legs: [outbound] }, "REF"));
    expect(lines.find((l) => l.startsWith("DESCRIPTION:"))).not.toContain("Return");
  });

  it("escapes commas, semicolons and backslashes in text fields", () => {
    const hostile: BookingDetails = { ...twoWay, destination: "Pondicherry, Puducherry; Union Territory\\Coast" };
    const lines = unfold(buildIcs(hostile, "REF"));
    expect(lines).toContain("LOCATION:Pondicherry\\, Puducherry\\; Union Territory\\\\Coast");
  });

  it("gives the same booking reference the same UID every time", () => {
    expect(buildIcs(twoWay, "REF")).toBe(buildIcs(twoWay, "REF"));
    const [a, b] = ["REF-A", "REF-B"].map((ref) => buildIcs(twoWay, ref).match(/UID:(\S+)/)?.[1]);
    expect(a).not.toBe(b);
  });

  it("uses CRLF line endings throughout", () => {
    const ics = buildIcs(twoWay, "REF");
    const newlines = ics.match(/\n/g)?.length ?? 0;
    const crlfs = ics.match(/\r\n/g)?.length ?? 0;
    expect(crlfs).toBe(newlines); // every \n is part of a \r\n, never a lone \n
  });

  it("folds long lines at 75 octets without splitting a multi-byte character", () => {
    const longLeg = { ...outbound, links: Array.from({ length: 6 }, (_, i) => ({ title: `Booking option number ${i} ₹→⇄`, url: `https://example.com/booking-${i}` })) };
    const ics = buildIcs({ ...twoWay, legs: [longLeg] }, "REF");
    const rawLines = ics.split("\r\n").filter(Boolean);
    for (const line of rawLines) {
      expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(75);
    }
    // Every multi-byte character survives the fold intact, wherever it landed.
    expect(Buffer.byteLength(ics, "utf8")).toBe(new TextEncoder().encode(ics).length);
    expect(unfold(ics).find((l) => l.startsWith("DESCRIPTION:"))).toContain("₹→⇄");
  });
});
