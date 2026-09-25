import nodemailer from "nodemailer";
import { settings } from "../../config.ts";
import { type BookedLeg, type BookingDetails, describeLeg } from "./booking.ts";
import { buildIcs } from "./ics.ts";

export const mailConfigured = () => Boolean(settings.mailUser && settings.mailPassword);

const escapeHtml = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// Only web links are made clickable; anything else is shown as plain text.
const isWebUrl = (url: string) => /^https?:\/\//i.test(url);

const FOOTER = "This is a booking confirmation and trip summary, not an e-ticket. Fares are per person, one way; fares marked ~ are estimates.";

function legHtml(leg: BookedLeg): string {
  const links = leg.links
    .map((l) => `<li>${isWebUrl(l.url) ? `<a href="${escapeHtml(l.url)}">${escapeHtml(l.title)}</a>` : `${escapeHtml(l.title)}: ${escapeHtml(l.url)}`}</li>`)
    .join("");
  return (
    `<h3>${escapeHtml(leg.label)}: ${escapeHtml(leg.route)} on ${escapeHtml(leg.date)}</h3>` +
    `<p>${escapeHtml(leg.option)}<br>Fare: ${escapeHtml(leg.fare)} per person</p>` +
    (links ? `<ul>${links}</ul>` : "")
  );
}

// Pure: the subject, plain text and HTML for one booking, with a section per leg.
export function buildBookingEmail(details: BookingDetails, reference: string): { subject: string; text: string; html: string } {
  const trip = details.source ? `${details.source} ⇄ ${details.destination}` : details.destination;
  const travellers = details.travellers ? `Travellers: ${details.travellers}` : "";
  const text = [
    `Your booking is confirmed. Reference: ${reference}`,
    travellers,
    "",
    ...details.legs.flatMap((leg) => [...describeLeg(leg), ""]),
    FOOTER,
  ].filter((line, i, all) => line !== "" || all[i - 1] !== "").join("\n");
  const html =
    `<p>Your booking is confirmed. Reference: <strong>${escapeHtml(reference)}</strong></p>` +
    (travellers ? `<p>${escapeHtml(travellers)}</p>` : "") +
    details.legs.map(legHtml).join("") +
    `<p><small>${escapeHtml(FOOTER)}</small></p>`;
  return { subject: `Your trip booking ${reference}: ${trip}`, text, html };
}

// Sends it. Throws on failure; the caller decides what to tell the user.
export async function sendBookingEmail(to: string, details: BookingDetails, reference: string): Promise<void> {
  const transport = nodemailer.createTransport({
    host: settings.mailHost,
    port: settings.mailPort,
    secure: settings.mailPort === 465,
    auth: { user: settings.mailUser, pass: settings.mailPassword },
  });
  await transport.sendMail({
    from: settings.mailFrom,
    to,
    ...buildBookingEmail(details, reference),
    attachments: [
      { filename: `trip-${reference}.ics`, content: buildIcs(details, reference), contentType: "text/calendar; charset=utf-8; method=PUBLISH" },
    ],
  });
}
