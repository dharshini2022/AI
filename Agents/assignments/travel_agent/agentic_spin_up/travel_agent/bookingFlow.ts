// Booking and its confirmation email: a plain code path (not an MCP tool, not in any agent's tool list) that
// runs once the plan is final and the admin says yes. See concepts/rbac.md and concepts/booking-email.md.
import { formatBookingBox, type Hitl } from "./hitl.ts";
import type { Plan } from "./mainAgent.ts";
import { type Principal, can } from "./rbac/rbac.ts";
import { type BookedLeg, type BookingDetails, bookTransportation, fareText, mailConfigured, sendBookingEmail } from "./tools/index.ts";
import { type Dict, addDays, get, truthy } from "./tools/util.ts";

// One booked leg from the option the user chose for it.
function bookedLeg(label: BookedLeg["label"], route: string, date: unknown, option: Dict): BookedLeg {
  const links: Dict[] = truthy(option.links) ? option.links : truthy(option.booking_url) ? [{ title: "Book", url: option.booking_url }] : [];
  return {
    label,
    route,
    date: String(date ?? ""),
    option: `${get(option, "option", "")} via ${get(option, "provider", "")}`,
    fare: fareText(option),
    links: links.map((l) => ({ title: String(l.title ?? l.url), url: String(l.url) })),
  };
}

// The legs the user chose, outbound first, so the booking box, the booking record and the email agree.
function bookedLegs(plan: Plan): BookedLeg[] {
  const source = String(get(plan.requirements, "source", ""));
  const destination = String(get(plan.requirements, "destination", ""));
  const back = get(plan.flightsResult, "selected_return", null);
  return [
    bookedLeg("Outbound", `${source} → ${destination}`, get(plan.requirements, "start_date"), get(plan.flightsResult, "selected", {})),
    ...(truthy(back) ? [bookedLeg("Return", `${destination} → ${source}`, get(plan.flightsResult, "return_date"), back)] : []),
  ];
}

// Asks where to send the booking and sends it. A mail problem is reported, never thrown: the booking stands.
async function emailBooking(channel: Hitl, details: BookingDetails, reference: string): Promise<Dict> {
  if (!mailConfigured()) {
    console.log("  Email is not set up (MAIL_USER / APP_PASSWORD), so no confirmation was sent.");
    return { sent: false, reason: "not_configured" };
  }
  const to = await channel.askEmail(`Booking confirmed (${reference}). Email the details to (press Enter to skip):`);
  if (!to) return { sent: false, reason: "skipped" };
  try {
    await sendBookingEmail(to, details, reference);
    console.log(`  Confirmation sent to ${to}.`);
    return { sent: true, to };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.log(`  Booked, but the email could not be sent: ${message}`);
    return { sent: false, reason: "send_failed", error: message };
  }
}

export async function offerBooking(principal: Principal, channel: Hitl, plan: Plan): Promise<Dict | null> {
  if (!can(principal, "book_transportation")) {
    console.log("\nBook Transportation is available to admins only. Login as admin (run with --admin) to book this transportation.");
    return null;
  }
  const start = String(get(plan.requirements, "start_date", ""));
  const numDays = Number(get(plan.requirements, "num_days", 1));
  const details: BookingDetails = {
    destination: String(get(plan.requirements, "destination", "")),
    source: String(get(plan.requirements, "source", "")),
    travellers: Number(get(plan.requirements, "num_travellers", 1)),
    trip: { start, end: addDays(start, Math.max(0, numDays - 1)) ?? start },
    legs: bookedLegs(plan),
  };
  console.log(formatBookingBox(details));
  const { answer } = await channel.askYesNo("Book this transportation?");
  if (!answer) return null;
  const booking = bookTransportation(principal, details);
  if (!booking.success) return booking;
  return { ...booking, email: await emailBooking(channel, details, booking.booking_reference) };
}
