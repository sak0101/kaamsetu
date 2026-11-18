import { z } from "zod";
import { ApiError } from "./errors";

// Every object schema is .strict(): unknown keys (user_id, employer_id, p_actor, role, ...)
// are rejected, never silently accepted. The acting user is never part of any input.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const uuid = z.string().regex(UUID_RE, "Must be a valid id");
const smallId = z.number().int().min(1).max(32767);

/** Query-string numbers arrive as strings. */
const queryInt = (min: number, max: number) => z.coerce.number().int().min(min).max(max);

export const idParams = z.object({ id: uuid }).strict();

export const profileUpdateBody = z
  .object({
    full_name: z.string().trim().min(2).max(80),
    preferred_language: z.enum(["en", "hi", "gu"]),
    org_name: z.string().trim().max(100).nullable().optional(),
  })
  .strict();

export const workerProfileBody = z
  .object({
    bio: z.string().trim().max(500).nullable().optional(),
    years_experience: z.number().int().min(0).max(60).nullable().optional(),
    locality_id: smallId,
    is_available: z.boolean().optional(),
    category_ids: z.array(smallId).max(5).optional(),
    skills: z.array(z.string().trim().min(2).max(40)).max(8).optional(),
    availability_note: z.string().trim().max(120).nullable().optional(),
  })
  .strict();

const isoWithOffset = z.string().datetime({ offset: true, message: "Use an ISO-8601 time with an offset, e.g. 2026-11-21T09:00:00+05:30" });

export const createJobBody = z
  .object({
    category_id: smallId,
    locality_id: smallId,
    title: z.string().trim().min(5).max(100),
    description: z.string().trim().min(1).max(1000),
    starts_at: isoWithOffset,
    ends_at: isoWithOffset,
    workers_needed: z.number().int().min(1).max(50),
    pay_type: z.enum(["daily", "hourly", "fixed"]),
    /** Integer paise (INR). Maximum INR 50,000. */
    pay_amount_paise: z.number().int().min(1).max(5_000_000),
  })
  .strict()
  .refine((b) => Date.parse(b.ends_at) > Date.parse(b.starts_at), {
    path: ["ends_at"],
    message: "ends_at must be after starts_at",
  });

export const pageQuery = {
  limit: queryInt(1, 50).default(20),
  offset: queryInt(0, 10_000).default(0),
};

export const browseJobsQuery = z
  .object({
    locality_id: queryInt(1, 32767).optional(),
    category_id: queryInt(1, 32767).optional(),
    ...pageQuery,
  })
  .strict();

export const pageOnlyQuery = z.object({ ...pageQuery }).strict();

export const notificationsQuery = z
  .object({ unread: z.enum(["true", "false"]).optional(), ...pageQuery })
  .strict();

export const contactBody = z.object({ phone: z.string().trim().max(20).nullable() }).strict();

export const applyBody = z.object({ message: z.string().trim().max(300).optional() }).strict();
export const rejectBody = z.object({ reason: z.string().trim().max(100).optional() }).strict();
export const cancelBody = z.object({ reason: z.string().trim().max(200).optional() }).strict();
export const markReadBody = z.object({ ids: z.array(uuid).min(1).max(100).optional() }).strict();

export function parse<S extends z.ZodType>(schema: S, data: unknown): z.infer<S> {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new ApiError(
      422,
      "validation_error",
      "The request is invalid.",
      result.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
    );
  }
  return result.data;
}

export const aiDraftBody = z
  .object({
    text: z.string().trim().min(10, "Describe the job in a sentence or two.").max(1500, "Please keep it under 1500 characters."),
    answers: z
      .array(
        z
          .object({ question: z.string().trim().min(1).max(300), answer: z.string().trim().min(1).max(500) })
          .strict(),
      )
      .max(10)
      .optional(),
  })
  .strict();
