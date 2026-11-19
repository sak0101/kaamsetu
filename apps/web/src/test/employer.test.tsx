import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRoutes, installFetch, job, meFor, renderApp, signInAs, EMPLOYER_ID, WORKER_ID } from "./helpers";
import { fakeSupabase } from "./fakeSupabase";
import { canCancelBooking } from "../pages/Bookings";
import type { Applicant, Booking } from "../lib/types";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

beforeEach(() => {
  fakeSupabase.reset();
  signInAs("employer");
});
afterEach(() => vi.unstubAllGlobals());

const J1 = job();
const applicant = (over: Partial<Applicant> = {}): Applicant => ({
  application_id: "55555555-5555-4555-8555-555555555555",
  worker_id: WORKER_ID,
  worker_name: "Ravi Patel",
  application_status: "pending",
  applied_at: "2026-11-20T10:00:00+00:00",
  message: "I can start early",
  category_match: true,
  locality_match: "same_locality",
  years_experience: 3,
  has_booking_conflict: false,
  bio: null,
  skills: [],
  availability_note: null,
  member_since: "2026-11-01T00:00:00+00:00",
  completed_jobs: 0,
  no_show_count: 0,
  review_count: 0,
  avg_rating: null,
  fit: {
    percent: 100,
    label: "Strong match",
    reasons: ["Offers this type of work", "Works in this job's locality", "3 years of experience"],
    notes: ["New to KaamSetu: no completed jobs yet. This isn't held against them"],
    signals_used: ["category", "locality", "experience"],
    signals_excluded: ["reviews", "reliability"],
    has_conflict: false,
  },
  ...over,
});
const jobRoutes = (applicants: Applicant[], j = J1) => ({
  ...baseRoutes("employer"),
  [`GET /api/jobs/${j.id}`]: { json: { job: j, my_application: null } },
  [`GET /api/jobs/${j.id}/applicants`]: { json: { applicants } },
});

