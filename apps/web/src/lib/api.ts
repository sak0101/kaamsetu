import type {
  Applicant,
  Application,
  Booking,
  Category,
  Job,
  Locality,
  MeResponse,
  NotificationItem,
  PageParams,
  PayType,
  Profile,
  WorkerProfile,
} from "./types";

/** Error thrown for every non-2xx API response (and for network failures, with status 0). */
export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: { path: string; message: string }[],
  ) {
    super(message);
    this.name = "ApiError";
  }
}

type TokenProvider = () => Promise<string | null>;
let getToken: TokenProvider = async () => null;
let onUnauthorized: () => void = () => {};

/** Wired by AuthProvider: the access token always comes from the Supabase session. */
export function configureApi(opts: { getToken?: TokenProvider; onUnauthorized?: () => void }) {
  if (opts.getToken) getToken = opts.getToken;
  if (opts.onUnauthorized) onUnauthorized = opts.onUnauthorized;
}

type Query = Record<string, string | number | boolean | undefined | null>;

async function request<T>(method: string, path: string, opts: { body?: unknown; query?: Query; auth?: boolean } = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (opts.auth !== false) {
    const token = await getToken();
    if (token) headers.Authorization = `Bearer ${token}`;
  }
  let url = `/api${path}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  let body: string | undefined;
  if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }

  let res: Response;
  try {
    res = await fetch(url, { method, headers, body });
  } catch {
    throw new ApiError(0, "network_error", "Can't reach KaamSetu right now. Check your connection and try again.");
  }

  if (res.status === 204) return undefined as T;
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const e = json?.error;
    if (res.status === 401 && opts.auth !== false) onUnauthorized();
    throw new ApiError(res.status, e?.code ?? "error", e?.message ?? "Something went wrong. Please try again.", e?.details);
  }
  return json as T;
}

const page = (p: PageParams = {}): Query => ({ limit: p.limit, offset: p.offset });

export interface CreateJobInput {
  category_id: number;
  locality_id: number;
  title: string;
  description: string;
  starts_at: string;
  ends_at: string;
  workers_needed: number;
  pay_type: PayType;
  pay_amount_paise: number;
}

export interface AiDraftResult {
  draft: {
    title: string | null;
    category_id: number | null;
    locality_id: number | null;
    description: string | null;
    workers_needed: number | null;
    date: string | null;
    start_time: string | null;
    end_time: string | null;
    ends_next_day: boolean;
    pay_type: PayType | null;
    pay_amount_paise: number | null;
  };
  assumptions: { field: string; text: string }[];
  questions: { field: string; question: string }[];
  ready: boolean;
  missing_fields: string[];
}

export interface WorkerProfileInput {
  bio: string | null;
  years_experience: number | null;
  locality_id: number;
  is_available: boolean;
  category_ids: number[];
  skills: string[];
  availability_note: string | null;
}

/** One function per real endpoint in docs/api.md. Nothing else is called. */
export const api = {
  /** Public contact form (no sign-in). `website` is the honeypot: it must stay empty for real people. */
  sendContact: (body: { name: string; email: string; message: string; website?: string }) =>
    request<{ ok: true }>("POST", "/contact", { body, auth: false }),
  publicConfig: () => request<{ supabaseUrl: string; supabaseAnonKey: string }>("GET", "/public-config", { auth: false }),

  me: () => request<MeResponse>("GET", "/me"),
  updateProfile: (b: { full_name: string; preferred_language: Profile["preferred_language"]; org_name?: string | null }) =>
    request<{ profile: Profile }>("PUT", "/me/profile", { body: b }),
  saveWorkerProfile: (b: WorkerProfileInput) => request<{ worker: WorkerProfile }>("PUT", "/me/worker-profile", { body: b }),

  aiStatus: () => request<{ available: boolean }>("GET", "/ai/status"),
  aiJobDraft: (b: { text: string; answers?: { question: string; answer: string }[] }) =>
    request<AiDraftResult>("POST", "/ai/job-draft", { body: b }),

  categories: () => request<{ categories: Category[] }>("GET", "/categories"),
  localities: () => request<{ localities: Locality[] }>("GET", "/localities"),

  createJob: (b: CreateJobInput) => request<{ id: string }>("POST", "/jobs", { body: b }),
  browseJobs: (p: PageParams & { locality_id?: number; category_id?: number }) =>
    request<{ jobs: Job[]; page: { limit: number; offset: number } }>("GET", "/jobs", {
      query: { ...page(p), locality_id: p.locality_id, category_id: p.category_id },
    }),
  employerJobs: (p?: PageParams) => request<{ jobs: Job[]; page: { limit: number; offset: number } }>("GET", "/employer/jobs", { query: page(p) }),
  job: (id: string) => request<{ job: Job; my_application: Application | null }>("GET", `/jobs/${id}`),
  cancelJob: (id: string, reason?: string) => request<void>("POST", `/jobs/${id}/cancel`, { body: reason ? { reason } : {} }),

  apply: (jobId: string, message?: string) =>
    request<{ application_id: string }>("POST", `/jobs/${jobId}/applications`, { body: message ? { message } : {} }),
  myApplications: (p?: PageParams) => request<{ applications: Application[] }>("GET", "/me/applications", { query: page(p) }),
  withdraw: (applicationId: string) => request<void>("POST", `/applications/${applicationId}/withdraw`),

  applicants: (jobId: string) => request<{ applicants: Applicant[] }>("GET", `/jobs/${jobId}/applicants`),
  accept: (applicationId: string) => request<{ booking_id: string }>("POST", `/applications/${applicationId}/accept`),
  reject: (applicationId: string, reason?: string) =>
    request<void>("POST", `/applications/${applicationId}/reject`, { body: reason ? { reason } : {} }),

  myContact: () => request<{ phone: string | null }>("GET", "/me/contact"),
  saveContact: (phone: string | null) => request<{ phone: string | null }>("PUT", "/me/contact", { body: { phone } }),
  bookingContact: (bookingId: string) =>
    request<{ name: string | null; phone: string | null; shared: boolean }>("GET", `/bookings/${bookingId}/contact`),

  myBookings: (p?: PageParams) => request<{ bookings: Booking[] }>("GET", "/me/bookings", { query: page(p) }),
  cancelBooking: (id: string, reason?: string) => request<void>("POST", `/bookings/${id}/cancel`, { body: reason ? { reason } : {} }),

  notifications: (p?: PageParams & { unread?: boolean }) =>
    request<{ notifications: NotificationItem[] }>("GET", "/notifications", { query: { ...page(p), unread: p?.unread ? "true" : undefined } }),
  markRead: (ids?: string[]) => request<{ updated: number }>("POST", "/notifications/read", { body: ids ? { ids } : {} }),
};


export interface PhotoCredit {
  file: string;
  title: string;
  author: string;
  source_url: string;
  license: string;
  license_url: string;
  notes?: string;
}

/** Photo attributions: a static file shipped with the app (not an API endpoint). */
export async function fetchPhotoCredits(): Promise<PhotoCredit[]> {
  let res: Response;
  try {
    res = await fetch("/images/credits.json");
  } catch {
    throw new ApiError(0, "network_error", "Can't reach KaamSetu right now. Check your connection and try again.");
  }
  const type = res.headers.get("content-type") ?? "";
  if (!res.ok || !type.includes("json")) throw new ApiError(res.status, "error", "The photo credits could not be loaded.");
  return (await res.json()) as PhotoCredit[];
}
