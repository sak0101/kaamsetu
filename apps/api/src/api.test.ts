import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { loadSupabaseConfig } from "./config";
import { ApiError } from "./errors";
import { RPC_NAMES } from "./types";
import {
  APP_ID,
  BOOKING_ID,
  EMPLOYER_ID,
  JOB_ID,
  NOPROFILE_ID,
  OTHER_ID,
  WORKER_ID,
  makeFake,
  sampleJob,
  startApp,
} from "./test-support";

const fake = makeFake();
let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp(fake.deps);
});
afterAll(() => app.close());
beforeEach(() => {
  const s = fake.state;
  s.verifyCalls.length = 0;
  s.rpcCalls.length = 0;
  s.readCalls.length = 0;
  s.rpcResults = {};
  s.verifyError = undefined;
  s.jobs = [sampleJob()];
  s.application = null;
  s.bookings = [];
  s.notifications = [];
  s.contacts = {};
});

const E = "tok-employer";
const W = "tok-worker";
const lastRpc = () => fake.state.rpcCalls.at(-1);

/** Every authenticated endpoint, with a valid request for its intended role. */
const ENDPOINTS: { method: string; path: string; role: "e" | "w" | "any"; body?: unknown }[] = [
  { method: "GET", path: "/api/me", role: "any" },
  { method: "PUT", path: "/api/me/profile", role: "any", body: { full_name: "New Name", preferred_language: "hi" } },
  { method: "PUT", path: "/api/me/worker-profile", role: "w", body: { locality_id: 1, category_ids: [1] } },
  { method: "GET", path: "/api/categories", role: "any" },
  { method: "GET", path: "/api/localities", role: "any" },
  { method: "POST", path: "/api/jobs", role: "e", body: validJob() },
  { method: "GET", path: "/api/jobs", role: "w" },
  { method: "GET", path: "/api/employer/jobs", role: "e" },
  { method: "GET", path: `/api/jobs/${JOB_ID}`, role: "any" },
  { method: "POST", path: `/api/jobs/${JOB_ID}/cancel`, role: "e", body: {} },
  { method: "POST", path: `/api/jobs/${JOB_ID}/applications`, role: "w", body: {} },
  { method: "GET", path: "/api/me/applications", role: "w" },
  { method: "POST", path: `/api/applications/${APP_ID}/withdraw`, role: "w" },
  { method: "GET", path: `/api/jobs/${JOB_ID}/applicants`, role: "e" },
  { method: "POST", path: `/api/applications/${APP_ID}/accept`, role: "e" },
  { method: "POST", path: `/api/applications/${APP_ID}/reject`, role: "e", body: {} },
  { method: "GET", path: "/api/me/bookings", role: "any" },
  { method: "POST", path: `/api/bookings/${BOOKING_ID}/cancel`, role: "any", body: {} },
  { method: "GET", path: "/api/notifications", role: "any" },
  { method: "POST", path: "/api/notifications/read", role: "any", body: {} },
  { method: "GET", path: `/api/jobs/${JOB_ID}/location`, role: "any" },
  { method: "PUT", path: `/api/jobs/${JOB_ID}/location`, role: "e", body: { address_line: "12 Race Course Circle" } },
  { method: "POST", path: `/api/bookings/${BOOKING_ID}/finish`, role: "e", body: { outcome: "completed" } },
  { method: "POST", path: `/api/bookings/${BOOKING_ID}/review`, role: "any", body: { rating: 5 } },
  { method: "GET", path: "/api/me/reviews", role: "any" },
];

function validJob(over: Record<string, unknown> = {}) {
  return {
    category_id: 1,
    locality_id: 1,
    title: "Move a sofa set",
    description: "Two flights of stairs",
    starts_at: "2026-11-25T09:00:00+05:30",
    ends_at: "2026-11-25T13:00:00+05:30",
    workers_needed: 2,
    pay_type: "daily",
    pay_amount_paise: 90000,
    ...over,
  };
}

