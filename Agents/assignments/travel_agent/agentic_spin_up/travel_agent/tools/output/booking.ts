import { type Principal, can } from "../../rbac/rbac.ts";
import type { Dict } from "../util.ts";

// One booked leg, ready to print or email.
export interface BookedLeg {
  label: "Outbound" | "Return";
  route: string; // "Chennai → Goa"
  date: string; // "2026-11-05"
  option: string; // "Direct / Connecting Flight via IndiGo / Air India / ixigo"
  fare: string; // per person, one way; "~₹3200" when it is a guess
  links: { title: string; url: string }[];
}

export interface BookingDetails {
  destination: string;
  source?: string;
  travellers?: number;
  trip: { start: string; end: string }; // first and last day of the trip
  legs: BookedLeg[];
}

// One leg as plain lines: used by the confirmation email and the .ics description, so they never disagree.
export function describeLeg(leg: BookedLeg): string[] {
  return [
    `${leg.label}: ${leg.route} on ${leg.date}`,
    `  ${leg.option}`,
    `  Fare: ${leg.fare} per person`,
    ...leg.links.map((l) => `  ${l.title}: ${l.url}`),
  ];
}

export function bookTransportation(principal: Principal, details: BookingDetails): Dict {
  if (!can(principal, "book_transportation")) {
    return {
      success: false,
      error: `Permission denied: Role '${principal.role}' is not authorized to book transportation. Only admin can book transportation.`,
    };
  }

  console.log("  [Main Agent] [booking] Transportation booked successfully");
  return {
    success: true,
    message: "Transportation booked successfully",
    status: "confirmed",
    booking_reference: `TRANSPORT-BK-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
    details,
  };
}
