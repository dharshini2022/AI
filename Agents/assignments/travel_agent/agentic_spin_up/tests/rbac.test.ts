import { MemorySaver } from "@langchain/langgraph";
import { createAgent } from "langchain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Agent } from "../travel_agent/agent.ts";
import { formatWeatherBox, Hitl } from "../travel_agent/hitl.ts";
import { offerBooking, type Plan } from "../travel_agent/mainAgent.ts";
import { can, resolvePrincipal } from "../travel_agent/rbac/rbac.ts";
import { createRbacMiddleware } from "../travel_agent/rbac/rbacMiddleware.ts";
import { listSpecs, loadSpec } from "../travel_agent/specs.ts";
import { bookTransportation, type BookingDetails } from "../travel_agent/tools/output/booking.ts";

const mail = vi.hoisted(() => ({ configured: false, send: vi.fn(async (_to: string, _details: unknown, _reference: string) => {}) }));
vi.mock("../travel_agent/tools/output/mail.ts", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../travel_agent/tools/output/mail.ts")>()),
  mailConfigured: () => mail.configured,
  sendBookingEmail: mail.send,
}));

const goa: BookingDetails = { destination: "Goa", trip: { start: "2026-11-05", end: "2026-11-05" }, legs: [] };

vi.mock("langchain", async (importOriginal) => ({
  ...(await importOriginal<typeof import("langchain")>()),
  createAgent: vi.fn(() => ({})),
}));
vi.mock("../travel_agent/llm.ts", () => ({ getChatModel: () => ({}) }));

