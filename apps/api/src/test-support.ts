// Test-only helpers (never imported by index.ts, so never bundled into server.js).
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp } from "./app";
import type {
  ApplicationRow,
  BookingRow,
  Deps,
  EmployerName,
  JobRow,
  NotificationRow,
  Page,
  ProfileRow,
  Reads,
  RpcName,
  RpcResult,
} from "./types";

export const EMPLOYER_ID = randomUUID();
export const WORKER_ID = randomUUID();
export const OTHER_ID = randomUUID();
export const NOPROFILE_ID = randomUUID();
export const JOB_ID = randomUUID();
export const APP_ID = randomUUID();
export const BOOKING_ID = randomUUID();

export const TOKENS: Record<string, string> = {
  "tok-employer": EMPLOYER_ID,
  "tok-worker": WORKER_ID,
  "tok-noprofile": NOPROFILE_ID,
};

const now = "2026-11-20T10:00:00+00:00";
export const profile = (id: string, role: "worker" | "employer", name: string): ProfileRow => ({
  id,
  role,
  full_name: name,
  org_name: null,
  preferred_language: "en",
  created_at: now,
  updated_at: now,
});

export const sampleJob = (over: Partial<JobRow> = {}): JobRow => ({
  id: JOB_ID,
  employer_id: EMPLOYER_ID,
  category_id: 1,
  locality_id: 1,
  title: "Move a sofa set",
  description: "Two flights of stairs",
  starts_at: "2026-11-25T09:00:00+00:00",
  ends_at: "2026-11-25T13:00:00+00:00",
  workers_needed: 2,
  pay_type: "daily",
  pay_amount_paise: 90000,
  status: "open",
  positions_filled: 0,
  cancelled_reason: null,
  created_at: now,
  ...over,
});

export interface FakeState {
  verifyCalls: string[];
  rpcCalls: { fn: RpcName; args: Record<string, unknown> }[];
  readCalls: { method: string; arg?: unknown }[];
  rpcResults: Partial<Record<RpcName, RpcResult>>;
  verifyError?: Error;
  jobs: JobRow[];
  application: ApplicationRow | null;
  bookings: BookingRow[];
  notifications: NotificationRow[];
  contacts: Record<string, string>;
}

export function makeFake(): { deps: Deps; state: FakeState } {
  const profiles = new Map<string, ProfileRow>([
    [EMPLOYER_ID, profile(EMPLOYER_ID, "employer", "Employer One")],
    [WORKER_ID, profile(WORKER_ID, "worker", "Worker One")],
  ]);
  const state: FakeState = {
    verifyCalls: [],
    rpcCalls: [],
    readCalls: [],
    rpcResults: {},
    jobs: [sampleJob()],
    application: null,
    bookings: [],
    notifications: [],
    contacts: {},
  };
  const note = (method: string, arg?: unknown) => state.readCalls.push({ method, arg });

  const reads: Reads = {
    async profile(userId) {
      note("profile", userId);
      return profiles.get(userId) ?? null;
    },
    async workerProfile(userId) {
      note("workerProfile", userId);
      return {
        profile: { user_id: userId, bio: "Strong", years_experience: 3, locality_id: 1, is_available: true, skills: ["Guest handling"], availability_note: "Weekends" },
        category_ids: [1, 2],
      };
    },
    async categories() {
      return [{ id: 1, slug: "loading_unloading", name_en: "Loading", name_hi: "x", name_gu: "y" }];
    },
    async localities() {
      return [{ id: 1, city: "Vadodara", name: "Alkapuri" }];
    },
    async openJobs(filter) {
      note("openJobs", filter);
      return state.jobs;
    },
    async employerJobs(userId, page: Page) {
      note("employerJobs", { userId, ...page });
      return state.jobs;
    },
    async job(id) {
      note("job", id);
      return state.jobs.find((j) => j.id === id) ?? null;
    },
    async jobsByIds(ids) {
      return state.jobs.filter((j) => ids.includes(j.id));
    },
    async employerNames(ids): Promise<EmployerName[]> {
      return ids.includes(EMPLOYER_ID) ? [{ id: EMPLOYER_ID, full_name: "Employer One", org_name: null }] : [];
    },
    async workerApplications(userId, page) {
      note("workerApplications", { userId, ...page });
      return state.application ? [state.application] : [];
    },
    async applicationForJob(jobId, workerId) {
      note("applicationForJob", { jobId, workerId });
      return state.application;
    },
    async booking(id) {
      note("booking", id);
      return state.bookings.find((b) => b.id === id) ?? null;
    },
    async contact(userId) {
      note("contact", userId);
      return state.contacts[userId] ? { phone: state.contacts[userId]! } : null;
    },
    async bookings(page) {
      note("bookings", page);
      return state.bookings;
    },
    async notifications(filter) {
      note("notifications", filter);
      return state.notifications;
    },
  };

  const defaults: Record<RpcName, unknown> = {
    update_profile: null,
    save_worker_profile: null,
    save_contact: null,
    create_job: JOB_ID,
    cancel_job: null,
    apply_to_job: APP_ID,
    withdraw_application: null,
    reject_application: null,
    accept_application: BOOKING_ID,
    cancel_booking: null,
    mark_notifications_read: 2,
    get_applicant_signals: [
      {
        application_id: APP_ID,
        worker_id: WORKER_ID,
        worker_name: "Worker One",
        application_status: "pending",
        applied_at: now,
        message: null,
        category_match: true,
        locality_match: "same_locality",
        years_experience: null,
        has_booking_conflict: false,
        bio: null,
        skills: [],
        availability_note: null,
        member_since: now,
        completed_jobs: 0,
      },
    ],
  };

  const deps: Deps = {
    async verifyJwt(jwt) {
      state.verifyCalls.push(jwt);
      if (state.verifyError) throw state.verifyError;
      const id = TOKENS[jwt];
      return id ? { id } : null;
    },
    async rpc(fn, args) {
      state.rpcCalls.push({ fn, args });
      return state.rpcResults[fn] ?? { data: defaults[fn], error: null };
    },
    readsFor() {
      return reads;
    },
  };
  return { deps, state };
}

export async function startApp(deps: Deps) {
  const server = createApp({ deps }).listen(0);
  await new Promise((resolve) => server.once("listening", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(
    method: string,
    path: string,
    opts: { token?: string; body?: unknown; rawBody?: string; headers?: Record<string, string> } = {},
  ) {
    const headers: Record<string, string> = { ...opts.headers };
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    let body: string | undefined;
    if (opts.rawBody !== undefined) {
      body = opts.rawBody;
      headers["content-type"] = "application/json";
    } else if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["content-type"] = "application/json";
    }
    const res = await fetch(`${base}${path}`, { method, headers, body });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* not json (204 etc.) */
    }
    return { status: res.status, json, text, headers: res.headers };
  }

  return { call, close: () => server.close() };
}