describe("authentication", () => {
  it("keeps /api/health public", async () => {
    expect((await app.call("GET", "/api/health")).status).toBe(200);
  });

  it.each(ENDPOINTS)("rejects $method $path without a token", async ({ method, path, body }) => {
    const res = await app.call(method, path, { body });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("missing_token");
    expect(fake.state.verifyCalls).toHaveLength(0);
    expect(fake.state.rpcCalls).toHaveLength(0);
  });

  it.each([
    ["Basic scheme", "Basic dXNlcjpwYXNz"],
    ["empty bearer", "Bearer "],
    ["token with spaces", "Bearer abc def"],
    ["token with illegal characters", "Bearer abc;DROP"],
    ["oversized token", `Bearer ${"a".repeat(5000)}`],
  ])("rejects a malformed Authorization header (%s) without calling Supabase", async (_n, header) => {
    const res = await app.call("GET", "/api/me", { headers: { authorization: header } });
    expect(res.status).toBe(401);
    expect(fake.state.verifyCalls).toHaveLength(0);
  });

  it("rejects a token Supabase Auth does not accept", async () => {
    const res = await app.call("GET", "/api/me", { token: "tok-forged" });
    expect(res.status).toBe(401);
    expect(res.json.error.code).toBe("invalid_token");
  });

  it("verifies the exact bearer token through auth.getUser", async () => {
    await app.call("GET", "/api/me", { token: W });
    expect(fake.state.verifyCalls).toEqual([W]);
  });

  it("returns 503 when Supabase Auth is unreachable (not a misleading 401)", async () => {
    fake.state.verifyError = new ApiError(503, "auth_unavailable", "Authentication is temporarily unavailable.");
    const res = await app.call("GET", "/api/me", { token: W });
    expect(res.status).toBe(503);
    expect(res.json.error.code).toBe("auth_unavailable");
  });

  it("returns 403 for a valid user with no KaamSetu profile", async () => {
    fake.deps.verifyJwt = ((orig) => async (jwt: string) => (jwt === "tok-noprofile" ? { id: NOPROFILE_ID } : orig(jwt)))(
      fake.deps.verifyJwt,
    );
    const res = await app.call("GET", "/api/me", { token: "tok-noprofile" });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("profile_missing");
  });
});

describe("actor identity comes only from the verified token", () => {
  it("injects p_actor = verified user id on every mutation", async () => {
    const mutations = ENDPOINTS.filter((e) => e.method !== "GET");
    for (const m of mutations) {
      fake.state.rpcCalls.length = 0;
      const token = m.role === "e" ? E : W;
      const res = await app.call(m.method, m.path, { token, body: m.body });
      expect(res.status, `${m.method} ${m.path}`).toBeLessThan(300);
      const expected = token === E ? EMPLOYER_ID : WORKER_ID;
      expect(lastRpc()?.args.p_actor, `${m.method} ${m.path}`).toBe(expected);
    }
  });

  it("ignores user-id headers", async () => {
    await app.call("POST", `/api/jobs/${JOB_ID}/applications`, {
      token: W,
      body: {},
      headers: { "x-user-id": OTHER_ID, "x-actor": OTHER_ID, "x-forwarded-user": OTHER_ID },
    });
    expect(lastRpc()?.args.p_actor).toBe(WORKER_ID);
    expect(JSON.stringify(lastRpc()?.args)).not.toContain(OTHER_ID);
  });

  it.each([
    ["user_id", { user_id: OTHER_ID }],
    ["p_actor", { p_actor: OTHER_ID }],
    ["employer_id", { employer_id: OTHER_ID }],
    ["worker_id", { worker_id: OTHER_ID }],
    ["role", { role: "employer" }],
  ])("rejects a client-supplied %s in a request body", async (_k, extra) => {
    const res = await app.call("POST", `/api/applications/${APP_ID}/reject`, { token: E, body: extra });
    expect(res.status).toBe(422);
    expect(fake.state.rpcCalls).toHaveLength(0);
    const job = await app.call("POST", "/api/jobs", { token: E, body: validJob(extra) });
    expect(job.status).toBe(422);
    expect(fake.state.rpcCalls).toHaveLength(0);
  });

  it("rejects user ids smuggled in query strings", async () => {
    const res = await app.call("GET", `/api/notifications?user_id=${OTHER_ID}`, { token: W });
    expect(res.status).toBe(422);
  });

  it("scopes self-reads to the verified user, never a supplied id", async () => {
    await app.call("GET", `/api/me/applications?worker_id=${OTHER_ID}`, { token: W });
    await app.call("GET", "/api/me/applications", { token: W });
    const call = fake.state.readCalls.find((c) => c.method === "workerApplications");
    expect((call?.arg as { userId: string }).userId).toBe(WORKER_ID);
  });

  it("only ever calls allow-listed database functions", async () => {
    for (const e of ENDPOINTS) await app.call(e.method, e.path, { token: e.role === "e" ? E : W, body: e.body });
    for (const c of fake.state.rpcCalls) expect(RPC_NAMES).toContain(c.fn);
  });
});

