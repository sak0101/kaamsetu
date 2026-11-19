import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeNotification } from "../lib/labels";
import type { Application, Booking, NotificationItem } from "../lib/types";
import { fakeSupabase } from "./fakeSupabase";
import { EMPLOYER_ID, WORKER_ID, baseRoutes, installFetch, job, renderApp, signInAs } from "./helpers";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

beforeEach(() => fakeSupabase.reset());
afterEach(() => vi.unstubAllGlobals());

const started = job({ starts_at: new Date(Date.now() - 3_600_000).toISOString(), ends_at: new Date(Date.now() + 3 * 3_600_000).toISOString() });
const future = job({ id: "99999999-9999-4999-8999-999999999999", title: "Future job" });
const booking = (over: Partial<Booking> = {}): Booking => ({
  id: "77777777-7777-4777-8777-777777777777",
  job_id: started.id,
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
  job: started,
  ...over,
});
const applicantsFor = (j: typeof started) => ({ [`GET /api/jobs/${j.id}/applicants`]: { json: { applicants: [] } } });

describe("employer: finishing a booking", () => {
  beforeEach(() => signInAs("employer"));

  it("offers 'Work completed' / 'Didn't turn up' only once the job has started, and records the outcome", async () => {
    const b = booking();
    const f = installFetch({
      ...baseRoutes("employer"),
      "GET /api/me/bookings": { json: { bookings: [b, booking({ id: "88888888-8888-4888-8888-888888888888", job_id: future.id, job: future })] } },
      "GET /api/me/reviews": { json: { reviews: [] } },
      ...applicantsFor(started),
      ...applicantsFor(future),
      [`POST /api/bookings/${b.id}/finish`]: { status: 204 },
    });
    renderApp("/employer/bookings");
    const user = userEvent.setup();
    expect(await screen.findAllByText("How did it go?")).toHaveLength(1); // only the started job
    await user.click(screen.getByRole("button", { name: "Work completed" }));
    expect(await screen.findByText(/Marked as completed/)).toBeInTheDocument();
    expect(f.callsTo(`POST /api/bookings/${b.id}/finish`)[0]!.body).toEqual({ outcome: "completed" });
  });

  it("records a no-show", async () => {
    const b = booking();
    const f = installFetch({
      ...baseRoutes("employer"),
      "GET /api/me/bookings": { json: { bookings: [b] } },
      "GET /api/me/reviews": { json: { reviews: [] } },
      ...applicantsFor(started),
      [`POST /api/bookings/${b.id}/finish`]: { status: 204 },
    });
    renderApp("/employer/bookings");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Didn't turn up" }));
    expect(await screen.findByText("Marked as a no-show.")).toBeInTheDocument();
    expect(f.callsTo(`POST /api/bookings/${b.id}/finish`)[0]!.body).toEqual({ outcome: "no_show" });
  });

  it("shows the server's reason when it is refused, and keeps the buttons", async () => {
    const b = booking();
    installFetch({
      ...baseRoutes("employer"),
      "GET /api/me/bookings": { json: { bookings: [b] } },
      "GET /api/me/reviews": { json: { reviews: [] } },
      ...applicantsFor(started),
      [`POST /api/bookings/${b.id}/finish`]: { status: 409, json: { error: { code: "booking_not_finishable", message: "This booking has already been completed." } } },
    });
    renderApp("/employer/bookings");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Work completed" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already been completed/);
    expect(screen.getByRole("button", { name: "Work completed" })).toBeEnabled();
  });

  it("does not offer it on cancelled bookings", async () => {
    installFetch({
      ...baseRoutes("employer"),
      "GET /api/me/bookings": { json: { bookings: [booking({ status: "cancelled_by_worker", cancelled_by: WORKER_ID, cancelled_at: "2026-11-20T10:00:00+00:00" })] } },
      "GET /api/me/reviews": { json: { reviews: [] } },
      ...applicantsFor(started),
    });
    renderApp("/employer/bookings");
    await screen.findByText("Cancelled by worker");
    expect(screen.queryByText("How did it go?")).not.toBeInTheDocument();
  });
});

