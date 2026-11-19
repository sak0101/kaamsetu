import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { nextDay, searchWords } from "./supabase";
import { BOOKING_ID, EMPLOYER_ID, JOB_ID, makeFake, startApp } from "./test-support";

const fake = makeFake();
let app: Awaited<ReturnType<typeof startApp>>;
beforeAll(async () => {
  app = await startApp(fake.deps);
});
afterAll(() => app.close());
beforeEach(() => {
  fake.state.rpcCalls.length = 0;
  fake.state.readCalls.length = 0;
  fake.state.rpcResults = {};
  fake.state.location = null;
  fake.state.reviews = [];
});

const E = "tok-employer";
const W = "tok-worker";
const lastRpc = () => fake.state.rpcCalls.at(-1);
const lastRead = (m: string) => fake.state.readCalls.filter((c) => c.method === m).at(-1)?.arg as Record<string, unknown> | undefined;

describe("server-side job search", () => {
  it("passes keyword, date range and duration filters to the read layer together with locality, category and paging", async () => {
    const res = await app.call("GET", "/api/jobs?locality_id=1&category_id=2&q=sofa%20packing&date_from=2026-11-21&date_to=2026-11-27&min_hours=2&max_hours=8&limit=10&offset=20", { token: W });
    expect(res.status).toBe(200);
    expect(lastRead("openJobs")).toEqual({
      localityId: 1, categoryId: 2, q: "sofa packing", dateFrom: "2026-11-21", dateTo: "2026-11-27", minHours: 2, maxHours: 8, limit: 10, offset: 20,
    });
    expect(res.json.page).toEqual({ limit: 10, offset: 20 });
  });

  it("still works with no filters (backward compatible)", async () => {
    const res = await app.call("GET", "/api/jobs", { token: W });
    expect(res.status).toBe(200);
    expect(lastRead("openJobs")).toMatchObject({ localityId: undefined, q: undefined, dateFrom: undefined, limit: 20, offset: 0 });
  });

  it.each([
    ["a malformed date", "date_from=tomorrow"],
    ["an impossible date", "date_from=2026-13-45"],
    ["a reversed date range", "date_from=2026-11-27&date_to=2026-11-21"],
    ["a reversed duration range", "min_hours=8&max_hours=2"],
    ["an over-long search", `q=${"x".repeat(81)}`],
    ["an unknown parameter", "employer_id=abc"],
  ])("rejects %s with 422", async (_label, qs) => {
    const res = await app.call("GET", `/api/jobs?${qs}`, { token: W });
    expect(res.status).toBe(422);
    expect(res.json.error.code).toBe("validation_error");
  });

  it("is for workers only", async () => {
    expect((await app.call("GET", "/api/jobs?q=sofa", { token: E })).status).toBe(403);
  });
});

describe("search helpers", () => {
  it("neutralises everything that could alter a PostgREST filter, keeping real words (including Hindi and Gujarati)", () => {
    expect(searchWords("sofa, packing")).toEqual(["sofa", "packing"]);
    expect(searchWords("a)),id.eq.1,(title.ilike.%")).toEqual(["id", "eq", "title", "ilike"]); // no operators, wildcards or parentheses survive
    expect(searchWords("100% *wild* _under_")).toEqual(["100", "wild", "under"]);
    expect(searchWords("सफाई  ફર્નિચર")).toEqual(["सफाई", "ફર્નિચર"]);
    expect(searchWords("a b one two three four five")).toEqual(["one", "two", "three", "four"]); // 2+ letters, at most 4 words
    expect(searchWords(undefined)).toEqual([]);
    expect(searchWords("   ")).toEqual([]);
  });

  it("computes the next IST calendar day without time-zone drift", () => {
    expect(nextDay("2026-11-30")).toBe("2026-12-01");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(nextDay("2028-02-28")).toBe("2028-02-29");
  });
});

