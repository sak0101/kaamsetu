// Real Express + real Supabase (LOCAL): worker profile extras, contact-phone privacy, AI route without a key.
// Run with: npm run test:integration -w @kaamsetu/api
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
const password = randomBytes(18).toString("base64url");

let server: ReturnType<ReturnType<typeof createApp>["listen"]>;
let base = "";
const users: Record<string, { id: string; token: string }> = {};

async function mkUser(key: string, role: "worker" | "employer") {
  const email = `${key}-${randomUUID().slice(0, 8)}@api-it.invalid`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role, full_name: `IT ${key}` } });
  if (created.error) throw new Error(created.error.message);
  const signed = await anon.auth.signInWithPassword({ email, password });
  if (signed.error || !signed.data.session) throw new Error(signed.error?.message);
  users[key] = { id: created.data.user.id, token: signed.data.session.access_token };
}

async function api(key: string | null, method: string, path: string, body?: unknown) {
  const h: Record<string, string> = {};
  if (key) h.authorization = `Bearer ${users[key]!.token}`;
  if (body !== undefined) h["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* 204 */ }
  return { status: res.status, json, text };
}

const IST_MS = 5.5 * 3_600_000;
const ist = (h: number) => new Date(Date.now() + h * 3_600_000 + IST_MS).toISOString().replace(/\.\d{3}Z$/, "+05:30");

beforeAll(async () => {
  server = createApp({ deps: createSupabaseDeps(cfg) }).listen(0); // note: no AI service configured
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await Promise.all([mkUser("emp", "employer"), mkUser("w1", "worker"), mkUser("w2", "worker"), mkUser("stranger", "worker")]);
});
afterAll(() => server?.close());

const state: Record<string, string> = {};

describe("worker profile extras (real database)", () => {
  it("round-trips skills, availability note, intro and experience", async () => {
    const put = await api("w1", "PUT", "/api/me/worker-profile", {
      bio: "Reliable.", years_experience: 2, locality_id: 1, category_ids: [1], skills: ["  Guest handling ", "Serving food", "guest HANDLING"], availability_note: "Weekends",
    });
    expect(put.status).toBe(200);
    expect(put.json.worker).toMatchObject({ skills: ["Guest handling", "Serving food"], availability_note: "Weekends", years_experience: 2 });
    const me = await api("w1", "GET", "/api/me");
    expect(me.json.worker).toMatchObject({ skills: ["Guest handling", "Serving food"], availability_note: "Weekends" });
  });

  it("leaves skills alone when none are sent, and clears them with an empty list", async () => {
    await api("w1", "PUT", "/api/me/worker-profile", { locality_id: 1, category_ids: [1] });
    expect((await api("w1", "GET", "/api/me")).json.worker.skills).toEqual(["Guest handling", "Serving food"]);
    await api("w1", "PUT", "/api/me/worker-profile", { locality_id: 1, category_ids: [1], skills: [] });
    expect((await api("w1", "GET", "/api/me")).json.worker.skills).toEqual([]);
  });

  it("rejects bad skills before and at the database", async () => {
    expect((await api("w1", "PUT", "/api/me/worker-profile", { locality_id: 1, skills: ["x"] })).status).toBe(422);
    expect((await api("w1", "PUT", "/api/me/worker-profile", { locality_id: 1, skills: Array.from({ length: 9 }, (_, i) => `skill ${i}`) })).status).toBe(422);
  });
});

describe("contact phone privacy (real database, row-level security)", () => {
  it("normalises Indian numbers and rejects everything else", async () => {
    const ok = await api("w1", "PUT", "/api/me/contact", { phone: "98765 43210" });
    expect(ok.status).toBe(200);
    expect(ok.json.phone).toBe("+919876543210");
    expect((await api("w1", "GET", "/api/me/contact")).json.phone).toBe("+919876543210");
    for (const bad of ["12345", "5876543210", "call me", "+14155552671"]) {
      const r = await api("w1", "PUT", "/api/me/contact", { phone: bad });
      expect(r.status, bad).toBe(422);
      expect(r.json.error.code).toBe("invalid_phone");
    }
    expect((await api("emp", "PUT", "/api/me/contact", { phone: "9123456789" })).json.phone).toBe("+919123456789");
    await api("w2", "PUT", "/api/me/worker-profile", { locality_id: 1, category_ids: [1] });
    await api("w2", "PUT", "/api/me/contact", { phone: "9000000002" });
  });

  it("an employer cannot read an applicant's phone before booking, nor a stranger anyone's", async () => {
    const job = await api("emp", "POST", "/api/jobs", { category_id: 1, locality_id: 1, title: "Contact privacy job", description: "x", starts_at: ist(72), ends_at: ist(76), workers_needed: 2, pay_type: "daily", pay_amount_paise: 70000 });
    state.job = job.json.id;
    const a1 = await api("w1", "POST", `/api/jobs/${state.job}/applications`, {});
    const a2 = await api("w2", "POST", `/api/jobs/${state.job}/applications`, {});
    state.a1 = a1.json.application_id;
    state.a2 = a2.json.application_id;
    // the applicants endpoint exposes facts and fit, never a phone number
    const applicants = await api("emp", "GET", `/api/jobs/${state.job}/applicants`);
    expect(applicants.status).toBe(200);
    expect(applicants.text).not.toMatch(/\+919876543210|\+919000000002|phone/);
    // and the database itself refuses: the employer's own client sees only their own number
    const direct = await fetch(`${cfg.url}/rest/v1/contact_details?select=user_id,phone`, { headers: { apikey: cfg.anonKey, authorization: `Bearer ${users.emp!.token}` } });
    const rows = (await direct.json()) as { user_id: string }[];
    expect(rows.map((r) => r.user_id)).toEqual([users.emp!.id]);
    const strangerRows = (await (await fetch(`${cfg.url}/rest/v1/contact_details?select=user_id`, { headers: { apikey: cfg.anonKey, authorization: `Bearer ${users.stranger!.token}` } })).json()) as unknown[];
    expect(strangerRows).toEqual([]);
  });

  it("after the employer books a worker, both sides can see each other's number, but nobody else", async () => {
    const acc = await api("emp", "POST", `/api/applications/${state.a1}/accept`);
    expect(acc.status).toBe(201);
    state.booking = acc.json.booking_id;

    const asWorker = await api("w1", "GET", `/api/bookings/${state.booking}/contact`);
    expect(asWorker.json).toMatchObject({ phone: "+919123456789", shared: true, name: "IT emp" });
    const asEmployer = await api("emp", "GET", `/api/bookings/${state.booking}/contact`);
    expect(asEmployer.json).toMatchObject({ phone: "+919876543210", shared: true, name: "IT w1" });

    // the other applicant (not booked) and a stranger get nothing: the booking isn't theirs
    expect((await api("w2", "GET", `/api/bookings/${state.booking}/contact`)).status).toBe(404);
    expect((await api("stranger", "GET", `/api/bookings/${state.booking}/contact`)).status).toBe(404);
    const w2Rows = (await (await fetch(`${cfg.url}/rest/v1/contact_details?select=user_id`, { headers: { apikey: cfg.anonKey, authorization: `Bearer ${users.w2!.token}` } })).json()) as { user_id: string }[];
    expect(w2Rows.map((r) => r.user_id)).toEqual([users.w2!.id]); // the unbooked applicant sees only their own number
  });

  it("sharing stops the moment the booking is cancelled", async () => {
    expect((await api("w1", "POST", `/api/bookings/${state.booking}/cancel`, { reason: "Plans changed" })).status).toBe(204);
    const afterWorker = await api("w1", "GET", `/api/bookings/${state.booking}/contact`);
    expect(afterWorker.json).toEqual({ name: null, phone: null, shared: false });
    const afterEmployer = await api("emp", "GET", `/api/bookings/${state.booking}/contact`);
    expect(afterEmployer.json).toEqual({ name: null, phone: null, shared: false });
    const rows = (await (await fetch(`${cfg.url}/rest/v1/contact_details?select=user_id`, { headers: { apikey: cfg.anonKey, authorization: `Bearer ${users.emp!.token}` } })).json()) as { user_id: string }[];
    expect(rows.map((r) => r.user_id)).toEqual([users.emp!.id]);
  });

  it("clearing a number removes it", async () => {
    await api("w2", "PUT", "/api/me/contact", { phone: null });
    expect((await api("w2", "GET", "/api/me/contact")).json.phone).toBeNull();
  });

  it("users cannot write contact_details directly", async () => {
    const r = await fetch(`${cfg.url}/rest/v1/contact_details`, {
      method: "POST",
      headers: { apikey: cfg.anonKey, authorization: `Bearer ${users.w1!.token}`, "content-type": "application/json" },
      body: JSON.stringify({ user_id: users.w1!.id, phone: "+919999999999" }),
    });
    expect([401, 403]).toContain(r.status);
  });
});

describe("applicant fit (real data)", () => {
  it("ranks and explains using only facts, and counts genuinely completed jobs as 0 for new workers", async () => {
    await api("w1", "PUT", "/api/me/worker-profile", { locality_id: 1, category_ids: [1], years_experience: 5, skills: ["Lifting"] });
    const r = await api("emp", "GET", `/api/jobs/${state.job}/applicants`);
    const ids = r.json.applicants.map((a: { application_id: string }) => a.application_id);
    expect(ids).toHaveLength(2);
    const w1 = r.json.applicants.find((a: { application_id: string }) => a.application_id === state.a1);
    expect(w1.fit).toMatchObject({ percent: 100, label: "Strong match" });
    expect(w1.fit.reasons).toEqual(expect.arrayContaining(["Offers this type of work", "Works in this job's locality", "5 years of experience", "Skills: Lifting"]));
    expect(w1.completed_jobs).toBe(0);
    // w2 never gave years of experience: excluded, not counted as zero
    const w2 = r.json.applicants.find((a: { application_id: string }) => a.application_id === state.a2);
    expect(w2.years_experience).toBeNull();
    expect(w2.fit.signals_excluded).toContain("experience");
    expect(w2.fit.percent).toBe(100);
  });
});

describe("AI job drafting route without an AI key", () => {
  const body = { text: "I need 8 helpers for a wedding in Alkapuri tomorrow 5 PM to midnight, 800 rupees each." };

  it("answers 503 ai_not_configured to organisers, and creates nothing", async () => {
    const before = (await api("emp", "GET", "/api/employer/jobs")).json.jobs.length;
    const r = await api("emp", "POST", "/api/ai/job-draft", body);
    expect(r.status).toBe(503);
    expect(r.json.error.code).toBe("ai_not_configured");
    expect(r.json.error.message).toMatch(/form/i);
    expect((await api("emp", "GET", "/api/employer/jobs")).json.jobs.length).toBe(before);
    expect((await api("emp", "GET", "/api/ai/status")).json).toEqual({ available: false });
  });

  it("still enforces authentication and role", async () => {
    expect((await api(null, "POST", "/api/ai/job-draft", body)).status).toBe(401);
    expect((await api("w1", "POST", "/api/ai/job-draft", body)).status).toBe(403);
    expect((await api("emp", "POST", "/api/ai/job-draft", { text: "short" })).status).toBe(422);
  });
});