describe("role checks", () => {
  const workerOnly = ENDPOINTS.filter((e) => e.role === "w");
  const employerOnly = ENDPOINTS.filter((e) => e.role === "e");

  it.each(employerOnly)("blocks a worker from $method $path", async ({ method, path, body }) => {
    const res = await app.call(method, path, { token: W, body });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("wrong_role");
    expect(fake.state.rpcCalls).toHaveLength(0);
  });

  it.each(workerOnly)("blocks an employer from $method $path", async ({ method, path, body }) => {
    const res = await app.call(method, path, { token: E, body });
    expect(res.status).toBe(403);
    expect(res.json.error.code).toBe("wrong_role");
    expect(fake.state.rpcCalls).toHaveLength(0);
  });
});

describe("input validation", () => {
  const bad: [string, Record<string, unknown>][] = [
    ["title too short", { title: "abc" }],
    ["title too long", { title: "x".repeat(101) }],
    ["missing time offset", { starts_at: "2026-11-25T09:00:00" }],
    ["not a date", { starts_at: "tomorrow" }],
    ["end before start", { ends_at: "2026-11-25T08:00:00+05:30" }],
    ["zero pay", { pay_amount_paise: 0 }],
    ["pay above INR 50,000", { pay_amount_paise: 5_000_001 }],
    ["fractional paise", { pay_amount_paise: 100.5 }],
    ["pay as a string", { pay_amount_paise: "90000" }],
    ["zero workers", { workers_needed: 0 }],
    ["too many workers", { workers_needed: 51 }],
    ["unknown pay type", { pay_type: "weekly" }],
    ["category id 0", { category_id: 0 }],
    ["locality as string", { locality_id: "1" }],
    ["unknown field", { is_admin: true }],
  ];
  it.each(bad)("rejects POST /api/jobs: %s", async (_n, over) => {
    const res = await app.call("POST", "/api/jobs", { token: E, body: validJob(over) });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("validation_error");
    expect(fake.state.rpcCalls).toHaveLength(0);
  });

  it("accepts a valid job and maps fields to the exact RPC parameters", async () => {
    const res = await app.call("POST", "/api/jobs", { token: E, body: validJob({ title: "  Move a sofa set  " }) });
    expect(res.status).toBe(201);
    expect(res.json).toEqual({ id: JOB_ID });
    expect(res.headers.get("location")).toBe(`/api/jobs/${JOB_ID}`);
    expect(lastRpc()).toEqual({
      fn: "create_job",
      args: {
        p_category_id: 1,
        p_locality_id: 1,
        p_title: "Move a sofa set",
        p_description: "Two flights of stairs",
        p_starts_at: "2026-11-25T09:00:00+05:30",
        p_ends_at: "2026-11-25T13:00:00+05:30",
        p_workers_needed: 2,
        p_pay_type: "daily",
        p_pay_amount_paise: 90000,
        p_actor: EMPLOYER_ID,
      },
    });
  });

  it.each(["not-a-uuid", "123", "00000000-0000-0000-0000-00000000000g"])("rejects id param %s", async (id) => {
    const res = await app.call("POST", `/api/applications/${id}/accept`, { token: E });
    expect(res.status).toBe(422);
    expect(fake.state.rpcCalls).toHaveLength(0);
  });

  it.each([
    ["limit=0", "limit=0"],
    ["limit=1000", "limit=1000"],
    ["offset=-1", "offset=-1"],
    ["limit=abc", "limit=abc"],
    ["unknown param", "sort=evil"],
    ["bad locality", "locality_id=0"],
  ])("rejects browse query %s", async (_n, qs) => {
    expect((await app.call("GET", `/api/jobs?${qs}`, { token: W })).status).toBe(422);
  });

  it("applies pagination defaults and filters to browse", async () => {
    const res = await app.call("GET", "/api/jobs?locality_id=3&category_id=2&limit=5&offset=10", { token: W });
    expect(res.status).toBe(200);
    expect(fake.state.readCalls.find((c) => c.method === "openJobs")?.arg).toEqual({
      localityId: 3,
      categoryId: 2,
      limit: 5,
      offset: 10,
    });
    await app.call("GET", "/api/jobs", { token: W });
    expect(fake.state.readCalls.filter((c) => c.method === "openJobs").at(-1)?.arg).toMatchObject({ limit: 20, offset: 0 });
  });

  it("rejects bad profile and worker-profile input", async () => {
    expect((await app.call("PUT", "/api/me/profile", { token: W, body: { full_name: "X", preferred_language: "en" } })).status).toBe(422);
    expect((await app.call("PUT", "/api/me/profile", { token: W, body: { full_name: "Valid Name", preferred_language: "fr" } })).status).toBe(422);
    expect((await app.call("PUT", "/api/me/worker-profile", { token: W, body: { category_ids: [1] } })).status).toBe(422);
    expect((await app.call("PUT", "/api/me/worker-profile", { token: W, body: { locality_id: 1, category_ids: [1, 2, 3, 4, 5, 6] } })).status).toBe(422);
    expect((await app.call("PUT", "/api/me/worker-profile", { token: W, body: { locality_id: 1, years_experience: 99 } })).status).toBe(422);
    expect((await app.call("PUT", "/api/me/worker-profile", { token: W, body: { locality_id: 1, bio: "x".repeat(501) } })).status).toBe(422);
    expect(fake.state.rpcCalls).toHaveLength(0);
  });

  it("rejects over-long messages and reasons and bad notification ids", async () => {
    expect((await app.call("POST", `/api/jobs/${JOB_ID}/applications`, { token: W, body: { message: "x".repeat(301) } })).status).toBe(422);
    expect((await app.call("POST", `/api/applications/${APP_ID}/reject`, { token: E, body: { reason: "x".repeat(101) } })).status).toBe(422);
    expect((await app.call("POST", `/api/bookings/${BOOKING_ID}/cancel`, { token: W, body: { reason: "x".repeat(201) } })).status).toBe(422);
    expect((await app.call("POST", "/api/notifications/read", { token: W, body: { ids: ["nope"] } })).status).toBe(422);
    expect((await app.call("POST", "/api/notifications/read", { token: W, body: { ids: [] } })).status).toBe(422);
    expect(fake.state.rpcCalls).toHaveLength(0);
  });

  it("returns 400 for malformed JSON and 413 for oversized bodies", async () => {
    const bad = await app.call("POST", "/api/jobs", { token: E, rawBody: "{not json" });
    expect(bad.status).toBe(400);
    expect(bad.json.error.code).toBe("invalid_json");
    const big = await app.call("POST", "/api/jobs", { token: E, body: validJob({ description: "x".repeat(40_000) }) });
    expect(big.status).toBe(413);
    expect(big.json.error.code).toBe("payload_too_large");
  });

  it("returns a JSON 404 for unknown API routes, with or without a token", async () => {
    for (const token of [W, undefined]) {
      const res = await app.call("GET", "/api/does-not-exist", { token });
      expect(res.status).toBe(404);
      expect(res.json.error.code).toBe("not_found");
    }
  });
});