describe("job location", () => {
  it("the employer saves an address and landmark through the secure RPC, with p_actor injected last", async () => {
    fake.state.location = { address_line: "12 Race Course Circle", landmark: "Near the fountain" };
    const res = await app.call("PUT", `/api/jobs/${JOB_ID}/location`, { token: E, body: { address_line: "  12 Race Course Circle ", landmark: "Near the fountain" } });
    expect(res.status).toBe(200);
    expect(lastRpc()).toEqual({
      fn: "save_job_location",
      args: { p_job_id: JOB_ID, p_address_line: "12 Race Course Circle", p_landmark: "Near the fountain", p_actor: EMPLOYER_ID },
    });
    expect(res.json.location).toEqual({ address_line: "12 Race Course Circle", landmark: "Near the fountain" });
  });

  it("a blank address is passed through so the database clears it", async () => {
    await app.call("PUT", `/api/jobs/${JOB_ID}/location`, { token: E, body: { address_line: "   " } });
    expect(lastRpc()?.args).toMatchObject({ p_address_line: "", p_landmark: null });
  });

  it("workers cannot set a location, and the body is strict", async () => {
    expect((await app.call("PUT", `/api/jobs/${JOB_ID}/location`, { token: W, body: { address_line: "12 Race Course Circle" } })).status).toBe(403);
    const bad = await app.call("PUT", `/api/jobs/${JOB_ID}/location`, { token: E, body: { address_line: "12 Race Course Circle", employer_id: EMPLOYER_ID } });
    expect(bad.status).toBe(422);
    expect((await app.call("PUT", `/api/jobs/${JOB_ID}/location`, { token: E, body: { address_line: "x".repeat(201) } })).status).toBe(422);
    expect(fake.state.rpcCalls).toHaveLength(0);
  });

  it("maps database refusals (another employer's job is a 404, a cancelled job a 409)", async () => {
    fake.state.rpcResults.save_job_location = { data: null, error: { code: "KS404", message: "job_not_found" } };
    expect((await app.call("PUT", `/api/jobs/${JOB_ID}/location`, { token: E, body: { address_line: "12 Race Course Circle" } })).status).toBe(404);
    fake.state.rpcResults.save_job_location = { data: null, error: { code: "KS409", message: "job_not_editable" } };
    const res = await app.call("PUT", `/api/jobs/${JOB_ID}/location`, { token: E, body: { address_line: "12 Race Course Circle" } });
    expect(res.status).toBe(409);
    expect(res.json.error.code).toBe("job_not_editable");
  });

  it("reading returns what row-level security allows, and null otherwise (indistinguishable from no address)", async () => {
    fake.state.location = { address_line: "12 Race Course Circle", landmark: null };
    expect((await app.call("GET", `/api/jobs/${JOB_ID}/location`, { token: W })).json).toEqual({ location: { address_line: "12 Race Course Circle", landmark: null } });
    fake.state.location = null;
    expect((await app.call("GET", `/api/jobs/${JOB_ID}/location`, { token: W })).json).toEqual({ location: null });
  });

  it("the job listing and job detail never contain an address", async () => {
    fake.state.location = { address_line: "SECRET 12 Race Course Circle", landmark: "SECRET" };
    const list = await app.call("GET", "/api/jobs", { token: W });
    const detail = await app.call("GET", `/api/jobs/${JOB_ID}`, { token: W });
    expect(list.text + detail.text).not.toMatch(/SECRET|address/i);
  });
});

