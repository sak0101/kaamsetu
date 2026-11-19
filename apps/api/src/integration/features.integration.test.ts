// Real Express + real Supabase (LOCAL): server-side search, job locations, completion + reviews, matching-job notifications.
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

async function mkUser(key: string, role: "worker" | "employer", name = `IT ${key}`) {
  const email = `${key}-${randomUUID().slice(0, 8)}@api-it.invalid`;
  const created = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role, full_name: name } });
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
const istAt = (msFromNow: number) => new Date(Date.now() + msFromNow + IST_MS).toISOString().replace(/\.\d{3}Z$/, "+05:30");
const H = 3_600_000;
const istDay = (msFromNow: number) => istAt(msFromNow).slice(0, 10);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function postJob(title: string, startMs: number, durMs = 4 * H, over: Record<string, unknown> = {}) {
  const res = await api("emp", "POST", "/api/jobs", {
    category_id: 1, locality_id: 1, title, description: "Integration test job", starts_at: istAt(startMs), ends_at: istAt(startMs + durMs),
    workers_needed: 2, pay_type: "daily", pay_amount_paise: 80000, ...over,
  });
  expect(res.status, res.text).toBe(201);
  return res.json.id as string;
}

beforeAll(async () => {
  server = createApp({ deps: createSupabaseDeps(cfg) }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await mkUser("emp", "employer", "Searchable Traders");
  await mkUser("w1", "worker");
  await mkUser("w2", "worker");
  await mkUser("far", "worker");
  await mkUser("stranger", "worker");
  // w1/w2: Alkapuri (locality 1), category 1. "far": a different locality, so never matched. "stranger": no profile at all.
  for (const k of ["w1", "w2"]) {
    expect((await api(k, "PUT", "/api/me/worker-profile", { locality_id: 1, category_ids: [1], years_experience: 1 })).status).toBe(200);
  }
  expect((await api("far", "PUT", "/api/me/worker-profile", { locality_id: 2, category_ids: [1] })).status).toBe(200);
});
afterAll(() => server?.close());

const state: Record<string, string> = {};

describe("server-side job search (real PostgREST)", () => {
  it("finds a match that is NOT among the first 20 jobs", async () => {
    // 22 jobs that sort before the target (they start earlier), then the target.
    for (let i = 0; i < 22; i++) await postJob(`Zebra moving helpers ${i}`, (30 + i) * H);
    state.target = await postJob("Quokka decorators wanted", 400 * H);
    const first = await api("w1", "GET", "/api/jobs?locality_id=1&limit=20");
    expect(first.json.jobs).toHaveLength(20);
    expect(first.json.jobs.map((j: any) => j.id)).not.toContain(state.target);

    const hit = await api("w1", "GET", "/api/jobs?locality_id=1&q=quokka");
    expect(hit.status, hit.text).toBe(200);
    expect(hit.json.jobs.map((j: any) => j.id)).toEqual([state.target]);
  });

  it("matches every word, in the title, the description or the employer's name, case-insensitively", async () => {
    expect((await api("w1", "GET", "/api/jobs?q=QUOKKA%20decorators")).json.jobs.map((j: any) => j.id)).toEqual([state.target]);
    expect((await api("w1", "GET", "/api/jobs?q=quokka%20zebra")).json.jobs).toHaveLength(0); // AND, not OR
    expect((await api("w1", "GET", "/api/jobs?q=integration%20quokka")).json.jobs.map((j: any) => j.id)).toEqual([state.target]); // description word
    const byEmployer = await api("w1", "GET", "/api/jobs?q=searchable%20quokka");
    expect(byEmployer.json.jobs.map((j: any) => j.id)).toEqual([state.target]); // employer name word
    expect(byEmployer.json.jobs[0].employer.full_name).toBe("Searchable Traders");
  });

  it("filter-grammar characters in the search text can neither break the query nor widen it", async () => {
    for (const q of ["a),id.eq.1,(title.ilike.%", "100%", "*", "'; drop table jobs; --", "\"quoted\"", "x,y", "(((", "\\"]) {
      const res = await api("w1", "GET", `/api/jobs?q=${encodeURIComponent(q)}`);
      expect(res.status, `${q}: ${res.text}`).toBe(200);
      expect(res.json.jobs.length).toBeLessThanOrEqual(20);
    }
    // a wildcard-only search must not match everything
    expect((await api("w1", "GET", "/api/jobs?q=%25%25")).json.jobs.length).toBe(20); // sanitised to nothing = no keyword filter
    expect((await api("w1", "GET", "/api/jobs?q=nomatchxyz")).json.jobs).toHaveLength(0);
  });

  it("filters by an inclusive IST date range", async () => {
    const day = istDay(400 * H);
    const same = await api("w1", "GET", `/api/jobs?date_from=${day}&date_to=${day}`);
    expect(same.json.jobs.map((j: any) => j.id)).toContain(state.target);
    const before = await api("w1", "GET", `/api/jobs?date_from=${istDay(500 * H)}`);
    expect(before.json.jobs.map((j: any) => j.id)).not.toContain(state.target);
    const range = await api("w1", "GET", `/api/jobs?q=quokka&date_from=${istDay(300 * H)}&date_to=${istDay(450 * H)}`);
    expect(range.json.jobs.map((j: any) => j.id)).toEqual([state.target]);
  });

  it("filters by duration using the generated column, and combines with locality and category", async () => {
    state.long = await postJob("Walrus site clearing", 600 * H, 10 * H);
    state.short = await postJob("Walrus sweeping", 601 * H, 2 * H);
    const long = await api("w1", "GET", "/api/jobs?q=walrus&min_hours=8");
    expect(long.json.jobs.map((j: any) => j.id)).toEqual([state.long]);
    const short = await api("w1", "GET", "/api/jobs?q=walrus&max_hours=4");
    expect(short.json.jobs.map((j: any) => j.id)).toEqual([state.short]);
    const both = await api("w1", "GET", "/api/jobs?q=walrus&min_hours=1&max_hours=12&locality_id=1&category_id=1");
    expect(both.json.jobs).toHaveLength(2);
    expect((await api("w1", "GET", "/api/jobs?q=walrus&locality_id=2")).json.jobs).toHaveLength(0);
  });

  it("keeps paging working with a keyword", async () => {
    const p1 = await api("w1", "GET", "/api/jobs?q=zebra&limit=10&offset=0");
    const p2 = await api("w1", "GET", "/api/jobs?q=zebra&limit=10&offset=10");
    const p3 = await api("w1", "GET", "/api/jobs?q=zebra&limit=10&offset=20");
    expect([p1, p2, p3].map((p) => p.json.jobs.length)).toEqual([10, 10, 2]);
    const ids = [...p1.json.jobs, ...p2.json.jobs, ...p3.json.jobs].map((j: any) => j.id);
    expect(new Set(ids).size).toBe(22);
  });
});

describe("matching-job notifications (real database)", () => {
  it("notifies matching workers once per job, and nobody else", async () => {
    const note = async (k: string) => (await api(k, "GET", "/api/notifications?limit=50")).json.notifications.filter((n: any) => n.type === "new_matching_job");
    const w1 = await note("w1");
    expect(w1.length).toBeGreaterThanOrEqual(22);
    expect(new Set(w1.map((n: any) => n.entity_id)).size).toBe(w1.length); // no duplicates
    expect(w1.some((n: any) => n.entity_id === state.target)).toBe(true);
    expect(w1[0].entity_type).toBe("job");
    expect(Object.keys(w1[0].payload).sort()).toEqual(["job_id", "job_title", "locality_id"]);
    expect(await note("far")).toHaveLength(0);
    expect(await note("stranger")).toHaveLength(0);
    expect(await note("emp")).toHaveLength(0);
  });
});

describe("job locations (real row-level security, through the API)", () => {
  it("the employer saves an address; nobody else sees it until they hold a live booking", async () => {
    state.job = await postJob("Heron stage set-up", 24 * H);
    const put = await api("emp", "PUT", `/api/jobs/${state.job}/location`, { address_line: "12 Race Course Circle", landmark: "Near the fountain" });
    expect(put.status, put.text).toBe(200);
    expect(put.json.location).toEqual({ address_line: "12 Race Course Circle", landmark: "Near the fountain" });

    expect((await api("emp", "GET", `/api/jobs/${state.job}/location`)).json.location).toMatchObject({ address_line: "12 Race Course Circle" });
    for (const k of ["w1", "w2", "stranger", "far"]) {
      expect((await api(k, "GET", `/api/jobs/${state.job}/location`)).json.location, k).toBeNull();
    }
    // never in the public listing or the job detail
    const list = await api("w1", "GET", "/api/jobs?q=heron");
    const detail = await api("w1", "GET", `/api/jobs/${state.job}`);
    expect(list.text + detail.text).not.toMatch(/Race Course|fountain|address/i);

    // applying does not reveal it
    expect((await api("w1", "POST", `/api/jobs/${state.job}/applications`, {})).status).toBe(201);
    expect((await api("w2", "POST", `/api/jobs/${state.job}/applications`, {})).status).toBe(201);
    expect((await api("w1", "GET", `/api/jobs/${state.job}/location`)).json.location).toBeNull();

    // booking reveals it to exactly that worker
    const apps = (await api("emp", "GET", `/api/jobs/${state.job}/applicants`)).json.applicants;
    const forW1 = apps.find((a: any) => a.worker_id === users.w1!.id);
    expect((await api("emp", "POST", `/api/applications/${forW1.application_id}/accept`)).status).toBe(201);
    expect((await api("w1", "GET", `/api/jobs/${state.job}/location`)).json.location).toMatchObject({ address_line: "12 Race Course Circle", landmark: "Near the fountain" });
    expect((await api("w2", "GET", `/api/jobs/${state.job}/location`)).json.location).toBeNull();
  });

  it("only the owner can change or clear it, and validation applies", async () => {
    expect((await api("w1", "PUT", `/api/jobs/${state.job}/location`, { address_line: "99 Hacked Road" })).status).toBe(403);
    await mkUser("emp2", "employer");
    expect((await api("emp2", "PUT", `/api/jobs/${state.job}/location`, { address_line: "99 Hacked Road" })).status).toBe(404);
    expect((await api("emp", "PUT", `/api/jobs/${state.job}/location`, { address_line: "abc" })).status).toBe(422);
    expect((await api("emp", "PUT", `/api/jobs/${state.job}/location`, { address_line: "14 Race Course Circle" })).status).toBe(200);
    expect((await api("w1", "GET", `/api/jobs/${state.job}/location`)).json.location.address_line).toBe("14 Race Course Circle");
    expect((await api("emp", "PUT", `/api/jobs/${state.job}/location`, { address_line: "" })).json.location).toBeNull();
  });

  it("a cancelled booking stops revealing the address", async () => {
    await api("emp", "PUT", `/api/jobs/${state.job}/location`, { address_line: "14 Race Course Circle" });
    const bookings = (await api("w1", "GET", "/api/me/bookings")).json.bookings;
    const b = bookings.find((x: any) => x.job_id === state.job);
    expect((await api("w1", "POST", `/api/bookings/${b.id}/cancel`, {})).status).toBe(204);
    expect((await api("w1", "GET", `/api/jobs/${state.job}/location`)).json.location).toBeNull();
  });
});

describe("completion, no-show and reviews (real database)", () => {
  it("runs the whole lifecycle with the rules enforced", async () => {
    // A job that starts in ~7 s so it can be accepted now and finished after it starts.
    state.life = await postJob("Ibis cleaning crew", 7_000, 2 * H, { workers_needed: 2 });
    for (const k of ["w1", "w2"]) expect((await api(k, "POST", `/api/jobs/${state.life}/applications`, {})).status).toBe(201);
    const apps = (await api("emp", "GET", `/api/jobs/${state.life}/applicants`)).json.applicants;
    for (const a of apps) expect((await api("emp", "POST", `/api/applications/${a.application_id}/accept`)).status).toBe(201);
    const bookings = (await api("emp", "GET", "/api/me/bookings")).json.bookings.filter((b: any) => b.job_id === state.life);
    expect(bookings).toHaveLength(2);
    const b1 = bookings.find((b: any) => b.worker_id === users.w1!.id).id as string;
    const b2 = bookings.find((b: any) => b.worker_id === users.w2!.id).id as string;

    // not started yet
    const early = await api("emp", "POST", `/api/bookings/${b1}/finish`, { outcome: "completed" });
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe("job_not_started");

    await sleep(8_000);

    expect((await api("w1", "POST", `/api/bookings/${b1}/finish`, { outcome: "completed" })).status).toBe(403); // a worker cannot
    expect((await api("emp2", "POST", `/api/bookings/${b1}/finish`, { outcome: "completed" })).status).toBe(404); // another employer
    expect((await api("emp", "POST", `/api/bookings/${b1}/finish`, { outcome: "completed" })).status).toBe(204);
    expect((await api("emp", "POST", `/api/bookings/${b2}/finish`, { outcome: "no_show" })).status).toBe(204);
    expect((await api("emp", "POST", `/api/bookings/${b1}/finish`, { outcome: "no_show" })).json.error.code).toBe("booking_not_finishable");

    const job = (await api("w1", "GET", `/api/jobs/${state.life}`)).json.job;
    expect(job.positions_filled).toBe(1); // completed keeps its slot, no-show released it

    // reviews: only on the completed booking, by its two parties, once each
    expect((await api("w2", "POST", `/api/bookings/${b2}/review`, { rating: 1 })).json.error.code).toBe("booking_not_completed"); // the no-show
    expect((await api("stranger", "POST", `/api/bookings/${b1}/review`, { rating: 5 })).status).toBe(404);
    expect((await api("w2", "POST", `/api/bookings/${b1}/review`, { rating: 5 })).status).toBe(404); // w2 is not part of b1
    expect((await api("w1", "POST", `/api/bookings/${b1}/review`, { rating: 7 })).status).toBe(422);
    expect((await api("emp", "POST", `/api/bookings/${b1}/review`, { rating: 4, comment: "Turned up on time" })).status).toBe(201);
    expect((await api("w1", "POST", `/api/bookings/${b1}/review`, { rating: 5 })).status).toBe(201);
    expect((await api("emp", "POST", `/api/bookings/${b1}/review`, { rating: 1 })).json.error.code).toBe("already_reviewed");

    // visibility of reviews
    expect((await api("w1", "GET", "/api/me/reviews")).json.reviews).toHaveLength(2);
    expect((await api("emp", "GET", "/api/me/reviews")).json.reviews).toHaveLength(2);
    expect((await api("w2", "GET", "/api/me/reviews")).json.reviews).toHaveLength(0);
    expect((await api("stranger", "GET", "/api/me/reviews")).json.reviews).toHaveLength(0);

    // facts on a later job: reviewed worker, no-show worker, brand-new worker (no penalty)
    state.next = await postJob("Ibis follow-up", 48 * H);
    for (const k of ["w1", "w2", "far"]) await api(k, "POST", `/api/jobs/${state.next}/applications`, {});
    const facts = (await api("emp", "GET", `/api/jobs/${state.next}/applicants`)).json.applicants;
    const f = (k: string) => facts.find((a: any) => a.worker_id === users[k]!.id);
    expect(f("w1")).toMatchObject({ completed_jobs: 1, no_show_count: 0, review_count: 1, avg_rating: 4 });
    expect(f("w2")).toMatchObject({ completed_jobs: 0, no_show_count: 1, review_count: 0, avg_rating: null });
    expect(f("far")).toMatchObject({ completed_jobs: 0, no_show_count: 0, review_count: 0, avg_rating: null });
    expect(f("far").fit.notes.join(" ")).toMatch(/isn't held against them/);
    expect(f("w1").fit.reasons).toContain("Rated 4.0 out of 5 from 1 review");
  });
});
