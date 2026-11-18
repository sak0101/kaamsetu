// Row shapes mirror supabase/migrations exactly (only columns that clients may SELECT).

export type Role = "worker" | "employer";

/** The ONLY database functions the API may call. Matches migration 09 / docs/database.md. */
export const RPC_NAMES = [
  "update_profile",
  "save_worker_profile",
  "save_contact",
  "create_job",
  "cancel_job",
  "apply_to_job",
  "withdraw_application",
  "reject_application",
  "accept_application",
  "cancel_booking",
  "mark_notifications_read",
  "get_applicant_signals",
] as const;
export type RpcName = (typeof RPC_NAMES)[number];

export interface RpcError {
  code?: string;
  message: string;
  details?: string | null;
  hint?: string | null;
}

export interface ProfileRow {
  id: string;
  role: Role;
  full_name: string;
  org_name: string | null;
  preferred_language: "en" | "hi" | "gu";
  created_at: string;
  updated_at: string;
}

export interface WorkerProfileRow {
  user_id: string;
  bio: string | null;
  years_experience: number | null;
  locality_id: number | null;
  is_available: boolean;
  skills: string[];
  availability_note: string | null;
}

export interface CategoryRow {
  id: number;
  slug: string;
  name_en: string;
  name_hi: string;
  name_gu: string;
}

export interface LocalityRow {
  id: number;
  city: string;
  name: string;
}

export interface JobRow {
  id: string;
  employer_id: string;
  category_id: number;
  locality_id: number;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  workers_needed: number;
  pay_type: "daily" | "hourly" | "fixed";
  pay_amount_paise: number;
  status: "open" | "filled" | "cancelled";
  positions_filled: number;
  cancelled_reason: string | null;
  created_at: string;
}

export interface ApplicationRow {
  id: string;
  job_id: string;
  worker_id: string;
  status: "pending" | "accepted" | "rejected" | "withdrawn";
  status_reason: string | null;
  message: string | null;
  decided_at: string | null;
  created_at: string;
}

export interface BookingRow {
  id: string;
  job_id: string;
  application_id: string;
  worker_id: string;
  employer_id: string;
  agreed_pay_paise: number;
  status: string;
  cancelled_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface NotificationRow {
  id: string;
  type: string;
  entity_type: string;
  entity_id: string;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
}

export interface EmployerName {
  id: string;
  full_name: string;
  org_name: string | null;
}

export interface Page {
  limit: number;
  offset: number;
}

/** User-scoped reads. Every call runs with the caller's own JWT, so RLS applies. */
export interface Reads {
  profile(userId: string): Promise<ProfileRow | null>;
  workerProfile(userId: string): Promise<{ profile: WorkerProfileRow | null; category_ids: number[] }>;
  categories(): Promise<CategoryRow[]>;
  localities(): Promise<LocalityRow[]>;
  openJobs(filter: Page & { localityId?: number; categoryId?: number }): Promise<JobRow[]>;
  employerJobs(userId: string, page: Page): Promise<JobRow[]>;
  job(id: string): Promise<JobRow | null>;
  jobsByIds(ids: string[]): Promise<JobRow[]>;
  employerNames(ids: string[]): Promise<EmployerName[]>;
  workerApplications(userId: string, page: Page): Promise<ApplicationRow[]>;
  applicationForJob(jobId: string, workerId: string): Promise<ApplicationRow | null>;
  booking(id: string): Promise<BookingRow | null>;
  /** Phone number of `userId`, only if row-level security lets the caller see it (self, or the other side of a live booking). */
  contact(userId: string): Promise<{ phone: string } | null>;
  bookings(page: Page): Promise<BookingRow[]>;
  notifications(filter: Page & { unreadOnly: boolean }): Promise<NotificationRow[]>;
}

export interface RpcResult {
  data: unknown;
  error: RpcError | null;
}

/**
 * Everything the HTTP layer needs from Supabase. The real implementation is in
 * supabase.ts; unit tests inject fakes.
 */
import type { AiService } from "./ai";

export interface Deps {
  /** Wraps auth.getUser(jwt). Null = invalid/expired token. Throws ApiError(503) if Auth is unreachable. */
  verifyJwt(jwt: string): Promise<{ id: string } | null>;
  /** Privileged (service-role) RPC. Allow-listed functions only; p_actor is injected by the route layer. */
  rpc(fn: RpcName, args: Record<string, unknown>): Promise<RpcResult>;
  /** Fresh user-scoped read client for this JWT. */
  readsFor(jwt: string): Reads;
  /** AI job drafting (Claude, server-side only). Null/undefined when no API key is configured for it. */
  ai?: AiService | null;
}

/** Per-request context, derived ONLY from the verified JWT and the user's own profile row. */
export interface AuthContext {
  userId: string;
  jwt: string;
  role: Role;
  profile: ProfileRow;
  reads: Reads;
}