describe("completion and reviews", () => {
  it("the employer records completed or no-show; the outcome is validated", async () => {
    const ok = await app.call("POST", `/api/bookings/${BOOKING_ID}/finish`, { token: E, body: { outcome: "no_show" } });
    expect(ok.status).toBe(204);
    expect(lastRpc()).toEqual({ fn: "finish_booking", args: { p_booking_id: BOOKING_ID, p_outcome: "no_show", p_actor: EMPLOYER_ID } });
    for (const outcome of ["cancelled_by_worker", "confirmed", "", 1]) {
      expect((await app.call("POST", `/api/bookings/${BOOKING_ID}/finish`, { token: E, body: { outcome } })).status).toBe(422);
    }
    expect((await app.call("POST", `/api/bookings/${BOOKING_ID}/finish`, { token: W, body: { outcome: "completed" } })).status).toBe(403);
  });

  it("surfaces the database's timing and state rules", async () => {
    fake.state.rpcResults.finish_booking = { data: null, error: { code: "KS409", message: "job_not_started" } };
    const early = await app.call("POST", `/api/bookings/${BOOKING_ID}/finish`, { token: E, body: { outcome: "completed" } });
    expect(early.status).toBe(409);
    expect(early.json.error.code).toBe("job_not_started");
    expect(early.json.error.message).toMatch(/after the job has started/);
  });

  it("submits a review without letting the caller name the reviewee", async () => {
    const res = await app.call("POST", `/api/bookings/${BOOKING_ID}/review`, { token: W, body: { rating: 4, comment: "  On time  " } });
    expect(res.status).toBe(201);
    expect(lastRpc()?.fn).toBe("submit_review");
    expect(lastRpc()?.args).toMatchObject({ p_booking_id: BOOKING_ID, p_rating: 4, p_comment: "On time" });
    expect(Object.keys(lastRpc()!.args).sort()).toEqual(["p_actor", "p_booking_id", "p_comment", "p_rating"]);
    const forged = await app.call("POST", `/api/bookings/${BOOKING_ID}/review`, { token: W, body: { rating: 5, reviewee_id: EMPLOYER_ID } });
    expect(forged.status).toBe(422);
  });

  it.each([[0], [6], [3.5], ["5"], [null]])("rejects rating %s", async (rating) => {
    expect((await app.call("POST", `/api/bookings/${BOOKING_ID}/review`, { token: W, body: { rating } })).status).toBe(422);
  });

  it("maps duplicate and not-completed reviews to clear 409s", async () => {
    fake.state.rpcResults.submit_review = { data: null, error: { code: "KS409", message: "already_reviewed" } };
    const dup = await app.call("POST", `/api/bookings/${BOOKING_ID}/review`, { token: W, body: { rating: 5 } });
    expect(dup.status).toBe(409);
    expect(dup.json.error.code).toBe("already_reviewed");
    fake.state.rpcResults.submit_review = { data: null, error: { code: "KS409", message: "booking_not_completed" } };
    expect((await app.call("POST", `/api/bookings/${BOOKING_ID}/review`, { token: W, body: { rating: 5 } })).json.error.code).toBe("booking_not_completed");
  });

  it("lists only the reviews the database lets the caller read", async () => {
    fake.state.reviews = [{ id: "r1", booking_id: BOOKING_ID, reviewer_id: EMPLOYER_ID, reviewee_id: "w", rating: 5, comment: null, created_at: "2026-11-20T10:00:00Z" }];
    const res = await app.call("GET", "/api/me/reviews", { token: W });
    expect(res.json.reviews).toHaveLength(1);
  });

  it("applicant facts expose no-shows and reviews but still no score", async () => {
    fake.state.rpcResults.get_applicant_signals = {
      data: [{
        application_id: "a", worker_id: "w", worker_name: "Worker One", application_status: "pending", applied_at: "2026-11-20T10:00:00Z", message: null,
        category_match: true, locality_match: "same_locality", years_experience: 3, has_booking_conflict: false, bio: null, skills: [], availability_note: null,
        member_since: "2026-11-01T00:00:00Z", completed_jobs: 4, no_show_count: 1, review_count: 3, avg_rating: 4.3,
      }],
      error: null,
    };
    const a = (await app.call("GET", `/api/jobs/${JOB_ID}/applicants`, { token: E })).json.applicants[0];
    expect(a).toMatchObject({ no_show_count: 1, review_count: 3, avg_rating: 4.3 });
    expect(a.fit.reasons).toContain("Rated 4.3 out of 5 from 3 reviews");
    expect(a.fit.notes).toContain("Recorded as a no-show 1 time by employers");
    expect(Object.keys(a).some((k) => /score|rank|reliab/i.test(k))).toBe(false);
  });
});
