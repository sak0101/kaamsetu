// End-to-end: real Express app + real Supabase Auth/PostgREST/Postgres (LOCAL stack only).
// Run with: npm run test:integration -w @kaamsetu/api
import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadSupabaseConfig } from "../config";
import { createSupabaseDeps } from "../supabase";

const cfg = loadSupabaseConfig(process.env);
const OPTS = { auth: { persistSession: false, autoRefreshToken: false } };
const admin = createClient(cfg.url, cfg.serviceRoleKey, OPTS);
const anon = createClient(cfg.url, cfg.anonKey, OPTS);
const password = randomBytes(18).toString("base64url"); // test-only, never stored

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";

interface User { id: string; token: string }
const users: Record<string, User> = {};

async function mkUser(key: string, role: "worker" | "employer") {
  const email = `${key}-${randomUUID().slice(0, 8)}@api-it.invalid`;
  const created = await admin.auth.admin.createUser({
    email, password, email_confirm: true, user_metadata: { role, full_name: `IT ${key}` },
  });
  if (created.error) throw new Error(`createUser ${key}: ${created.error.message}`);
  const signed = await anon.auth.signInWithPassword({ email, password });
  if (signed.error || !signed.data.session) throw new Error(`signIn ${key}: ${signed.error?.message}`);
  users[key] = { id: created.data.user.id, token: signed.data.session.access_token };
}

