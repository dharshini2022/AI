import { describe, expect, it } from "vitest";
import {
  ExtractedRequirementsSchema,
  isValidFutureDate,
  parseAndValidateField,
  REQUIRED_FIELDS,
  validateRequirements,
} from "../travel_agent/validation.ts";

describe("Validation Module", () => {
  describe("isValidFutureDate", () => {
    it("rejects invalid date formats", () => {
      expect(isValidFutureDate("invalid")).toBe(false);
      expect(isValidFutureDate("2026/09/10")).toBe(false);
      expect(isValidFutureDate("2026-9-1")).toBe(false);
      expect(isValidFutureDate("2026-02-30")).toBe(false); // Non-existent date
    });

    it("rejects past dates", () => {
      expect(isValidFutureDate("2020-01-01")).toBe(false);
      expect(isValidFutureDate("2024-02-15")).toBe(false);
    });

    it("accepts future valid dates", () => {
      const futureYear = new Date().getFullYear() + 1;
      expect(isValidFutureDate(`${futureYear}-06-15`)).toBe(true);
    });
  });

  describe("validateRequirements", () => {
    const futureDate = `${new Date().getFullYear() + 1}-06-15`;

    it("accepts valid trip requirements", () => {
      const valid = {
        source: "Chennai",
        destination: "Coimbatore",
        start_date: futureDate,
        num_days: 3,
        num_travellers: 2,
        interests: ["temples", "nature"],
        budget: 25000,
      };
      const result = validateRequirements(valid);
      expect(result.source).toBe("Chennai");
      expect(result.destination).toBe("Coimbatore");
      expect(result.num_days).toBe(3);
    });

    it("throws error for past start_date", () => {
      const invalid = {
        source: "Chennai",
        destination: "Coimbatore",
        start_date: "2024-01-01",
        num_days: 3,
        num_travellers: 2,
      };
      expect(() => validateRequirements(invalid)).toThrow("cannot be in the past");
    });

    it("throws error for invalid num_days or travellers", () => {
      expect(() =>
        validateRequirements({
          source: "Chennai",
          destination: "Coimbatore",
          start_date: futureDate,
          num_days: 0,
          num_travellers: 1,
        }),
      ).toThrow("Trip duration must be at least 1 day");

      expect(() =>
        validateRequirements({
          source: "Chennai",
          destination: "Coimbatore",
          start_date: futureDate,
          num_days: 3,
          num_travellers: 0,
        }),
      ).toThrow("Number of travellers must be at least 1");
    });
  });

  describe("REQUIRED_FIELDS", () => {
    it("is exactly the fields with no default and no nullable/optional wrapper", () => {
      expect(REQUIRED_FIELDS.sort()).toEqual(["destination", "num_days", "num_travellers", "source", "start_date"]);
    });
  });

  describe("ExtractedRequirementsSchema", () => {
    it("leaves an omitted interests field missing, instead of filling in the schema's default", () => {
      const parsed = ExtractedRequirementsSchema.parse({ destination: "Goa" });
      expect(parsed).not.toHaveProperty("interests");
    });

    it("keeps an explicitly empty interests list or a null budget as given", () => {
      const parsed = ExtractedRequirementsSchema.parse({ destination: "Goa", interests: [], budget: null });
      expect(parsed.interests).toEqual([]);
      expect(parsed.budget).toBeNull();
    });

    it("accepts an exclude list", () => {
      const parsed = ExtractedRequirementsSchema.parse({ destination: "Goa", exclude: ["temples"] });
      expect(parsed.exclude).toEqual(["temples"]);
    });
  });

  describe("parseAndValidateField", () => {
    const futureDate = `${new Date().getFullYear() + 1}-06-15`;

    it("converts and checks a typed answer with the same rules as TripRequirementsSchema", () => {
      expect(parseAndValidateField("num_days", "3")).toEqual({ ok: true, value: 3 });
      expect(parseAndValidateField("num_days", "0").ok).toBe(false);
      expect(parseAndValidateField("num_days", "abc").ok).toBe(false);
      expect(parseAndValidateField("start_date", futureDate)).toEqual({ ok: true, value: futureDate });
      expect(parseAndValidateField("start_date", "2020-01-01").ok).toBe(false);
    });

    it("treats a blank budget as no limit and a blank interests/exclude as an empty list", () => {
      expect(parseAndValidateField("budget", "")).toEqual({ ok: true, value: null });
      expect(parseAndValidateField("interests", "")).toEqual({ ok: true, value: [] });
      expect(parseAndValidateField("exclude", "")).toEqual({ ok: true, value: [] });
    });

    it("parses a comma list for interests and exclude", () => {
      expect(parseAndValidateField("interests", "temples, nature")).toEqual({ ok: true, value: ["temples", "nature"] });
      expect(parseAndValidateField("exclude", "seafood, museums")).toEqual({ ok: true, value: ["seafood", "museums"] });
    });
  });
});
