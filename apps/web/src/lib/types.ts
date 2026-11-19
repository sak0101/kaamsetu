// Response shapes of the KaamSetu Express API (see docs/api.md and apps/api/src/types.ts).

export type Role = "worker" | "employer";

export interface Profile {
  id: string;
  role: Role;
  full_name: string;
  org_name: string | null;
  preferred_language: "en" | "hi" | "gu";
  created_at: string;
  updated_at: string;
}

export interface WorkerProfile {
  user_id?: string;
  bio?: string | null;
  years_experience?: number | null;
  locality_id?: number | null;
  is_available?: boolean;
  skills?: string[];
  availability_note?: string | null;
  category_ids: number[];
}

export interface MeResponse {
  profile: Profile;
  worker: WorkerProfile | null;
}

export interface Category {
  id: number;
  slug: string;
  name_en: string;
  name_hi: string;
  name_gu: string;
}

export interface Locality {
  id: number;
  city: string;
  name: string;
}

export interface EmployerInfo {
  full_name: string;
  org_name: string | null;
}

export type PayType = "daily" | "hourly" | "fixed";
export type JobStatus = "open" | "filled" | "cancelled";

export interface Job {
  id: string;
  employer_id: string;
  category_id: number;
  locality_id: number;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  workers_needed: number;
  pay_type: PayType;
  pay_amount_paise: number;
  status: JobStatus;
  positions_filled: number;
  cancelled_reason: string | null;
  created_at: string;
  employer?: EmployerInfo | null;
}

export type ApplicationStatus = "pending" | "accepted" | "rejected" | "withdrawn";

export interface Application {
  id: string;
  job_id: string;
  worker_id: string;
  status: ApplicationStatus;
  status_reason: string | null;
  message: string | null;
  decided_at: string | null;
  created_at: string;
  job?: Job | null;
}

export interface Booking {
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
  job?: Job | null;
}

/** One row of GET /api/jobs/:id/applicants: facts only, never a score or rating. */
export interface Applicant {
  application_id: string;
  worker_id: string;
  worker_name: string;
  application_status: ApplicationStatus;
  applied_at: string;
  message: string | null;
  category_match: boolean;
  locality_match: "same_locality" | "different_locality" | "unknown";
  years_experience: number | null;
  has_booking_conflict: boolean;
  bio: string | null;
  skills: string[];
  availability_note: string | null;
  member_since: string;
  completed_jobs: number;
  /** Facts from completed bookings (0 / null for every new worker; never a penalty). */
  no_show_count: number;
  review_count: number;
  avg_rating: number | null;
  fit: Fit;
}

/** The exact address of a job. The API only returns it to the owning employer and to a worker with a live booking. */
export interface JobLocation {
  address_line: string;
  landmark: string | null;
}

export interface Review {
  id: string;
  booking_id: string;
  reviewer_id: string;
  reviewee_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
}

/** Transparent fit summary from the API: facts only; missing data is excluded, never counted as zero. */
export interface Fit {
  percent: number;
  label: "Strong match" | "Good match" | "Partial match" | "Weak match";
  reasons: string[];
  notes: string[];
  signals_used: string[];
  signals_excluded: string[];
  has_conflict: boolean;
}

export interface NotificationItem {
  id: string;
  type: "new_application" | "application_rejected" | "booking_confirmed" | "booking_cancelled" | string;
  entity_type: string;
  entity_id: string;
  payload: { job_id?: string; job_title?: string; reason?: string | null; cancelled_by?: string; booking_id?: string };
  read_at: string | null;
  created_at: string;
}

export interface PageParams {
  limit?: number;
  offset?: number;
}

export const PAGE_SIZE = 20;