describe("Role-Based Access Control (RBAC)", () => {
  it("resolvePrincipal defaults to user when no options or env are set", () => {
    const orig = process.env.ROLE;
    delete process.env.ROLE;
    try {
      const p = resolvePrincipal();
      expect(p.role).toBe("user");
      expect(p.id).toBe("user-1");
    } finally {
      if (orig !== undefined) process.env.ROLE = orig;
    }
  });

  it("resolvePrincipal detects admin role via option and env", () => {
    const p1 = resolvePrincipal({ role: "admin", id: "admin-custom" });
    expect(p1.role).toBe("admin");
    expect(p1.id).toBe("admin-custom");

    process.env.ROLE = "admin";
    const p2 = resolvePrincipal();
    expect(p2.role).toBe("admin");
    delete process.env.ROLE;
  });

  it("can enforces permissions for user vs admin", () => {
    const user = { id: "u1", role: "user" as const };
    const admin = { id: "a1", role: "admin" as const };

    // Common search permissions
    expect(can(user, "places_search")).toBe(true);
    expect(can(user, "transport_search")).toBe(true);
    expect(can(user, "set_indoor_mode")).toBe(true);
    expect(can(user, "choose_transport")).toBe(true);
    for (const tool of ["extract_requirements", "update_preferences", "present_plan"]) expect(can(user, tool)).toBe(true);

    expect(can(admin, "places_search")).toBe(true);
    expect(can(admin, "transport_search")).toBe(true);
    expect(can(admin, "set_indoor_mode")).toBe(true);
    expect(can(admin, "choose_transport")).toBe(true);

    // Privileged booking permission
    expect(can(user, "book_transportation")).toBe(false);
    expect(can(admin, "book_transportation")).toBe(true);
  });

  it("bookTransportation denies user and confirms for admin", () => {
    const user = { id: "u1", role: "user" as const };
    const admin = { id: "a1", role: "admin" as const };

    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const userRes = bookTransportation(user, goa);
    expect(userRes.success).toBe(false);
    expect(userRes.error).toContain("Permission denied");

    const adminRes = bookTransportation(admin, goa);
    expect(adminRes.success).toBe(true);
    expect(adminRes.message).toBe("Transportation booked successfully");
    expect(adminRes.status).toBe("confirmed");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Transportation booked successfully"));

    logSpy.mockRestore();
  });

  it("createRbacMiddleware intercepts unauthorized tool calls", async () => {
    const user = { id: "u1", role: "user" as const };
    const admin = { id: "a1", role: "admin" as const };

    const userMiddleware = createRbacMiddleware(user);
    const adminMiddleware = createRbacMiddleware(admin);

    const executeMock = vi.fn().mockResolvedValue({ executed: true });
    const requestFor = (name: string) => ({ toolCall: { name, id: `${name}-id` } });

    // User calling places_search (allowed)
    const res1 = await (userMiddleware as any).wrapToolCall(requestFor("places_search"), executeMock);
    expect(res1).toEqual({ executed: true });
    expect(executeMock).toHaveBeenCalledTimes(1);

    // User calling book_transportation (blocked by middleware)
    executeMock.mockClear();
    const res2 = await (userMiddleware as any).wrapToolCall(requestFor("book_transportation"), executeMock);
    expect(res2.status).toBe("error");
    expect(res2.content).toContain("Permission denied");
    expect(executeMock).not.toHaveBeenCalled();

    // Admin calling book_transportation (allowed by middleware)
    executeMock.mockClear();
    const res3 = await (adminMiddleware as any).wrapToolCall(requestFor("book_transportation"), executeMock);
    expect(res3).toEqual({ executed: true });
    expect(executeMock).toHaveBeenCalledTimes(1);
  });

  it("Agent attaches the RBAC middleware to every agent it builds", async () => {
    const spec = loadSpec(listSpecs()[0]);
    const mcp = { langchainTools: () => [] } as never;
    const executeMock = vi.fn().mockResolvedValue({ executed: true });
    const requestFor = (name: string) => ({ toolCall: { name, id: `${name}-id` } });

    new Agent(spec, mcp, { sessionId: "s", checkpointer: new MemorySaver(), principal: { id: "u1", role: "user" } });
    const { middleware } = vi.mocked(createAgent).mock.calls.at(-1)![0];
    const rbac = (middleware as any[]).find((m) => m.name === "RbacAuthorizationMiddleware");

    expect(await rbac.wrapToolCall(requestFor("places_search"), executeMock)).toEqual({ executed: true });
    executeMock.mockClear();
    const denied = await rbac.wrapToolCall(requestFor("book_transportation"), executeMock);
    expect(denied.status).toBe("error");
    expect(executeMock).not.toHaveBeenCalled();
  });

  it("every tool named in an agent spec is allowed for the user role", () => {
    const user = { id: "u1", role: "user" as const };
    for (const name of listSpecs()) {
      for (const tool of loadSpec(name).tools) expect(can(user, tool), `${name} uses ${tool}`).toBe(true);
    }
  });

  describe("offerBooking", () => {
    const plan: Plan = {
      requirements: { source: "Chennai", destination: "Goa", start_date: "2026-11-05", num_days: 3, num_travellers: 2 },
      flightsResult: {
        selected: { option: "IndiGo 6E-123", provider: "IndiGo", approx_fare: "₹5000", links: [{ title: "ixigo", url: "https://out" }] },
      },
      placesResult: {},
      itinerary: {},
      budget: {},
    };
    const withReturn: Plan = {
      ...plan,
      flightsResult: {
        ...plan.flightsResult,
        selected_return: { option: "Volvo Bus", provider: "RedBus", approx_fare: "₹900", estimated: true, booking_url: "https://back" },
        return_date: "2026-11-07",
      },
    };
    const user = { id: "u1", role: "user" as const };
    const admin = { id: "a1", role: "admin" as const };
    const output = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.map((c) => String(c[0])).join("\n");

    beforeEach(() => {
      mail.configured = false;
      mail.send.mockClear();
    });

    it("tells a user to login as admin and asks nothing", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const hitl = new Hitl(["yes"]);
      const askSpy = vi.spyOn(hitl, "askYesNo");

      expect(await offerBooking(user, hitl, plan)).toBeNull();
      expect(askSpy).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining("Login as admin"));
      log.mockRestore();
    });

    it("books for an admin who says yes, with the outbound leg in the details and the box", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const booking = await offerBooking(admin, new Hitl(["yes"]), plan);
      expect(booking?.success).toBe(true);
      expect(booking?.booking_reference).toMatch(/^TRANSPORT-BK-/);
      expect(booking?.details).toMatchObject({
        destination: "Goa",
        travellers: 2,
        trip: { start: "2026-11-05", end: "2026-11-07" },
        legs: [{ label: "Outbound", route: "Chennai → Goa", date: "2026-11-05", option: "IndiGo 6E-123 via IndiGo", fare: "₹5000", links: [{ title: "ixigo", url: "https://out" }] }],
      });
      expect(output(log)).toContain("Option      : IndiGo 6E-123 via IndiGo");
      expect(output(log)).toContain("Approx Fare : ₹5000");
      log.mockRestore();
    });

    it("books both legs, and shows both in the booking box, when a return was chosen", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const booking = await offerBooking(admin, new Hitl(["yes"]), withReturn);
      expect(booking?.details.legs).toHaveLength(2);
      expect(booking?.details.legs[1]).toMatchObject({
        label: "Return",
        route: "Goa → Chennai",
        date: "2026-11-07",
        option: "Volvo Bus via RedBus",
        fare: "~₹900",
        links: [{ title: "Book", url: "https://back" }],
      });
      const box = output(log);
      expect(box).toContain("Outbound    : IndiGo 6E-123 via IndiGo — ₹5000");
      expect(box).toContain("Return      : Volvo Bus via RedBus — ~₹900");
      log.mockRestore();
    });

    it("books nothing for an admin who says no", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      mail.configured = true;
      expect(await offerBooking(admin, new Hitl(["no"]), plan)).toBeNull();
      expect(mail.send).not.toHaveBeenCalled();
      log.mockRestore();
    });

    describe("the confirmation email", () => {
      beforeEach(() => {
        mail.configured = true;
        vi.spyOn(console, "log").mockImplementation(() => {});
      });
      afterEach(() => vi.restoreAllMocks());

      it("sends the booking, both legs, to the address the admin types", async () => {
        const booking = await offerBooking(admin, new Hitl(["yes", "me@example.com"]), withReturn);
        expect(mail.send).toHaveBeenCalledTimes(1);
        const [to, details, reference] = mail.send.mock.calls[0] as [string, BookingDetails, string];
        expect(to).toBe("me@example.com");
        expect(details.legs.map((l) => l.label)).toEqual(["Outbound", "Return"]);
        expect(reference).toBe(booking?.booking_reference);
        expect(booking?.email).toEqual({ sent: true, to: "me@example.com" });
      });

      it("sends nothing when the admin presses Enter", async () => {
        const booking = await offerBooking(admin, new Hitl(["yes", ""]), plan);
        expect(mail.send).not.toHaveBeenCalled();
        expect(booking?.success).toBe(true);
        expect(booking?.email).toEqual({ sent: false, reason: "skipped" });
      });

      it("asks again after an address that is not valid", async () => {
        const hitl = new Hitl(["yes", "not-an-email", "me@example.com"]);
        const ask = vi.spyOn(hitl, "askUser");
        await offerBooking(admin, hitl, plan);
        expect(ask).toHaveBeenCalledTimes(2);
        expect(String(ask.mock.calls[1][0])).toContain("not a valid email address");
        expect(mail.send.mock.calls[0][0]).toBe("me@example.com");
      });

      it("gives up after three invalid addresses", async () => {
        const booking = await offerBooking(admin, new Hitl(["yes", "a", "b", "c"]), plan);
        expect(mail.send).not.toHaveBeenCalled();
        expect(booking?.email).toEqual({ sent: false, reason: "skipped" });
      });

      it("keeps the booking when the email fails, and says why", async () => {
        mail.send.mockRejectedValueOnce(new Error("Invalid login"));
        const log = vi.spyOn(console, "log").mockImplementation(() => {});
        const booking = await offerBooking(admin, new Hitl(["yes", "me@example.com"]), plan);
        expect(booking?.success).toBe(true);
        expect(booking?.email).toEqual({ sent: false, reason: "send_failed", error: "Invalid login" });
        expect(output(log)).toContain("Booked, but the email could not be sent: Invalid login");
      });

      it("asks nothing and sends nothing for a normal user", async () => {
        const hitl = new Hitl(["yes", "me@example.com"]);
        expect(await offerBooking(user, hitl, plan)).toBeNull();
        expect(mail.send).not.toHaveBeenCalled();
      });
    });

    it("does not ask for an address when email is not set up", async () => {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const hitl = new Hitl(["yes"]);
      const ask = vi.spyOn(hitl, "askUser");
      const booking = await offerBooking(admin, hitl, plan);
      expect(ask).not.toHaveBeenCalled();
      expect(booking?.email).toEqual({ sent: false, reason: "not_configured" });
      expect(output(log)).toContain("Email is not set up");
      log.mockRestore();
    });
  });

  it("formatWeatherBox renders a rich forecast breakdown", () => {
    const weatherData = {
      destination: "Munnar",
      days: [
        { date: "2026-10-02", condition: "Heavy rain", temp: "14°C – 20°C", rain_pct: 85 },
        { date: "2026-10-03", condition: "Moderate rain", temp: "15°C – 21°C", rain_pct: 60 },
        { date: "2026-10-04", condition: "Clear sky", temp: "17°C – 24°C", rain_pct: 10 },
      ],
    };

    const box = formatWeatherBox(weatherData);

    expect(box).toContain("Weather Forecast Notice");
    expect(box).toContain("Munnar");
    expect(box).toContain("2026-10-02");
    expect(box).toContain("[⚠️ BAD WEATHER]");
  });
});