describe("reviews", () => {
  it("lets the employer rate a completed worker once, validating the rating first", async () => {
    signInAs("employer");
    const b = booking({ status: "completed", completed_at: "2026-11-20T12:00:00+00:00" });
    const f = installFetch({
      ...baseRoutes("employer"),
      "GET /api/me/bookings": { json: { bookings: [b] } },
      "GET /api/me/reviews": { json: { reviews: [] } },
      ...applicantsFor(started),
      [`POST /api/bookings/${b.id}/review`]: { status: 201, json: { id: "r1" } },
    });
    renderApp("/employer/bookings");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Rate the worker" }));
    await user.click(screen.getByRole("button", { name: "Submit rating" }));
    expect(screen.getByRole("alert")).toHaveTextContent(/Choose a rating from 1 to 5/);
    expect(f.callsTo(`POST /api/bookings/${b.id}/review`)).toHaveLength(0);
    await user.click(screen.getByRole("radio", { name: "4 out of 5" }));
    await user.type(screen.getByLabelText(/Comment/), "Turned up on time");
    await user.click(screen.getByRole("button", { name: "Submit rating" }));
    await waitFor(() => expect(f.callsTo(`POST /api/bookings/${b.id}/review`)).toHaveLength(1));
    expect(f.callsTo(`POST /api/bookings/${b.id}/review`)[0]!.body).toEqual({ rating: 4, comment: "Turned up on time" });
    expect(await screen.findByText(/Your rating was saved/)).toBeInTheDocument();
  });

  it("shows what you rated and what the other side rated you, and no form once you have reviewed", async () => {
    signInAs("worker");
    const b = booking({ status: "completed", completed_at: "2026-11-20T12:00:00+00:00" });
    installFetch({
      ...baseRoutes("worker"),
      "GET /api/me/bookings": { json: { bookings: [b] } },
      "GET /api/me/reviews": {
        json: {
          reviews: [
            { id: "r1", booking_id: b.id, reviewer_id: WORKER_ID, reviewee_id: EMPLOYER_ID, rating: 5, comment: null, created_at: "2026-11-20T13:00:00Z" },
            { id: "r2", booking_id: b.id, reviewer_id: EMPLOYER_ID, reviewee_id: WORKER_ID, rating: 4, comment: "Reliable", created_at: "2026-11-20T13:00:00Z" },
          ],
        },
      },
    });
    renderApp("/worker/bookings");
    expect(await screen.findByText(/You rated the employer/)).toHaveTextContent("5 out of 5");
    expect(screen.getByText(/The employer rated you/)).toHaveTextContent("4 out of 5");
    expect(screen.getByText(/Reliable/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Rate the employer" })).not.toBeInTheDocument();
  });

  it("a worker with no reviews sees nothing negative, and a completed job count on the dashboard", async () => {
    signInAs("worker");
    const b = booking({ status: "completed", completed_at: "2026-11-20T12:00:00+00:00" });
    installFetch({
      ...baseRoutes("worker"),
      "GET /api/jobs": { json: { jobs: [], page: { limit: 20, offset: 0 } } },
      "GET /api/me/bookings": { json: { bookings: [b] } },
      "GET /api/me/applications": { json: { applications: [] } },
    });
    renderApp("/worker");
    const overview = await screen.findByRole("region", { name: "Your overview" });
    expect(await within(overview).findByText(/Completed through KaamSetu/)).toHaveTextContent("1 job");
    expect(overview.textContent).not.toMatch(/no-show|rating|0 reviews/i);
  });

  it("shows a clear message if rating is refused (for example a duplicate)", async () => {
    signInAs("worker");
    const b = booking({ status: "completed", completed_at: "2026-11-20T12:00:00+00:00" });
    installFetch({
      ...baseRoutes("worker"),
      "GET /api/me/bookings": { json: { bookings: [b] } },
      "GET /api/me/reviews": { json: { reviews: [] } },
      [`POST /api/bookings/${b.id}/review`]: { status: 409, json: { error: { code: "already_reviewed", message: "You have already reviewed this booking." } } },
    });
    renderApp("/worker/bookings");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Rate the employer" }));
    await user.click(screen.getByRole("radio", { name: "5 out of 5" }));
    await user.click(screen.getByRole("button", { name: "Submit rating" }));
    expect(await screen.findByRole("alert")).toHaveTextContent(/already reviewed/);
  });
});

describe("job location: worker side", () => {
  const detail = (application: Application | null, extra: Record<string, { status?: number; json?: unknown }> = {}) => ({
    ...baseRoutes("worker"),
    [`GET /api/jobs/${future.id}`]: { json: { job: future, my_application: application } },
    ...extra,
  });
  const app = (status: Application["status"]): Application => ({
    id: "55555555-5555-4555-8555-555555555555", job_id: future.id, worker_id: WORKER_ID, status, status_reason: null, message: null, decided_at: null, created_at: "2026-11-20T10:00:00+00:00",
  });

  it("before booking: says the address comes later, shows only the locality, and never asks for it", async () => {
    signInAs("worker");
    const f = installFetch(detail(app("pending")));
    renderApp(`/worker/jobs/${future.id}`);
    expect(await screen.findByText(/shared with you once the employer books you/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Get directions/ })).not.toBeInTheDocument();
    expect(f.callsTo(`GET /api/jobs/${future.id}/location`)).toHaveLength(0);
  });

  it("once booked: shows the address, landmark and a Google Maps directions link that opens safely in a new tab", async () => {
    signInAs("worker");
    installFetch(detail(app("accepted"), { [`GET /api/jobs/${future.id}/location`]: { json: { location: { address_line: "12 Race Course Circle", landmark: "Near the fountain" } } } }));
    renderApp(`/worker/jobs/${future.id}`);
    expect(await screen.findByText("12 Race Course Circle")).toBeInTheDocument();
    expect(screen.getByText(/Landmark: Near the fountain/)).toBeInTheDocument();
    const link = screen.getByRole("link", { name: /Get directions/ });
    expect(link.getAttribute("href")).toMatch(/^https:\/\/www\.google\.com\/maps\/dir\/\?api=1&destination=/);
    expect(decodeURIComponent(link.getAttribute("href")!.split("destination=")[1]!)).toBe("12 Race Course Circle, Alkapuri, Vadodara, Gujarat");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("once booked but with no address added: says so plainly", async () => {
    signInAs("worker");
    installFetch(detail(app("accepted"), { [`GET /api/jobs/${future.id}/location`]: { json: { location: null } } }));
    renderApp(`/worker/jobs/${future.id}`);
    expect(await screen.findByText(/hasn't added one yet/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Get directions/ })).not.toBeInTheDocument();
  });

  it("falls back gracefully if the address can't be loaded", async () => {
    signInAs("worker");
    installFetch(detail(app("accepted"), { [`GET /api/jobs/${future.id}/location`]: { status: 500, json: { error: { code: "internal_error", message: "x" } } } }));
    renderApp(`/worker/jobs/${future.id}`);
    expect(await screen.findByText(/couldn't load the address/)).toBeInTheDocument();
  });
});

describe("job location: employer side", () => {
  beforeEach(() => signInAs("employer"));
  type H = { status?: number; json?: unknown };
  const routes = (location: unknown, extra: Record<string, H> = {}) => ({
    ...baseRoutes("employer"),
    [`GET /api/jobs/${future.id}`]: { json: { job: future, my_application: null } },
    ...applicantsFor(future),
    [`GET /api/jobs/${future.id}/location`]: { json: { location } },
    ...extra,
  });

  it("validates, saves and shows the new address, with a directions link", async () => {
    const f = installFetch(routes(null, { [`PUT /api/jobs/${future.id}/location`]: { json: { location: { address_line: "12 Race Course Circle", landmark: "Near the fountain" } } } }));
    renderApp(`/employer/jobs/${future.id}`);
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Add address" }));
    await user.type(screen.getByLabelText("Address"), "abc");
    await user.click(screen.getByRole("button", { name: "Save address" }));
    expect(screen.getByText(/Enter the address \(5 to 200 characters\)/)).toBeInTheDocument();
    expect(f.callsTo(`PUT /api/jobs/${future.id}/location`)).toHaveLength(0);
    await user.clear(screen.getByLabelText("Address"));
    await user.type(screen.getByLabelText("Address"), "12 Race Course Circle");
    await user.type(screen.getByLabelText("Landmark"), "Near the fountain");
    f.set(`GET /api/jobs/${future.id}/location`, { json: { location: { address_line: "12 Race Course Circle", landmark: "Near the fountain" } } });
    await user.click(screen.getByRole("button", { name: "Save address" }));
    expect(await screen.findByText("12 Race Course Circle")).toBeInTheDocument();
    expect(f.callsTo(`PUT /api/jobs/${future.id}/location`)[0]!.body).toEqual({ address_line: "12 Race Course Circle", landmark: "Near the fountain" });
    expect(screen.getByRole("link", { name: /Get directions/ })).toBeInTheDocument();
  });

  it("explains that only booked workers see the address", async () => {
    installFetch(routes({ address_line: "12 Race Course Circle", landmark: null }));
    renderApp(`/employer/jobs/${future.id}`);
    expect(await screen.findByText(/Only you and workers you have booked can see this/)).toBeInTheDocument();
  });
});

describe("posting a job with an address", () => {
  beforeEach(() => signInAs("employer"));
  const futureDate = () => new Date(Date.now() + 3 * 86_400_000 + 5.5 * 3_600_000).toISOString().slice(0, 10);

  async function fillAndPost(user: ReturnType<typeof userEvent.setup>, withAddress: boolean) {
    await screen.findByRole("option", { name: "Gotri" });
    await user.type(screen.getByLabelText(/^Job title/), "Move a sofa set");
    await user.selectOptions(screen.getByLabelText(/^Type of work/), "1");
    await user.selectOptions(screen.getByLabelText(/^Locality in Vadodara/), "2");
    await user.type(screen.getByLabelText(/^What needs to be done/), "Two flights of stairs");
    await user.type(screen.getByLabelText(/^Date/), futureDate());
    await user.selectOptions(screen.getByLabelText(/^Pay is/), "hourly");
    await user.type(screen.getByLabelText(/^Amount/), "120");
    if (withAddress) {
      await user.type(screen.getByLabelText("Address"), "12 Race Course Circle");
      await user.type(screen.getByLabelText("Landmark"), "Near the fountain");
    }
    await user.click(screen.getByRole("button", { name: "Post job" }));
  }

  const created = job({ id: "88888888-8888-4888-8888-888888888888", title: "Move a sofa set" });
  const base = () => ({
    ...baseRoutes("employer"),
    "POST /api/jobs": { status: 201, json: { id: created.id } },
    [`GET /api/jobs/${created.id}`]: { json: { job: created, my_application: null } },
    [`GET /api/jobs/${created.id}/applicants`]: { json: { applicants: [] } },
    [`GET /api/jobs/${created.id}/location`]: { json: { location: null } },
  });

  it("posts the job first, then saves the address separately (the job payload never contains it)", async () => {
    const f = installFetch({ ...base(), [`PUT /api/jobs/${created.id}/location`]: { json: { location: { address_line: "12 Race Course Circle", landmark: "Near the fountain" } } } });
    renderApp("/employer/jobs/new");
    await fillAndPost(userEvent.setup(), true);
    expect(await screen.findByRole("heading", { level: 1, name: "Move a sofa set" })).toBeInTheDocument();
    expect(Object.keys(f.callsTo("POST /api/jobs")[0]!.body)).not.toContain("address_line");
    expect(JSON.stringify(f.callsTo("POST /api/jobs")[0]!.body)).not.toMatch(/Race Course/);
    expect(f.callsTo(`PUT /api/jobs/${created.id}/location`)[0]!.body).toEqual({ address_line: "12 Race Course Circle", landmark: "Near the fountain" });
    expect(screen.getByText("Job posted. Workers can now apply.")).toBeInTheDocument();
  });

  it("makes no location request when no address was entered", async () => {
    const f = installFetch(base());
    renderApp("/employer/jobs/new");
    await fillAndPost(userEvent.setup(), false);
    await screen.findByRole("heading", { level: 1, name: "Move a sofa set" });
    expect(f.callsTo(`PUT /api/jobs/${created.id}/location`)).toHaveLength(0);
  });

  it("the job is still posted if the address can't be saved, and the employer is told how to add it", async () => {
    installFetch({ ...base(), [`PUT /api/jobs/${created.id}/location`]: { status: 500, json: { error: { code: "internal_error", message: "x" } } } });
    renderApp("/employer/jobs/new");
    await fillAndPost(userEvent.setup(), true);
    expect(await screen.findByRole("heading", { level: 1, name: "Move a sofa set" })).toBeInTheDocument();
    expect(screen.getByText(/address could not be saved/)).toBeInTheDocument();
  });

  it("rejects a landmark without an address", async () => {
    const f = installFetch(base());
    renderApp("/employer/jobs/new");
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Gotri" });
    await user.type(screen.getByLabelText("Landmark"), "Near the fountain");
    await user.click(screen.getByRole("button", { name: "Post job" }));
    expect(await screen.findByText(/Add the address too/)).toBeInTheDocument();
    expect(f.callsTo("POST /api/jobs")).toHaveLength(0);
  });
});

describe("matching-job notification", () => {
  it("links the worker straight to the new job", () => {
    const n: NotificationItem = {
      id: "n1", type: "new_matching_job", entity_type: "job", entity_id: future.id,
      payload: { job_id: future.id, job_title: "Move a sofa set" }, read_at: null, created_at: "2026-11-20T10:00:00Z",
    };
    expect(describeNotification(n, "worker")).toEqual({ text: "New job near you: “Move a sofa set”", to: `/worker/jobs/${future.id}` });
  });
});
