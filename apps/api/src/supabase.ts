import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { SupabaseConfig } from "./config";
import { ApiError, mapDbError } from "./errors";
import type {
  ApplicationRow,
  BookingRow,
  CategoryRow,
  Deps,
  EmployerName,
  JobRow,
  LocalityRow,
  JobLocationRow,
  JobSearch,
  NotificationRow,
  Page,
  ProfileRow,
  Reads,
  ReviewRow,
  RpcName,
  WorkerProfileRow,
} from "./types";

const CLIENT_OPTIONS = { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } };

// Explicit column lists. `profiles` is column-restricted by grants, so select=* would be denied by design.
const PROFILE_COLS = "id,role,full_name,org_name,preferred_language,created_at,updated_at";
const WORKER_COLS = "user_id,bio,years_experience,locality_id,is_available,skills,availability_note";
const JOB_COLS =
  "id,employer_id,category_id,locality_id,title,description,starts_at,ends_at,workers_needed,pay_type,pay_amount_paise,status,positions_filled,cancelled_reason,created_at";
const APPLICATION_COLS = "id,job_id,worker_id,status,status_reason,message,decided_at,created_at";
const BOOKING_COLS =
  "id,job_id,application_id,worker_id,employer_id,agreed_pay_paise,status,cancelled_by,cancelled_at,cancel_reason,completed_at,created_at";
const REVIEW_COLS = "id,booking_id,reviewer_id,reviewee_id,rating,comment,created_at";
const NOTIFICATION_COLS = "id,type,entity_type,entity_id,payload,read_at,created_at";

function unwrap<T>(res: { data: T | null; error: { code?: string; message: string } | null }): T | null {
  if (res.error) throw mapDbError(res.error);
  return res.data;
}

