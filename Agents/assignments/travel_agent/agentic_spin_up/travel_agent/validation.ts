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