describe("database error mapping", () => {
  const cases: [string, { code: string; message: string }, number, string][] = [
    ["KS404 not found", { code: "KS404", message: "application_not_found" }, 404, "application_not_found"],
    ["KS409 conflict", { code: "KS409", message: "job_full" }, 409, "job_full"],
    ["KS409 double booking", { code: "KS409", message: "worker_double_booked" }, 409, "worker_double_booked"],
    ["KS403 suspended", { code: "KS403", message: "account_suspended" }, 403, "account_suspended"],
    ["KS403 wrong role", { code: "KS403", message: "wrong_role" }, 403, "wrong_role"],
    ["KS422 invalid", { code: "KS422", message: "invalid_locality" }, 422, "invalid_locality"],
    ["KS401", { code: "KS401", message: "unauthenticated" }, 401, "unauthenticated"],
    ["check violation", { code: "23514", message: 'new row violates check constraint "jobs_period_check"' }, 422, "invalid_input"],
    ["range error", { code: "22000", message: "range lower bound must be less than or equal to range upper bound" }, 422, "invalid_input"],
    ["foreign key", { code: "23503", message: "violates foreign key constraint" }, 422, "invalid_reference"],
    ["unique", { code: "23505", message: "duplicate key value" }, 409, "conflict"],
    ["permission denied", { code: "42501", message: "permission denied for function accept_application" }, 500, "server_misconfigured"],
    ["isolation", { code: "KS500", message: "unsupported_isolation_level" }, 500, "server_misconfigured"],
    ["unknown", { code: "XX000", message: "boom secret=sb_secret_CANARY" }, 500, "internal_error"],
  ];
  it.each(cases)("%s", async (_n, error, status, code) => {
    fake.state.rpcResults.accept_application = { data: null, error };
    const res = await app.call("POST", `/api/applications/${APP_ID}/accept`, { token: E });
    expect(res.status).toBe(status);
    expect(res.json.error.code).toBe(code);
    expect(res.text).not.toContain("sb_secret_CANARY");
    expect(res.text).not.toContain("jobs_period_check");
    expect(res.text).not.toMatch(/permission denied/i);
  });

  it("maps an unexpected thrown error to a generic 500 without leaking its message", async () => {
    const originalRpc = fake.deps.rpc;
    fake.deps.rpc = async () => {
      throw new Error("connect ECONNREFUSED 10.0.0.5:5432 password=hunter2");
    };
    let res;
    try {
      res = await app.call("POST", `/api/applications/${APP_ID}/accept`, { token: E });
    } finally {
      fake.deps.rpc = originalRpc;
    }
    expect(res.status).toBe(500);
    expect(res.json.error.code).toBe("internal_error");
    expect(res.text).not.toContain("hunter2");
    expect(res.text).not.toContain("ECONNREFUSED");
  });
});