/** Next calendar day of a YYYY-MM-DD string (pure date arithmetic, no time zone involved). */
export function nextDay(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Words safe to embed in a PostgREST filter: every character that carries meaning in the filter grammar or in
 * LIKE patterns is replaced by a space, so user text can never add conditions. At most 4 words of 2+ characters.
 */
export function searchWords(text: string | undefined): string[] {
  if (!text) return [];
  return text
    .replace(/[^\p{L}\p{M}\p{N}\s-]/gu, " ") // \p{M}: Hindi and Gujarati vowel signs and the virama are combining marks
    .split(/\s+/)
    .filter((w) => w.length >= 2)
    .slice(0, 4);
}

const range = (p: Page) => [p.offset, p.offset + p.limit - 1] as const;

/** User-scoped reads: the client carries the caller's JWT, so Postgres RLS decides what is visible. */
export function createReads(client: SupabaseClient): Reads {
  return {
    async profile(userId) {
      return unwrap(await client.from("profiles").select(PROFILE_COLS).eq("id", userId).maybeSingle()) as ProfileRow | null;
    },

    async workerProfile(userId) {
      const wp = unwrap(
        await client.from("worker_profiles").select(WORKER_COLS).eq("user_id", userId).maybeSingle(),
      ) as WorkerProfileRow | null;
      const cats = unwrap(await client.from("worker_categories").select("category_id").eq("worker_id", userId)) as
        | { category_id: number }[]
        | null;
      return { profile: wp, category_ids: (cats ?? []).map((c) => c.category_id).sort((a, b) => a - b) };
    },

    async categories() {
      return (unwrap(
        await client.from("work_categories").select("id,slug,name_en,name_hi,name_gu").eq("is_active", true).order("id"),
      ) ?? []) as CategoryRow[];
    },

    async localities() {
      return (unwrap(
        await client.from("localities").select("id,city,name").eq("is_active", true).order("name"),
      ) ?? []) as LocalityRow[];
    },

    async openJobs({ localityId, categoryId, q: text, dateFrom, dateTo, minHours, maxHours, ...page }: Page & JobSearch) {
      let q = client
        .from("jobs")
        .select(JOB_COLS)
        .eq("status", "open")
        .gt("starts_at", new Date().toISOString())
        .order("starts_at", { ascending: true })
        .order("id", { ascending: true });
      if (localityId !== undefined) q = q.eq("locality_id", localityId);
      if (categoryId !== undefined) q = q.eq("category_id", categoryId);
      // IST calendar days, inclusive: [dateFrom 00:00, dateTo + 1 day 00:00).
      if (dateFrom) q = q.gte("starts_at", `${dateFrom}T00:00:00+05:30`);
      if (dateTo) q = q.lt("starts_at", `${nextDay(dateTo)}T00:00:00+05:30`);
      // Duration filters use the generated column from migration 13, so they are only referenced when asked for.
      if (minHours !== undefined) q = q.gte("duration_minutes", minHours * 60);
      if (maxHours !== undefined) q = q.lte("duration_minutes", maxHours * 60);
      // Every word must match the title, the description or the employer's name (AND across words, OR across fields).
      for (const word of searchWords(text)) {
        const employers = (unwrap(await client.from("profiles").select("id").or(`full_name.ilike.%${word}%,org_name.ilike.%${word}%`).limit(50)) ?? []) as { id: string }[];
        const parts = [`title.ilike.%${word}%`, `description.ilike.%${word}%`];
        if (employers.length) parts.push(`employer_id.in.(${employers.map((e) => e.id).join(",")})`);
        q = q.or(parts.join(","));
      }
      return (unwrap(await q.range(...range(page))) ?? []) as JobRow[];
    },

    async jobLocation(jobId) {
      return unwrap(await client.from("job_locations").select("address_line,landmark").eq("job_id", jobId).maybeSingle()) as JobLocationRow | null;
    },

    async reviews() {
      return (unwrap(await client.from("booking_reviews").select(REVIEW_COLS).order("created_at", { ascending: false }).limit(200)) ?? []) as ReviewRow[];
    },

    async employerJobs(userId, page) {
      return (unwrap(
        await client
          .from("jobs")
          .select(JOB_COLS)
          .eq("employer_id", userId)
          .order("starts_at", { ascending: false })
          .order("id", { ascending: true })
          .range(...range(page)),
      ) ?? []) as JobRow[];
    },

    async job(id) {
      return unwrap(await client.from("jobs").select(JOB_COLS).eq("id", id).maybeSingle()) as JobRow | null;
    },

    async jobsByIds(ids) {
      if (ids.length === 0) return [];
      return (unwrap(await client.from("jobs").select(JOB_COLS).in("id", ids)) ?? []) as JobRow[];
    },

    async employerNames(ids) {
      if (ids.length === 0) return [];
      return (unwrap(await client.from("profiles").select("id,full_name,org_name").in("id", ids)) ?? []) as EmployerName[];
    },

    async workerApplications(userId, page) {
      return (unwrap(
        await client
          .from("job_applications")
          .select(APPLICATION_COLS)
          .eq("worker_id", userId)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(...range(page)),
      ) ?? []) as ApplicationRow[];
    },

    async applicationForJob(jobId, workerId) {
      return unwrap(
        await client.from("job_applications").select(APPLICATION_COLS).eq("job_id", jobId).eq("worker_id", workerId).maybeSingle(),
      ) as ApplicationRow | null;
    },

    async booking(id) {
      return unwrap(await client.from("bookings").select(BOOKING_COLS).eq("id", id).maybeSingle()) as BookingRow | null;
    },

    async contact(userId) {
      return unwrap(await client.from("contact_details").select("phone").eq("user_id", userId).maybeSingle()) as { phone: string } | null;
    },

    async bookings(page) {
      return (unwrap(
        await client
          .from("bookings")
          .select(BOOKING_COLS)
          .order("created_at", { ascending: false })
          .order("id", { ascending: true })
          .range(...range(page)),
      ) ?? []) as BookingRow[];
    },

    async notifications({ unreadOnly, ...page }) {
      let q = client
        .from("notifications")
        .select(NOTIFICATION_COLS)
        .order("created_at", { ascending: false })
        .order("id", { ascending: true });
      if (unreadOnly) q = q.is("read_at", null);
      return (unwrap(await q.range(...range(page))) ?? []) as NotificationRow[];
    },
  };
}

function isUpstreamAuthFailure(error: { name?: string; status?: number }): boolean {
  return error.name === "AuthRetryableFetchError" || (typeof error.status === "number" && error.status >= 500);
}

/**
 * Real dependencies. THREE distinct clients, never mixed:
 *   authClient    (anon key)         : only auth.getUser(jwt)
 *   serviceClient (service-role key) : only rpc() on the allow-listed functions
 *   per-request user client (anon key + the caller's JWT) : RLS-scoped reads
 * The service-role key never leaves this closure.
 */
export function createSupabaseDeps(cfg: SupabaseConfig): Deps {
  const authClient = createClient(cfg.url, cfg.anonKey, CLIENT_OPTIONS);
  const serviceClient = createClient(cfg.url, cfg.serviceRoleKey, CLIENT_OPTIONS);

  return {
    async verifyJwt(jwt) {
      const { data, error } = await authClient.auth.getUser(jwt);
      if (error) {
        if (isUpstreamAuthFailure(error)) {
          throw new ApiError(503, "auth_unavailable", "Authentication is temporarily unavailable.");
        }
        return null;
      }
      return data.user?.id ? { id: data.user.id } : null;
    },

    async rpc(fn: RpcName, args) {
      const { data, error } = await serviceClient.rpc(fn, args);
      return {
        data,
        error: error ? { code: error.code, message: error.message, details: error.details, hint: error.hint } : null,
      };
    },

    readsFor(jwt) {
      const userClient = createClient(cfg.url, cfg.anonKey, {
        ...CLIENT_OPTIONS,
        global: { headers: { Authorization: `Bearer ${jwt}` } },
      });
      return createReads(userClient);
    },
  };
}
