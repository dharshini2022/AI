import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BookingDetails } from "../travel_agent/tools/output/booking.ts";
import { buildIcs } from "../travel_agent/tools/output/ics.ts";

const smtp = vi.hoisted(() => ({ sendMail: vi.fn(async () => ({})), createTransport: vi.fn() }));
smtp.createTransport.mockImplementation(() => ({ sendMail: smtp.sendMail }));
vi.mock("nodemailer", () => ({ default: { createTransport: smtp.createTransport } }));

const config = vi.hoisted(() => ({
  mailUser: "sender@example.com",
  mailPassword: "abcdefghijklmnop",
  mailHost: "smtp.example.com",
  mailPort: 465,
  mailFrom: "sender@example.com",
}));
vi.mock("../travel_agent/config.ts", async (importOriginal) => {
  const mod = await importOriginal<typeof import("../travel_agent/config.ts")>();
  return { ...mod, settings: new Proxy({ ...mod.settings }, { get: (target, key) => (key in config ? (config as any)[key] : (target as any)[key]) }) };
});

const { buildBookingEmail, mailConfigured, sendBookingEmail } = await import("../travel_agent/tools/output/mail.ts");

const outbound = { label: "Outbound" as const, route: "Chennai → Goa", date: "2026-11-05", option: "IndiGo via ixigo", fare: "~₹3200", links: [{ title: "ixigo", url: "https://ixigo.example/a?b=1&c=2" }] };
const back = { label: "Return" as const, route: "Goa → Chennai", date: "2026-11-07", option: "Volvo Bus via RedBus", fare: "₹900", links: [] };
const twoWay: BookingDetails = { destination: "Goa", source: "Chennai", travellers: 2, trip: { start: "2026-11-05", end: "2026-11-07" }, legs: [outbound, back] };

beforeEach(() => {
  smtp.sendMail.mockClear();
  smtp.createTransport.mockClear();
  Object.assign(config, { mailUser: "sender@example.com", mailPassword: "abcdefghijklmnop", mailPort: 465 });
});

describe("buildBookingEmail", () => {
  it("has an Outbound and a Return section with the right routes, dates and the reference", () => {
    const { subject, text, html } = buildBookingEmail(twoWay, "TRANSPORT-BK-ABC123");
    expect(subject).toBe("Your trip booking TRANSPORT-BK-ABC123: Chennai ⇄ Goa");
    for (const body of [text, html]) {
      expect(body).toContain("TRANSPORT-BK-ABC123");
      expect(body).toContain("Outbound: Chennai → Goa on 2026-11-05");
      expect(body).toContain("Return: Goa → Chennai on 2026-11-07");
      expect(body).toContain("IndiGo via ixigo");
      expect(body).toContain("Volvo Bus via RedBus");
    }
    expect(text).toContain("Fare: ~₹3200 per person");
    expect(text).toContain("Travellers: 2");
    expect(text).toContain("not an e-ticket");
  });

  it("has no Return section for a one-way booking", () => {
    const { text, html } = buildBookingEmail({ ...twoWay, legs: [outbound] }, "REF");
    expect(text).not.toContain("Return");
    expect(html).not.toContain("Return");
  });

  it("makes web links clickable and escapes everything that came from search results", () => {
    const hostile = { ...outbound, option: "<b>x</b> & co", links: [{ title: "<i>book</i>", url: "https://ok.example/?a=1&b=2" }, { title: "odd", url: "javascript:alert(1)" }] };
    const { html } = buildBookingEmail({ ...twoWay, legs: [hostile] }, "REF");
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt; &amp; co");
    expect(html).toContain('<a href="https://ok.example/?a=1&amp;b=2">&lt;i&gt;book&lt;/i&gt;</a>');
    expect(html).not.toContain("<a href=\"javascript");
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("sendBookingEmail", () => {
  it("sends the built email to the address, from the configured sender, over TLS on port 465", async () => {
    await sendBookingEmail("me@example.com", twoWay, "REF1");
    expect(smtp.createTransport).toHaveBeenCalledWith({
      host: "smtp.example.com",
      port: 465,
      secure: true,
      auth: { user: "sender@example.com", pass: "abcdefghijklmnop" },
    });
    const [message] = smtp.sendMail.mock.calls[0] as unknown as [Record<string, string>];
    expect(message).toMatchObject({ from: "sender@example.com", to: "me@example.com", ...buildBookingEmail(twoWay, "REF1") });
  });

  it("attaches a .ics file for the same booking", async () => {
    await sendBookingEmail("me@example.com", twoWay, "REF1");
    const [message] = smtp.sendMail.mock.calls[0] as unknown as [{ attachments: { filename: string; content: string; contentType: string }[] }];
    expect(message.attachments).toHaveLength(1);
    const [attachment] = message.attachments;
    expect(attachment.filename).toBe("trip-REF1.ics");
    expect(attachment.contentType).toBe("text/calendar; charset=utf-8; method=PUBLISH");
    expect(attachment.content).toBe(buildIcs(twoWay, "REF1"));
  });

  it("uses STARTTLS on any other port", async () => {
    config.mailPort = 587;
    await sendBookingEmail("me@example.com", twoWay, "REF1");
    expect(smtp.createTransport).toHaveBeenCalledWith(expect.objectContaining({ port: 587, secure: false }));
  });

  it("lets a send failure reach the caller", async () => {
    smtp.sendMail.mockRejectedValueOnce(new Error("Invalid login"));
    await expect(sendBookingEmail("me@example.com", twoWay, "REF1")).rejects.toThrow("Invalid login");
  });
});

describe("mailConfigured", () => {
  it("needs both the sender address and the password", () => {
    expect(mailConfigured()).toBe(true);
    config.mailPassword = "";
    expect(mailConfigured()).toBe(false);
    Object.assign(config, { mailPassword: "abcdefghijklmnop", mailUser: "" });
    expect(mailConfigured()).toBe(false);
  });
});