describe("my jobs", () => {
  it("lists posted jobs with booked counts and how many applicants are waiting", async () => {
    installFetch({
      ...baseRoutes("employer"),
      "GET /api/employer/jobs": { json: { jobs: [{ ...J1, employer: undefined }], page: { limit: 20, offset: 0 } } },
      [`GET /api/jobs/${J1.id}/applicants`]: { json: { applicants: [applicant(), applicant({ application_id: "b", application_status: "rejected" })] } },
    });
    renderApp("/employer");
    expect(await screen.findByRole("link", { name: "Shift household goods" })).toHaveAttribute("href", `/employer/jobs/${J1.id}`);
    expect(await screen.findByText("1 waiting for your decision")).toBeInTheDocument();
    expect(screen.getByText(/0 of 2 booked/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Manage" })).toBeInTheDocument();
  });

  it("shows zero-applicant and cancelled jobs correctly", async () => {
    installFetch({
      ...baseRoutes("employer"),
      "GET /api/employer/jobs": { json: { jobs: [J1, { ...job({ id: "99999999-9999-4999-8999-999999999999", title: "Old cancelled job", status: "cancelled" }) }], page: { limit: 20, offset: 0 } } },
      [`GET /api/jobs/${J1.id}/applicants`]: { json: { applicants: [] } },
    });
    renderApp("/employer");
    expect(await screen.findByText("No applicants yet")).toBeInTheDocument();
    expect(screen.getByText("Cancelled")).toBeInTheDocument();
  });

  it("shows an empty state that invites the first posting", async () => {
    installFetch({ ...baseRoutes("employer"), "GET /api/employer/jobs": { json: { jobs: [], page: { limit: 20, offset: 0 } } } });
    renderApp("/employer");
    expect(await screen.findByText("You haven't posted any jobs yet")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Post your first job" })).toHaveAttribute("href", "/employer/jobs/new");
  });

  it("shows an error with a retry", async () => {
    const f = installFetch({ ...baseRoutes("employer"), "GET /api/employer/jobs": { status: 500, json: { error: { code: "internal_error", message: "Something went wrong." } } } });
    renderApp("/employer");
    expect(await screen.findByRole("alert")).toBeInTheDocument();
    f.set("GET /api/employer/jobs", { json: { jobs: [], page: { limit: 20, offset: 0 } } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("You haven't posted any jobs yet")).toBeInTheDocument();
  });
});

describe("post a job", () => {
  const futureDate = () => {
    const d = new Date(Date.now() + 3 * 86_400_000 + 5.5 * 3_600_000);
    return d.toISOString().slice(0, 10); // IST calendar date three days ahead
  };

  it("validates every field and sends nothing until the form is valid", async () => {
    const f = installFetch({ ...baseRoutes("employer") });
    renderApp("/employer/jobs/new");
    await screen.findByRole("option", { name: "Gotri" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Post job" }));
    expect(await screen.findByText("Choose the type of work.")).toBeInTheDocument();
    expect(screen.getByText("Choose where the work is.")).toBeInTheDocument();
    expect(screen.getByText(/enter a short title/i)).toBeInTheDocument();
    expect(screen.getByText(/describe the work/i)).toBeInTheDocument();
    expect(screen.getByText("Choose the date.")).toBeInTheDocument();
    expect(screen.getByText(/enter the pay in rupees/i)).toBeInTheDocument();
    expect(f.callsTo("POST /api/jobs")).toHaveLength(0);
    // each invalid control is announced as invalid
    expect(screen.getByLabelText(/^Job title/)).toHaveAttribute("aria-invalid", "true");
  });

  it("creates the job with IST times and paise, then opens its management page", async () => {
    const date = futureDate();
    const created = job({ id: "88888888-8888-4888-8888-888888888888", title: "Move a sofa set" });
    const f = installFetch({
      ...baseRoutes("employer"),
      "POST /api/jobs": { status: 201, json: { id: created.id } },
      [`GET /api/jobs/${created.id}`]: { json: { job: created, my_application: null } },
      [`GET /api/jobs/${created.id}/applicants`]: { json: { applicants: [] } },
    });
    renderApp("/employer/jobs/new");
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Gotri" });
    await user.type(screen.getByLabelText(/^Job title/), "Move a sofa set");
    await user.selectOptions(screen.getByLabelText(/^Type of work/), "1");
    await user.selectOptions(screen.getByLabelText(/^Locality in Vadodara/), "2");
    await user.type(screen.getByLabelText(/^What needs to be done/), "Two flights of stairs");
    await user.type(screen.getByLabelText(/^Date/), date);
    await user.clear(screen.getByLabelText(/^Workers needed/));
    await user.type(screen.getByLabelText(/^Workers needed/), "3");
    await user.selectOptions(screen.getByLabelText(/^Pay is/), "hourly");
    await user.type(screen.getByLabelText(/^Amount/), "120.50");
    expect(screen.getByText(/₹120\.50 per hour/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Post job" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Move a sofa set" })).toBeInTheDocument();
    expect(screen.getByText("Job posted. Workers can now apply.")).toBeInTheDocument();
    expect(f.callsTo("POST /api/jobs")[0]?.body).toEqual({
      category_id: 1,
      locality_id: 2,
      title: "Move a sofa set",
      description: "Two flights of stairs",
      starts_at: `${date}T09:00:00+05:30`,
      ends_at: `${date}T13:00:00+05:30`,
      workers_needed: 3,
      pay_type: "hourly",
      pay_amount_paise: 12050,
    });
  });

  it("shows server-side errors without losing what was typed", async () => {
    const date = futureDate();
    installFetch({
      ...baseRoutes("employer"),
      "POST /api/jobs": { status: 422, json: { error: { code: "starts_at_must_be_future", message: "The start time must be in the future." } } },
    });
    renderApp("/employer/jobs/new");
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Gotri" });
    await user.type(screen.getByLabelText(/^Job title/), "Move a sofa set");
    await user.selectOptions(screen.getByLabelText(/^Type of work/), "1");
    await user.selectOptions(screen.getByLabelText(/^Locality in Vadodara/), "1");
    await user.type(screen.getByLabelText(/^What needs to be done/), "Stairs");
    await user.type(screen.getByLabelText(/^Date/), date);
    await user.type(screen.getByLabelText(/^Amount/), "850");
    await user.click(screen.getByRole("button", { name: "Post job" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("The start time must be in the future.");
    expect(screen.getByLabelText(/^Job title/)).toHaveValue("Move a sofa set");
  });
});

describe("applicants: evidence, accept, decline", () => {
  it("explains why each worker is recommended, using only facts (no ratings or stars)", async () => {
    const sunil = applicant({
      application_id: "b",
      worker_name: "Sunil Rao",
      category_match: false,
      locality_match: "unknown",
      years_experience: null,
      message: null,
      fit: {
        percent: 0,
        label: "Weak match",
        reasons: [],
        notes: [
          "Doesn't list this type of work",
          "Locality not provided, so it isn't counted for or against them",
          "Experience not provided, so it isn't counted for or against them",
          "New to KaamSetu: no completed jobs yet. This isn't held against them",
        ],
        signals_used: ["category"],
        signals_excluded: ["locality", "experience", "reviews", "reliability"],
        has_conflict: false,
      },
    });
    installFetch(jobRoutes([applicant({ bio: "Worked at weddings for 3 years.", skills: ["Guest handling", "Stage setup"] }), sunil]));
    renderApp(`/employer/jobs/${J1.id}`);

    const ravi = await screen.findByRole("article", { name: "Applicant Ravi Patel" });
    expect(within(ravi).getByText("Strong match · 100%")).toBeInTheDocument();
    expect(within(ravi).getByRole("list", { name: "Why Ravi Patel fits this job" })).toHaveTextContent("Offers this type of work");
    expect(within(ravi).getByText("3 years of experience")).toBeInTheDocument();
    expect(within(ravi).getByText("Worked at weddings for 3 years.")).toBeInTheDocument();
    expect(within(ravi).getByRole("list", { name: "Skills" })).toHaveTextContent("Guest handling");
    expect(within(ravi).getByText(/I can start early/)).toBeInTheDocument();

    const s = screen.getByRole("article", { name: "Applicant Sunil Rao" });
    expect(within(s).getByText("Weak match · 0%")).toBeInTheDocument();
    expect(within(s).getByText("Doesn't list this type of work")).toBeInTheDocument();
    // missing information is never counted against them, and says so
    expect(within(s).getByText("Locality not provided, so it isn't counted for or against them")).toBeInTheDocument();
    expect(within(s).getByText("Experience not provided, so it isn't counted for or against them")).toBeInTheDocument();
    expect(within(s).queryByText(/\b0 years\b/)).not.toBeInTheDocument();
    // a worker with no history is told they aren't penalised for it
    expect(within(s).getByText(/New to KaamSetu: no completed jobs yet\. This isn't held against them/)).toBeInTheDocument();

    expect(screen.getByText(/Anything a worker hasn't shared is left out, never counted against them/)).toBeInTheDocument();
    expect(screen.getByText(/You make the final decision/)).toBeInTheDocument();
    // no star ratings, review scores or reliability measures are shown or implied
    expect(document.body.textContent).not.toMatch(/\b(stars?|rated|rating of|review score|reliability score|trust score)\b/i);
  });

  it("lists applicants in the order the API ranks them (best fit first)", async () => {
    installFetch(
      jobRoutes([
        applicant({ application_id: "x1", worker_name: "First Strong" }),
        applicant({ application_id: "x2", worker_name: "Second Partial", fit: { ...applicant().fit, percent: 50, label: "Partial match" } }),
      ]),
    );
    renderApp(`/employer/jobs/${J1.id}`);
    await screen.findByRole("article", { name: "Applicant First Strong" });
    const names = screen.getAllByRole("heading", { level: 3 }).map((h) => h.textContent);
    expect(names.indexOf("First Strong")).toBeLessThan(names.indexOf("Second Partial"));
  });

  it("shows genuine completed-job history when it exists", async () => {
    installFetch(
      jobRoutes([
        applicant({
          completed_jobs: 4,
          fit: { ...applicant().fit, reasons: ["Offers this type of work", "Completed 4 jobs through KaamSetu"], notes: [] },
        }),
      ]),
    );
    renderApp(`/employer/jobs/${J1.id}`);
    expect(await screen.findByText("Completed 4 jobs through KaamSetu")).toBeInTheDocument();
  });

  it("accepts an applicant through the API and shows confirmation", async () => {
    const a = applicant();
    const f = installFetch({ ...jobRoutes([a]), [`POST /api/applications/${a.application_id}/accept`]: { status: 201, json: { booking_id: "b1" } } });
    renderApp(`/employer/jobs/${J1.id}`);
    await screen.findByRole("article", { name: "Applicant Ravi Patel" });
    f.set(`GET /api/jobs/${J1.id}/applicants`, { json: { applicants: [{ ...a, application_status: "accepted" }] } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Accept and book" }));
    expect(await screen.findByText("Ravi Patel is booked.")).toBeInTheDocument();
    expect(f.callsTo(`POST /api/applications/${a.application_id}/accept`)).toHaveLength(1);
    expect(await screen.findByText("Booked")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Accept and book" })).not.toBeInTheDocument();
  });

  it("keeps the error visible when acceptance fails (e.g. job already full)", async () => {
    const a = applicant();
    installFetch({
      ...jobRoutes([a]),
      [`POST /api/applications/${a.application_id}/accept`]: { status: 409, json: { error: { code: "job_full", message: "This job already has all the workers it needs." } } },
    });
    renderApp(`/employer/jobs/${J1.id}`);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Accept and book" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("This job already has all the workers it needs.");
    expect(screen.getByRole("button", { name: "Accept and book" })).toBeEnabled();
  });

  it("blocks accepting a worker who has an overlapping confirmed booking", async () => {
    installFetch(jobRoutes([applicant({ has_booking_conflict: true })]));
    renderApp(`/employer/jobs/${J1.id}`);
    expect(await screen.findByText(/already confirmed for another job at an overlapping time/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Accept and book" })).toBeDisabled();
  });

  it("declines with an optional reason", async () => {
    const a = applicant();
    const f = installFetch({ ...jobRoutes([a]), [`POST /api/applications/${a.application_id}/reject`]: { status: 204 } });
    renderApp(`/employer/jobs/${J1.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Decline" }));
    await user.type(screen.getByLabelText(/reason/i), "Need someone with a truck");
    f.set(`GET /api/jobs/${J1.id}/applicants`, { json: { applicants: [{ ...a, application_status: "rejected" }] } });
    await user.click(screen.getByRole("button", { name: "Decline applicant" }));
    expect(await screen.findByText("Ravi Patel's application was declined.")).toBeInTheDocument();
    expect(f.callsTo(`POST /api/applications/${a.application_id}/reject`)[0]?.body).toEqual({ reason: "Need someone with a truck" });
    expect(await screen.findByText("Declined")).toBeInTheDocument();
  });

  it("shows an empty state when nobody has applied", async () => {
    installFetch(jobRoutes([]));
    renderApp(`/employer/jobs/${J1.id}`);
    expect(await screen.findByText("No applicants yet")).toBeInTheDocument();
  });

  it("shows not-found for a job that isn't the employer's", async () => {
    installFetch({ ...baseRoutes("employer"), [`GET /api/jobs/${J1.id}`]: { status: 404, json: { error: { code: "job_not_found", message: "Job not found." } } }, [`GET /api/jobs/${J1.id}/applicants`]: { status: 404, json: { error: { code: "job_not_found", message: "Job not found." } } } });
    renderApp(`/employer/jobs/${J1.id}`);
    expect(await screen.findByText("Job not found")).toBeInTheDocument();
  });
});

describe("cancel a job", () => {
  it("asks for confirmation, sends the reason, and reflects the cancelled state", async () => {
    const f = installFetch({ ...jobRoutes([]), [`POST /api/jobs/${J1.id}/cancel`]: { status: 204 } });
    renderApp(`/employer/jobs/${J1.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Cancel this job" }));
    expect(f.callsTo(`POST /api/jobs/${J1.id}/cancel`)).toHaveLength(0); // nothing until confirmed
    await user.type(screen.getByLabelText(/reason/i), "Plans changed");
    f.set(`GET /api/jobs/${J1.id}`, { json: { job: { ...J1, status: "cancelled", cancelled_reason: "Plans changed" }, my_application: null } });
    await user.click(screen.getByRole("button", { name: "Yes, cancel job" }));
    expect(await screen.findByText("Job cancelled.")).toBeInTheDocument();
    expect(f.callsTo(`POST /api/jobs/${J1.id}/cancel`)[0]?.body).toEqual({ reason: "Plans changed" });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Cancel this job" })).not.toBeInTheDocument());
  });

  it("lets the employer back out of the confirmation", async () => {
    const f = installFetch(jobRoutes([]));
    renderApp(`/employer/jobs/${J1.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Cancel this job" }));
    await user.click(screen.getByRole("button", { name: "Keep job" }));
    expect(screen.getByRole("button", { name: "Cancel this job" })).toBeInTheDocument();
    expect(f.callsTo(`POST /api/jobs/${J1.id}/cancel`)).toHaveLength(0);
  });
});

describe("bookings (employer)", () => {
  const booking = (over: Partial<Booking> = {}): Booking => ({
    id: "77777777-7777-4777-8777-777777777777",
    job_id: J1.id,
    application_id: "55555555-5555-4555-8555-555555555555",
    worker_id: WORKER_ID,
    employer_id: EMPLOYER_ID,
    agreed_pay_paise: 85000,
    status: "confirmed",
    cancelled_by: null,
    cancelled_at: null,
    cancel_reason: null,
    completed_at: null,
    created_at: "2026-11-20T10:00:00+00:00",
    job: J1,
    ...over,
  });

  it("shows who is booked (looked up through the applicants endpoint) and lets the employer cancel", async () => {
    const b = booking();
    const f = installFetch({
      ...baseRoutes("employer"),
      "GET /api/me/bookings": { json: { bookings: [b] } },
      [`GET /api/jobs/${J1.id}/applicants`]: { json: { applicants: [applicant({ application_status: "accepted" })] } },
      [`POST /api/bookings/${b.id}/cancel`]: { status: 204 },
    });
    renderApp("/employer/bookings");
    expect(await screen.findByText("Ravi Patel")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel booking" }));
    f.set("GET /api/me/bookings", { json: { bookings: [booking({ status: "cancelled_by_employer" })] } });
    await user.click(screen.getByRole("button", { name: "Yes, cancel booking" }));
    expect(await screen.findByText("Booking cancelled.")).toBeInTheDocument();
    expect(f.callsTo(`POST /api/bookings/${b.id}/cancel`)).toHaveLength(1);
    expect(await screen.findByText("Cancelled by employer")).toBeInTheDocument();
  });

  it("applies the same cancel rules as the database", () => {
    const future = new Date("2099-11-24T00:00:00Z");
    expect(canCancelBooking(booking(), "employer", future)).toBe(true);
    expect(canCancelBooking(booking({ status: "in_progress" }), "employer", future)).toBe(true);
    expect(canCancelBooking(booking({ status: "in_progress" }), "worker", future)).toBe(false);
    expect(canCancelBooking(booking(), "worker", future)).toBe(true);
    expect(canCancelBooking(booking({ status: "completed" }), "employer", future)).toBe(false);
    expect(canCancelBooking(booking({ status: "cancelled_by_worker" }), "employer", future)).toBe(false);
    expect(canCancelBooking(booking({ status: "no_show" }), "employer", future)).toBe(false);
    expect(canCancelBooking(booking(), "employer", new Date("2099-11-26T00:00:00Z"))).toBe(false); // job already ended
  });
});

describe("employer profile", () => {
  it("saves name and business, keeping the language", async () => {
    const f = installFetch({ ...baseRoutes("employer", meFor("employer")), "PUT /api/me/profile": { json: { profile: {} } } });
    renderApp("/employer/profile");
    const org = await screen.findByLabelText(/Business or organisation/);
    await userEvent.setup().type(org, "Shree Traders Pvt");
    await userEvent.setup().click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
    expect(f.callsTo("PUT /api/me/profile")[0]?.body).toEqual({ full_name: "Shree Traders", preferred_language: "en", org_name: "Shree Traders Pvt" });
  });
});