describe("endpoint behaviour", () => {
  it("GET /me returns the worker profile for workers only", async () => {
    const w = await app.call("GET", "/api/me", { token: W });
    expect(w.json.profile.role).toBe("worker");
    expect(w.json.worker).toMatchObject({ locality_id: 1, category_ids: [1, 2] });
    const e = await app.call("GET", "/api/me", { token: E });
    expect(e.json.worker).toBeNull();
  });

  it("PUT /me/profile and /me/worker-profile map fields", async () => {
    await app.call("PUT", "/api/me/profile", { token: E, body: { full_name: " Shree Traders ", preferred_language: "gu", org_name: "Shree" } });
    expect(lastRpc()).toEqual({
      fn: "update_profile",
      args: { p_full_name: "Shree Traders", p_preferred_language: "gu", p_org_name: "Shree", p_actor: EMPLOYER_ID },
    });
    await app.call("PUT", "/api/me/worker-profile", { token: W, body: { locality_id: 2, category_ids: [1, 3], years_experience: 4 } });
    expect(lastRpc()).toEqual({
      fn: "save_worker_profile",
      args: {
        p_bio: null,
        p_years_experience: 4,
        p_locality_id: 2,
        p_is_available: true,
        p_category_ids: [1, 3],
        p_skills: null,
        p_availability_note: null,
        p_actor: WORKER_ID,
      },
    });
  });

  it("serves categories and localities", async () => {
    expect((await app.call("GET", "/api/categories", { token: W })).json.categories).toHaveLength(1);
    expect((await app.call("GET", "/api/localities", { token: E })).json.localities[0].name).toBe("Alkapuri");
  });

  it("browse adds employer names; employer sees own jobs", async () => {
    const browse = await app.call("GET", "/api/jobs", { token: W });
    expect(browse.json.jobs[0].employer).toEqual({ full_name: "Employer One", org_name: null });
    expect(browse.json.page).toEqual({ limit: 20, offset: 0 });
    const own = await app.call("GET", "/api/employer/jobs", { token: E });
    expect(own.json.jobs).toHaveLength(1);
    expect(fake.state.readCalls.find((c) => c.method === "employerJobs")?.arg).toMatchObject({ userId: EMPLOYER_ID });
  });

  it("job detail: 404 when not visible, includes the worker's own application", async () => {
    expect((await app.call("GET", `/api/jobs/${OTHER_ID}`, { token: W })).status).toBe(404);
    fake.state.application = {
      id: APP_ID, job_id: JOB_ID, worker_id: WORKER_ID, status: "pending", status_reason: null,
      message: null, decided_at: null, created_at: "2026-11-20T10:00:00+00:00",
    };
    const res = await app.call("GET", `/api/jobs/${JOB_ID}`, { token: W });
    expect(res.status).toBe(200);
    expect(res.json.job.title).toBe("Move a sofa set");
    expect(res.json.my_application.status).toBe("pending");
    const asEmployer = await app.call("GET", `/api/jobs/${JOB_ID}`, { token: E });
    expect(asEmployer.json.my_application).toBeNull();
  });

  it("apply / withdraw / accept / reject / cancel map to the right functions and statuses", async () => {
    const apply = await app.call("POST", `/api/jobs/${JOB_ID}/applications`, { token: W, body: { message: " I can start early " } });
    expect(apply.status).toBe(201);
    expect(apply.json).toEqual({ application_id: APP_ID });
    expect(lastRpc()).toEqual({ fn: "apply_to_job", args: { p_job_id: JOB_ID, p_message: "I can start early", p_actor: WORKER_ID } });

    expect((await app.call("POST", `/api/applications/${APP_ID}/withdraw`, { token: W })).status).toBe(204);
    expect(lastRpc()).toEqual({ fn: "withdraw_application", args: { p_application_id: APP_ID, p_actor: WORKER_ID } });

    const accept = await app.call("POST", `/api/applications/${APP_ID}/accept`, { token: E });
    expect(accept.status).toBe(201);
    expect(accept.json).toEqual({ booking_id: BOOKING_ID });
    expect(lastRpc()).toEqual({ fn: "accept_application", args: { p_application_id: APP_ID, p_actor: EMPLOYER_ID } });

    expect((await app.call("POST", `/api/applications/${APP_ID}/reject`, { token: E, body: { reason: "Not a fit" } })).status).toBe(204);
    expect(lastRpc()).toEqual({ fn: "reject_application", args: { p_application_id: APP_ID, p_reason: "Not a fit", p_actor: EMPLOYER_ID } });

    expect((await app.call("POST", `/api/jobs/${JOB_ID}/cancel`, { token: E, body: { reason: "Plans changed" } })).status).toBe(204);
    expect(lastRpc()).toEqual({ fn: "cancel_job", args: { p_job_id: JOB_ID, p_reason: "Plans changed", p_actor: EMPLOYER_ID } });

    for (const [token, actor] of [[W, WORKER_ID], [E, EMPLOYER_ID]] as const) {
      expect((await app.call("POST", `/api/bookings/${BOOKING_ID}/cancel`, { token })).status).toBe(204);
      expect(lastRpc()).toEqual({ fn: "cancel_booking", args: { p_booking_id: BOOKING_ID, p_reason: null, p_actor: actor } });
    }
  });

  it("applicants endpoint returns facts plus a transparent fit, with no score or reliability figure", async () => {
    const res = await app.call("GET", `/api/jobs/${JOB_ID}/applicants`, { token: E });
    expect(res.status).toBe(200);
    expect(lastRpc()).toEqual({ fn: "get_applicant_signals", args: { p_job_id: JOB_ID, p_actor: EMPLOYER_ID } });
    const a = res.json.applicants[0];
    expect(Object.keys(a).sort()).toEqual(
      ["application_id", "application_status", "applied_at", "availability_note", "bio", "category_match", "completed_jobs", "fit",
       "has_booking_conflict", "locality_match", "member_since", "message", "no_show_count", "review_count", "avg_rating", "skills", "worker_id", "worker_name", "years_experience"].sort(),
    );
    expect(a.fit).toMatchObject({ percent: 100, label: "Strong match", signals_used: ["category", "locality"] });
    expect(a.fit.signals_excluded).toEqual(expect.arrayContaining(["experience", "reviews", "reliability"]));
    expect(JSON.stringify(a.fit.reasons) + JSON.stringify(a.fit.notes)).not.toMatch(/rating|stars|score|verified/i);
  });

  it("lists bookings and applications with job summaries", async () => {
    fake.state.bookings = [{
      id: BOOKING_ID, job_id: JOB_ID, application_id: APP_ID, worker_id: WORKER_ID, employer_id: EMPLOYER_ID,
      agreed_pay_paise: 90000, status: "confirmed", cancelled_by: null, cancelled_at: null,
      cancel_reason: null, completed_at: null, created_at: "2026-11-20T10:00:00+00:00",
    }];
    const res = await app.call("GET", "/api/me/bookings", { token: W });
    expect(res.json.bookings[0].job.title).toBe("Move a sofa set");
    expect(res.json.bookings[0].job.employer.full_name).toBe("Employer One");
  });

  it("notifications: unread filter and mark-read", async () => {
    await app.call("GET", "/api/notifications?unread=true&limit=10", { token: W });
    expect(fake.state.readCalls.find((c) => c.method === "notifications")?.arg).toEqual({ unreadOnly: true, limit: 10, offset: 0 });
    const read = await app.call("POST", "/api/notifications/read", { token: W, body: { ids: [APP_ID] } });
    expect(read.json).toEqual({ updated: 2 });
    expect(lastRpc()).toEqual({ fn: "mark_notifications_read", args: { p_ids: [APP_ID], p_actor: WORKER_ID } });
    await app.call("POST", "/api/notifications/read", { token: W });
    expect(lastRpc()?.args.p_ids).toBeNull();
  });
});

