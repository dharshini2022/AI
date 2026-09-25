import { z } from "zod";
import type { Dict } from "./tools/util.ts";

/**
 * Validates whether a date string is YYYY-MM-DD, a real calendar date,
 * and not in the past relative to the current local/system date.
 */
export function isValidFutureDate(dateStr: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return false;

  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);

  // Check valid calendar date (e.g., month/day rollover checks)
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return false;
  }

  // Today at midnight
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

  return date.getTime() >= today.getTime();
}

export const TripRequirementsSchema = z.object({
  source: z.string().min(1, "Source must not be empty"),
  destination: z.string().min(1, "Destination must not be empty"),
  start_date: z
    .string()
    .refine(
      (d) => isValidFutureDate(d),
      { message: "start_date must be a valid date in YYYY-MM-DD format and cannot be in the past." },
    ),
  num_days: z.number().int().min(1, "Trip duration must be at least 1 day").max(30, "Trip duration cannot exceed 30 days"),
  num_travellers: z.number().int().min(1, "Number of travellers must be at least 1"),
  interests: z.array(z.string()).default([]),
  budget: z.number().positive("Budget must be a positive number in INR").nullable().optional(),
});

export type ValidatedRequirements = z.infer<typeof TripRequirementsSchema>;

// Every field that has no default and isn't nullable/optional — what the intake loop must always ask for.
export const REQUIRED_FIELDS = Object.keys(TripRequirementsSchema.shape).filter(
  (key) => !TripRequirementsSchema.shape[key as keyof typeof TripRequirementsSchema.shape].isOptional(),
) as (keyof ValidatedRequirements)[];

// A missing field must stay missing (`.partial()` alone still fills in `interests`'s `.default([])`), so the
// intake loop can tell "the user didn't say" from "the user said an empty list" — see
// concepts/architecture/requirements-gathering.md.
export const ExtractedRequirementsSchema = TripRequirementsSchema.extend({ interests: z.array(z.string()) })
  .partial()
  .extend({
    exclude: z
      .array(z.string())
      .optional()
      .describe("Kinds of place or food the user said they do NOT want, e.g. ['temples']. Omit if not stated."),
  });
export type ExtractedRequirements = z.infer<typeof ExtractedRequirementsSchema>;

// The intake loop's own optional "anything to avoid?" answer, parsed the same way as any other field.
export const ExcludeSchema = z.array(z.string().min(1));

/**
 * Validates requirements dictionary. Returns validated object or throws descriptive Error.
 */
export function validateRequirements(req: Dict): ValidatedRequirements {
  const parsed = TripRequirementsSchema.safeParse(req);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => i.message).join("; ");
    throw new Error(`Invalid trip requirements: ${issues}`);
  }
  return parsed.data;
}

/**
 * Parses a single field's typed answer into the shape its schema expects, then checks it against that
 * schema — the same rules `TripRequirementsSchema` uses for the LLM's own extraction and the final save,
 * so a range or format only needs to change in one place.
 */
export function parseAndValidateField(
  field: string,
  raw: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = raw.trim();
  if ((field === "budget" || field === "interests" || field === "exclude") && !trimmed) {
    return { ok: true, value: field === "budget" ? null : [] };
  }

  let value: unknown;
  switch (field) {
    case "num_days":
    case "num_travellers":
      value = Number(trimmed);
      break;
    case "budget":
      value = Number(trimmed.replace(/[,₹]/g, ""));
      break;
    case "interests":
    case "exclude":
      value = trimmed.split(",").map((s) => s.trim()).filter(Boolean);
      break;
    default: // source, destination, start_date
      value = trimmed;
  }

  const schema = field === "exclude" ? ExcludeSchema : TripRequirementsSchema.shape[field as keyof ValidatedRequirements];
  if (!schema) return { ok: false, error: `Unknown field '${field}'.` };
  const result = schema.safeParse(value);
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: result.error.issues[0]?.message ?? `"${trimmed}" isn't valid.` };
}