async function api(key: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { ...headers };
  if (key) h.authorization = `Bearer ${users[key]!.token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, json, text };
}

/** Local-only helper to flip things only the database owner can change. */
function sql(statement: string) {
  execFileSync("docker", ["exec", "-i", "supabase_db_kaamsetu", "psql", "-U", "postgres", "-d", "postgres", "-q"], {
    input: statement, stdio: ["pipe", "ignore", "inherit"],
  });
}

const IST_MS = 5.5 * 3_600_000;
/** An instant `hoursFromNow` ahead, formatted with the +05:30 (IST) offset the API requires. */
const ist = (hoursFromNow: number) =>
  new Date(Date.now() + hoursFromNow * 3_600_000 + IST_MS).toISOString().replace(/\.\d{3}Z$/, "+05:30");

const jobBody = (over: Record<string, unknown> = {}) => ({
  category_id: 1, locality_id: 1, title: "Shift household goods", description: "Third floor, no lift",
  starts_at: ist(48), ends_at: ist(52), workers_needed: 1, pay_type: "daily", pay_amount_paise: 85000, ...over,
});

beforeAll(async () => {
  server = createApp({ deps: createSupabaseDeps(cfg) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await Promise.all([
    mkUser("e1", "employer"), mkUser("e2", "employer"),
    mkUser("w1", "worker"), mkUser("w2", "worker"), mkUser("w3", "worker"), mkUser("w4", "worker"),
  ]);
});
afterAll(() => server?.close());

const state: Record<string, string> = {};

describe("identity and profiles (real Supabase Auth)", () => {
  it("rejects missing, forged and tampered tokens", async () => {
    expect((await api(null, "GET", "/api/me")).status).toBe(401);
    const forged = await fetch(`${base}/api/me`, { headers: { authorization: "Bearer not.a.jwt" } });
    expect(forged.status).toBe(401);
    const t = users.w1!.token;
    const tampered = t.slice(0, -4) + (t.endsWith("AAAA") ? "BBBB" : "AAAA");
    expect((await fetch(`${base}/api/me`, { headers: { authorization: `Bearer ${tampered}` } })).status).toBe(401);
  });

  it("GET /me returns the verified user's own role-specific profile", async () => {
    const w = await api("w1", "GET", "/api/me");
    expect(w.status).toBe(200);
    expect(w.json.profile).toMatchObject({ id: users.w1!.id, role: "worker", full_name: "IT w1" });
    expect(w.json.profile).not.toHaveProperty("is_suspended");
    expect(w.json.worker).toMatchObject({ user_id: users.w1!.id });
    const e = await api("e1", "GET", "/api/me");
    expect(e.json.profile.role).toBe("employer");
    expect(e.json.worker).toBeNull();
  });

  it("updates the profile and worker profile", async () => {
    const p = await api("e1", "PUT", "/api/me/profile", { full_name: "Shree Traders", preferred_language: "gu", org_name: "Shree Traders Pvt" });
    expect(p.status).toBe(200);
    expect(p.json.profile).toMatchObject({ full_name: "Shree Traders", preferred_language: "gu", org_name: "Shree Traders Pvt" });
    for (const k of ["w1", "w2", "w3", "w4"]) {
      const r = await api(k, "PUT", "/api/me/worker-profile", { bio: "Reliable", years_experience: 3, locality_id: 1, category_ids: [1, 2] });
      expect(r.status, k).toBe(200);
      expect(r.json.worker).toMatchObject({ locality_id: 1, category_ids: [1, 2] });
    }
    expect((await api("w1", "PUT", "/api/me/worker-profile", { locality_id: 999 })).status).toBe(422);
  });

  it("serves reference data", async () => {
    const c = await api("w1", "GET", "/api/categories");
    const l = await api("e1", "GET", "/api/localities");
    expect(c.json.categories.length).toBeGreaterThanOrEqual(8);
    expect(l.json.localities.some((x: any) => x.name === "Alkapuri")).toBe(true);
  });
});

describe("jobs, applications and atomic acceptance", () => {
  it("employer creates a job; workers cannot", async () => {
    const created = await api("e1", "POST", "/api/jobs", jobBody());
    expect(created.status).toBe(201);
    state.jobA = created.json.id;
    expect((await api("w1", "POST", "/api/jobs", jobBody())).status).toBe(403);
    expect((await api("e1", "POST", "/api/jobs", jobBody({ starts_at: ist(-5), ends_at: ist(-1) }))).status).toBe(422);
    expect((await api("e1", "POST", "/api/jobs", jobBody({ starts_at: ist(60), ends_at: ist(30) }))).status).toBe(422);
  });

  it("workers browse open jobs; employers cannot use worker browse", async () => {
    const r = await api("w1", "GET", "/api/jobs?locality_id=1&limit=50");
    expect(r.status).toBe(200);
    const job = r.json.jobs.find((j: any) => j.id === state.jobA);
    expect(job).toBeDefined();
    expect(job.employer).toMatchObject({ full_name: "Shree Traders" });
    expect((await api("e1", "GET", "/api/jobs")).status).toBe(403);
    const mine = await api("e1", "GET", "/api/employer/jobs");
    expect(mine.json.jobs.some((j: any) => j.id === state.jobA)).toBe(true);
  });

  it("job detail respects RLS", async () => {
    expect((await api("w1", "GET", `/api/jobs/${state.jobA}`)).status).toBe(200);
    expect((await api("e1", "GET", `/api/jobs/${state.jobA}`)).status).toBe(200);
    // another employer cannot see it at all
    expect((await api("e2", "GET", `/api/jobs/${state.jobA}`)).status).toBe(404);
    expect((await api("w1", "GET", `/api/jobs/${randomUUID()}`)).status).toBe(404);
  });

  it("workers apply once; duplicates are rejected", async () => {
    const a1 = await api("w1", "POST", `/api/jobs/${state.jobA}/applications`, { message: "Available all day" });
    expect(a1.status).toBe(201);
    state.appW1 = a1.json.application_id;
    expect((await api("w1", "POST", `/api/jobs/${state.jobA}/applications`, {})).json.error.code).toBe("already_applied");
    const a2 = await api("w2", "POST", `/api/jobs/${state.jobA}/applications`, {});
    expect(a2.status).toBe(201);
    state.appW2 = a2.json.application_id;
    expect((await api("e1", "POST", `/api/jobs/${state.jobA}/applications`, {})).status).toBe(403);
    const mine = await api("w1", "GET", "/api/me/applications");
    expect(mine.json.applications[0]).toMatchObject({ id: state.appW1, status: "pending" });
    expect(mine.json.applications[0].job.title).toBe("Shift household goods");
  });

  it("employer sees applicant evidence only; other employers and workers cannot", async () => {
    const r = await api("e1", "GET", `/api/jobs/${state.jobA}/applicants`);
    expect(r.status).toBe(200);
    expect(r.json.applicants).toHaveLength(2);
    expect(r.json.applicants[0]).toMatchObject({ category_match: true, locality_match: "same_locality", years_experience: 3 });
    // A transparent fit built from three facts; reviews and reliability are explicitly NOT used.
    for (const a of r.json.applicants) {
      expect(a.fit.signals_used).toEqual(["category", "locality", "experience"]);
      expect(a.fit.signals_excluded).toEqual(expect.arrayContaining(["reviews", "reliability"]));
      expect(a.completed_jobs).toBe(0); // a real count from the database, not invented
      expect(a.fit.percent).toBeGreaterThanOrEqual(0);
    }
    expect(r.text).not.toMatch(/\b(stars?|rated|review_score|rating)\b/i);
    expect((await api("e2", "GET", `/api/jobs/${state.jobA}/applicants`)).status).toBe(404);
    expect((await api("w1", "GET", `/api/jobs/${state.jobA}/applicants`)).status).toBe(403);
  });

  it("employer was notified of both applications; mark-read works", async () => {
    const n = await api("e1", "GET", "/api/notifications?unread=true");
    expect(n.json.notifications.filter((x: any) => x.type === "new_application")).toHaveLength(2);
    const marked = await api("e1", "POST", "/api/notifications/read", { ids: [n.json.notifications[0].id] });
    expect(marked.json.updated).toBe(1);
    // cannot mark someone else's notification
    const wn = await api("w1", "GET", "/api/notifications");
    expect((await api("e1", "POST", "/api/notifications/read", { ids: [randomUUID()] })).json.updated).toBe(0);
    expect(wn.json.notifications.every((x: any) => x.type !== "new_application")).toBe(true);
  });

  it("only the owner can accept; acceptance is atomic and rejects the rest of a full job", async () => {
    expect((await api("e2", "POST", `/api/applications/${state.appW1}/accept`)).status).toBe(404);
    expect((await api("w1", "POST", `/api/applications/${state.appW1}/accept`)).status).toBe(403);
    const acc = await api("e1", "POST", `/api/applications/${state.appW1}/accept`);
    expect(acc.status).toBe(201);
    state.bookingW1 = acc.json.booking_id;

    const again = await api("e1", "POST", `/api/applications/${state.appW1}/accept`);
    expect(again.status).toBe(409);
    expect(again.json.error.code).toBe("application_not_pending");

    // workers_needed = 1, so W2 was auto-rejected as job_filled and cannot be accepted
    const late = await api("e1", "POST", `/api/applications/${state.appW2}/accept`);
    expect(late.status).toBe(409);
    const w2apps = await api("w2", "GET", "/api/me/applications");
    expect(w2apps.json.applications[0]).toMatchObject({ status: "rejected", status_reason: "job_filled" });
    const detail = await api("e1", "GET", `/api/jobs/${state.jobA}`);
    expect(detail.json.job).toMatchObject({ status: "filled", positions_filled: 1 });
  });

  it("worker is notified via Realtime-backed notifications and sees the booking", async () => {
    const n = await api("w1", "GET", "/api/notifications");
    expect(n.json.notifications.map((x: any) => x.type)).toContain("booking_confirmed");
    expect(n.json.notifications.map((x: any) => x.type)).not.toContain("application_rejected");
    const b = await api("w1", "GET", "/api/me/bookings");
    expect(b.json.bookings[0]).toMatchObject({ id: state.bookingW1, status: "confirmed", worker_id: users.w1!.id });
    expect(b.json.bookings[0].job.title).toBe("Shift household goods");
    // an unrelated worker sees none
    expect((await api("w3", "GET", "/api/me/bookings")).json.bookings).toHaveLength(0);
    const w2n = await api("w2", "GET", "/api/notifications");
    expect(w2n.json.notifications.some((x: any) => x.type === "application_rejected")).toBe(true);
  });

  it("prevents overlapping bookings for the same worker", async () => {
    const jobB = await api("e2", "POST", "/api/jobs", jobBody({ starts_at: ist(49), ends_at: ist(53) }));
    expect(jobB.status).toBe(201);
    state.jobB = jobB.json.id;
    const apply = await api("w1", "POST", `/api/jobs/${state.jobB}/applications`, {});
    expect(apply.status).toBe(409);
    expect(apply.json.error.code).toBe("worker_double_booked");
  });

  it("cancellation attribution, reopening, and job cancellation", async () => {
    expect((await api("w3", "POST", `/api/bookings/${state.bookingW1}/cancel`, {})).status).toBe(404);
    expect((await api("w1", "POST", `/api/bookings/${state.bookingW1}/cancel`, { reason: "Family emergency" })).status).toBe(204);
    expect((await api("w1", "POST", `/api/bookings/${state.bookingW1}/cancel`, {})).status).toBe(409);
    const after = await api("e1", "GET", `/api/jobs/${state.jobA}`);
    expect(after.json.job).toMatchObject({ status: "open", positions_filled: 0 });
    const eb = await api("e1", "GET", "/api/me/bookings");
    expect(eb.json.bookings[0]).toMatchObject({ status: "cancelled_by_worker", cancelled_by: users.w1!.id });
    const en = await api("e1", "GET", "/api/notifications");
    expect(en.json.notifications.some((x: any) => x.type === "booking_cancelled" && x.payload.cancelled_by === "worker")).toBe(true);

    expect((await api("e2", "POST", `/api/jobs/${state.jobA}/cancel`, {})).status).toBe(404);
    expect((await api("e1", "POST", `/api/jobs/${state.jobA}/cancel`, { reason: "Postponed" })).status).toBe(204);
    expect((await api("e1", "POST", `/api/jobs/${state.jobA}/cancel`, {})).status).toBe(409);
    const apply = await api("w3", "POST", `/api/jobs/${state.jobA}/applications`, {});
    expect(apply.status).toBe(409);
    expect((await api("w3", "GET", `/api/jobs/${state.jobA}`)).status).toBe(404);
  });

  it("withdraw and reject work, and withdrawn applications can be re-submitted", async () => {
    const job = await api("e1", "POST", "/api/jobs", jobBody({ workers_needed: 3, starts_at: ist(100), ends_at: ist(104) }));
    state.jobC = job.json.id;
    const a3 = await api("w3", "POST", `/api/jobs/${state.jobC}/applications`, {});
    const a4 = await api("w4", "POST", `/api/jobs/${state.jobC}/applications`, {});
    expect((await api("w3", "POST", `/api/applications/${a3.json.application_id}/withdraw`)).status).toBe(204);
    expect((await api("w3", "POST", `/api/applications/${a3.json.application_id}/withdraw`)).status).toBe(409);
    expect((await api("w4", "POST", `/api/applications/${a3.json.application_id}/withdraw`)).status).toBe(404);
    expect((await api("w3", "POST", `/api/jobs/${state.jobC}/applications`, { message: "Back" })).status).toBe(201);
    expect((await api("e1", "POST", `/api/applications/${a4.json.application_id}/reject`, { reason: "Not a fit" })).status).toBe(204);
    const w4 = await api("w4", "GET", "/api/me/applications");
    expect(w4.json.applications[0]).toMatchObject({ status: "rejected", status_reason: "Not a fit" });
    expect((await api("e1", "POST", `/api/applications/${a4.json.application_id}/reject`, {})).status).toBe(409);
  });
});

describe("identity cannot be spoofed", () => {
  it("rejects user ids in bodies and ignores identity headers", async () => {
    expect((await api("w1", "POST", `/api/jobs/${state.jobC}/applications`, { worker_id: users.w2!.id })).status).toBe(422);
    expect((await api("e1", "POST", "/api/jobs", { ...jobBody(), employer_id: users.e2!.id })).status).toBe(422);
    const r = await api("w1", "GET", "/api/me", undefined, { "x-user-id": users.w2!.id });
    expect(r.json.profile.id).toBe(users.w1!.id);
  });

  it("a worker cannot see an employer's applicants or another worker's data through the API", async () => {
    expect((await api("w2", "GET", `/api/jobs/${state.jobC}/applicants`)).status).toBe(403);
    const apps = await api("w2", "GET", `/api/me/applications?worker_id=${users.w1!.id}`);
    expect(apps.status).toBe(422);
  });
});

describe("the database boundary holds end to end (direct PostgREST access, bypassing Express)", () => {
  const rest = (path: string, key: string, bearer: string, init: RequestInit = {}) =>
    fetch(`${cfg.url}/rest/v1/${path}`, { ...init, headers: { apikey: key, authorization: `Bearer ${bearer}`, "content-type": "application/json", ...(init.headers as object) } });

  it("an authenticated user cannot call mutation functions directly", async () => {
    const r = await rest("rpc/accept_application", cfg.anonKey, users.e1!.token, {
      method: "POST", body: JSON.stringify({ p_actor: users.e1!.id, p_application_id: randomUUID() }),
    });
    expect([401, 403]).toContain(r.status);
    const c = await rest("rpc/create_job", cfg.anonKey, users.e1!.token, { method: "POST", body: "{}" });
    expect([401, 403, 404]).toContain(c.status);
  });

  it("an authenticated user cannot write tables directly", async () => {
    const upd = await rest(`profiles?id=eq.${users.w1!.id}`, cfg.anonKey, users.w1!.token, {
      method: "PATCH", body: JSON.stringify({ role: "employer" }),
    });
    expect([401, 403]).toContain(upd.status);
    const ins = await rest("bookings", cfg.anonKey, users.w1!.token, { method: "POST", body: "{}" });
    expect([401, 403]).toContain(ins.status);
  });

  it("select=* on profiles and is_suspended are denied to users", async () => {
    expect([401, 403]).toContain((await rest("profiles?select=*", cfg.anonKey, users.w1!.token)).status);
    expect([401, 403]).toContain((await rest("profiles?select=is_suspended", cfg.anonKey, users.w1!.token)).status);
  });

  it("the service-role key cannot read or write tables directly", async () => {
    expect([401, 403]).toContain((await rest("profiles?select=id", cfg.serviceRoleKey, cfg.serviceRoleKey)).status);
    expect([401, 403]).toContain((await rest("jobs", cfg.serviceRoleKey, cfg.serviceRoleKey, { method: "POST", body: "{}" })).status);
  });

  it("an anonymous caller sees nothing", async () => {
    expect([401, 403]).toContain((await rest("jobs?select=id", cfg.anonKey, cfg.anonKey)).status);
  });
});

describe("suspended accounts", () => {
  it("are refused by every mutation with 403 account_suspended, while the API stays up", async () => {
    sql(`update public.profiles set is_suspended = true where id = '${users.w4!.id}';`);
    const r = await api("w4", "POST", `/api/jobs/${state.jobC}/applications`, {});
    expect(r.status).toBe(403);
    expect(r.json.error.code).toBe("account_suspended");
    const profile = await api("w4", "PUT", "/api/me/profile", { full_name: "Still Here", preferred_language: "en" });
    expect(profile.status).toBe(403);
    sql(`update public.profiles set is_suspended = false where id = '${users.w4!.id}';`);
    expect((await api("w4", "PUT", "/api/me/profile", { full_name: "Back Again", preferred_language: "en" })).status).toBe(200);
  });
});