describe("service-role key handling", () => {
  it("config errors name variables but never values", () => {
    const secret = "sb_secret_SHOULD_NOT_APPEAR";
    expect(() => loadSupabaseConfig({ SUPABASE_URL: "https://x.supabase.co", SUPABASE_SERVICE_ROLE_KEY: secret })).toThrow(/SUPABASE_ANON_KEY/);
    try {
      loadSupabaseConfig({ SUPABASE_URL: "not a url", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: secret });
    } catch (e) {
      expect((e as Error).message).not.toContain(secret);
    }
    expect(() => loadSupabaseConfig({})).toThrow(/SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY/);
    expect(() =>
      loadSupabaseConfig({ NODE_ENV: "production", SUPABASE_URL: "http://x.supabase.co", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "b" }),
    ).toThrow(/https/);
    expect(loadSupabaseConfig({ SUPABASE_URL: "https://x.supabase.co/", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "b" }).url).toBe(
      "https://x.supabase.co",
    );
  });

  it("the service-role key is referenced only by config.ts and supabase.ts, and never by the web app", () => {
    const srcDir = __dirname;
    const offenders = fs
      .readdirSync(srcDir)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && !["config.ts", "supabase.ts", "index.ts"].includes(f))
      .filter((f) => /serviceRoleKey|SERVICE_ROLE/i.test(fs.readFileSync(path.join(srcDir, f), "utf8")));
    expect(offenders).toEqual([]);

    const webDir = path.resolve(srcDir, "../../web/src");
    const walk = (d: string): string[] =>
      // Production code only: web/src/test holds the guardrail test that itself spells out the forbidden pattern.
      fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "test" ? [] : walk(path.join(d, e.name))) : [path.join(d, e.name)]));
    const leaks = walk(webDir).filter((f) => /service_role|SERVICE_ROLE|serviceRoleKey/i.test(fs.readFileSync(f, "utf8")));
    expect(leaks).toEqual([]);
  });

  it("no response ever contains key material", async () => {
    for (const e of ENDPOINTS) {
      const res = await app.call(e.method, e.path, { token: e.role === "e" ? E : W, body: e.body });
      expect(res.text).not.toMatch(/service_role|sb_secret|eyJ[A-Za-z0-9_-]{20,}/);
      expect([...res.headers.keys()].join(",")).not.toMatch(/x-powered-by/i);
    }
  });
});

describe("GET /api/public-config", () => {
  it("serves only the browser-safe Supabase settings, without authentication", async () => {
    const { createApp } = await import("./app");
    const { default: http } = await import("node:http");
    const server = http.createServer(
      createApp({
        deps: fake.deps,
        publicConfig: { supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon-public-key" },
      }),
    );
    await new Promise<void>((r) => server.listen(0, r));
    const port = (server.address() as { port: number }).port;
    const res = await fetch(`http://127.0.0.1:${port}/api/public-config`);
    const text = await res.text();
    server.close();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.parse(text)).toEqual({ supabaseUrl: "https://x.supabase.co", supabaseAnonKey: "anon-public-key" });
    expect(text).not.toMatch(/service/i);
  });

  it("is not exposed when no public config is provided", async () => {
    expect((await app.call("GET", "/api/public-config")).status).toBe(404);
  });
});
