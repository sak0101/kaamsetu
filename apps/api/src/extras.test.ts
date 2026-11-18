import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { APP_ID, BOOKING_ID, EMPLOYER_ID, JOB_ID, OTHER_ID, WORKER_ID, makeFake, startApp } from "./test-support";

const fake = makeFake();
let app: Awaited<ReturnType<typeof startApp>>;
const E = "tok-employer";
const W = "tok-worker";
const lastRpc = () => fake.state.rpcCalls.at(-1);

beforeAll(async () => {
  app = await startApp(fake.deps);
});
afterAll(() => app.close());
beforeEach(() => {
  fake.state.rpcCalls.length = 0;
  fake.state.readCalls.length = 0;
  fake.state.rpcResults = {};
  fake.state.bookings = [];
  fake.state.contacts = {};
});

describe("worker profile extras", () => {
  it("passes skills and the availability note to the database function", async () => {
    await app.call("PUT", "/api/me/worker-profile", {
      token: W,
      body: { locality_id: 1, skills: ["Guest handling", "Stage setup"], availability_note: "Evenings and weekends" },
    });
    expect(lastRpc()?.args).toMatchObject({ p_skills: ["Guest handling", "Stage setup"], p_availability_note: "Evenings and weekends", p_actor: WORKER_ID });
  });

  it.each([
    ["too many skills", { skills: Array.from({ length: 9 }, (_, i) => `skill ${i}`) }],
    ["a 1-character skill", { skills: ["a"] }],
    ["a 41-character skill", { skills: ["x".repeat(41)] }],
    ["an over-long availability note", { availability_note: "y".repeat(121) }],
  ])("rejects %s", async (_n, extra) => {
    const res = await app.call("PUT", "/api/me/worker-profile", { token: W, body: { locality_id: 1, ...extra } });
    expect(res.status).toBe(422);
    expect(fake.state.rpcCalls).toHaveLength(0);
  });
});

describe("contact phone", () => {
  it("saves, reads and clears the caller's own number", async () => {
    fake.state.contacts[WORKER_ID] = "+919876543210";
    expect((await app.call("GET", "/api/me/contact", { token: W })).json).toEqual({ phone: "+919876543210" });
    const put = await app.call("PUT", "/api/me/contact", { token: W, body: { phone: "98765 43210" } });
    expect(put.status).toBe(200);
    expect(lastRpc()).toEqual({ fn: "save_contact", args: { p_phone: "98765 43210", p_actor: WORKER_ID } });
    await app.call("PUT", "/api/me/contact", { token: W, body: { phone: null } });
    expect(lastRpc()?.args.p_phone).toBeNull();
  });

  it("rejects malformed bodies and never accepts a user id", async () => {
    expect((await app.call("PUT", "/api/me/contact", { token: W, body: { phone: "9".repeat(21) } })).status).toBe(422);
    expect((await app.call("PUT", "/api/me/contact", { token: W, body: { phone: "9876543210", user_id: OTHER_ID } })).status).toBe(422);
    expect((await app.call("PUT", "/api/me/contact", { token: W, body: {} })).status).toBe(422);
    expect((await app.call("PUT", "/api/me/contact")).status).toBe(401);
  });

  it("maps an invalid phone from the database to 422", async () => {
    fake.state.rpcResults.save_contact = { data: null, error: { code: "KS422", message: "invalid_phone" } };
    const res = await app.call("PUT", "/api/me/contact", { token: W, body: { phone: "123" } });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("invalid_phone");
  });

  describe("GET /api/bookings/:id/contact", () => {
    const booking = (status: string) => ({
      id: BOOKING_ID, job_id: JOB_ID, application_id: APP_ID, worker_id: WORKER_ID, employer_id: EMPLOYER_ID,
      agreed_pay_paise: 90000, status, cancelled_by: null, cancelled_at: null, cancel_reason: null, completed_at: null,
      created_at: "2026-11-20T10:00:00+00:00",
    });

    it("gives the other side's phone while the booking is live", async () => {
      fake.state.bookings = [booking("confirmed")];
      fake.state.contacts[EMPLOYER_ID] = "+919123456789";
      const res = await app.call("GET", `/api/bookings/${BOOKING_ID}/contact`, { token: W });
      expect(res.json).toEqual({ name: "Employer One", phone: "+919123456789", shared: true });
      fake.state.contacts[WORKER_ID] = "+919876543210";
      const asEmployer = await app.call("GET", `/api/bookings/${BOOKING_ID}/contact`, { token: E });
      expect(asEmployer.json).toEqual({ name: "Worker One", phone: "+919876543210", shared: true });
      // it asks for the COUNTERPART, never the caller
      expect(fake.state.readCalls.filter((c) => c.method === "contact").map((c) => c.arg)).toEqual([EMPLOYER_ID, WORKER_ID]);
    });

    it("shares nothing once the booking is cancelled or finished", async () => {
      for (const status of ["cancelled_by_worker", "cancelled_by_employer", "completed", "no_show"]) {
        fake.state.bookings = [booking(status)];
        fake.state.contacts[EMPLOYER_ID] = "+919123456789";
        const res = await app.call("GET", `/api/bookings/${BOOKING_ID}/contact`, { token: W });
        expect(res.json).toEqual({ name: null, phone: null, shared: false });
      }
    });

    it("404s for a booking the caller isn't part of (row-level security hides it)", async () => {
      expect((await app.call("GET", `/api/bookings/${BOOKING_ID}/contact`, { token: W })).status).toBe(404);
      expect((await app.call("GET", "/api/bookings/not-a-uuid/contact", { token: W })).status).toBe(422);
      expect((await app.call("GET", `/api/bookings/${BOOKING_ID}/contact`)).status).toBe(401);
    });

    it("reports a live booking with no number on file without inventing one", async () => {
      fake.state.bookings = [booking("confirmed")];
      const res = await app.call("GET", `/api/bookings/${BOOKING_ID}/contact`, { token: W });
      expect(res.json).toEqual({ name: "Employer One", phone: null, shared: true });
    });
  });
});

describe("ranked applicants", () => {
  it("returns applicants best-fit first, with anyone double-booked last", async () => {
    const row = (id: string, over: Record<string, unknown>) => ({
      application_id: id, worker_id: id, worker_name: id, application_status: "pending", applied_at: "2026-11-20T10:00:00Z", message: null,
      category_match: true, locality_match: "same_locality", years_experience: 3, has_booking_conflict: false,
      bio: null, skills: [], availability_note: null, member_since: "2026-11-01T00:00:00Z", completed_jobs: 0, ...over,
    });
    fake.state.rpcResults.get_applicant_signals = {
      data: [
        row("busy", { has_booking_conflict: true }),
        row("weak", { category_match: false, locality_match: "different_locality", years_experience: 0 }),
        row("strong", {}),
      ],
      error: null,
    };
    const res = await app.call("GET", `/api/jobs/${JOB_ID}/applicants`, { token: E });
    expect(res.json.applicants.map((a: { application_id: string }) => a.application_id)).toEqual(["strong", "weak", "busy"]);
  });
});
