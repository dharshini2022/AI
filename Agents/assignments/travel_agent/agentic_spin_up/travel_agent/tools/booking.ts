import { type Principal, can } from "../rbac.ts";
import type { Dict } from "./util.ts";

export interface BookingDetails {
  destination: string;
  transportOption?: string;
  travellers?: number;
  fare?: string;
  source?: string;
}

export function bookFlight(principal: Principal, details: BookingDetails): Dict {
  if (!can(principal, "book_flight")) {
    return {
      success: false,
      error: `Permission denied: Role '${principal.role}' is not authorized to book tickets. Only admin can book flights.`,
    };
  }

  console.log("  [Main Agent] [booking] Flight booked successfully");
  return {
    success: true,
    message: "Flight booked successfully",
    status: "confirmed",
    booking_reference: `FLIGHT-BK-${Math.random().toString(36).substring(2, 8).toUpperCase()}`,
    details,
  };
}
