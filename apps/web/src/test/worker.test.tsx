import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRoutes, installFetch, job, meFor, renderApp, signInAs, WORKER_ID } from "./helpers";
import { fakeSupabase } from "./fakeSupabase";
import type { Application, Booking } from "../lib/types";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

beforeEach(() => {
  fakeSupabase.reset();
  signInAs("worker");
});
afterEach(() => vi.unstubAllGlobals());

const page = (jobs: unknown[]) => ({ json: { jobs, page: { limit: 20, offset: 0 } } });
const J1 = job();
const J2 = job({ id: "44444444-4444-4444-8444-444444444444", title: "Deep clean a flat", category_id: 2, locality_id: 2, pay_amount_paise: 60000, pay_type: "hourly", employer: { full_name: "Meera Shah", org_name: "Clean Homes" } });

const application = (over: Partial<Application> = {}): Application => ({
  id: "55555555-5555-4555-8555-555555555555",
  job_id: J1.id,
  worker_id: WORKER_ID,
  status: "pending",
  status_reason: null,
  message: "I can start early",
  decided_at: null,
  created_at: "2026-11-20T10:00:00+00:00",
  ...over,
});

describe("browse jobs", () => {
  it("lists open jobs with pay in INR, IST times, locality and employer", async () => {
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": page([J1, J2]) });
    renderApp("/worker");
    const link = await screen.findByRole("link", { name: "Shift household goods" });
    expect(link).toHaveAttribute("href", `/worker/jobs/${J1.id}`);
    const card = link.closest("article")!;
    expect(within(card).getByText("₹850 per day")).toBeInTheDocument();
    expect(within(card).getByText(/9:00 AM – 1:00 PM IST/)).toBeInTheDocument();
    expect(within(card).getByText(/Alkapuri/)).toBeInTheDocument();
    expect(within(card).getByText(/Shree Traders/)).toBeInTheDocument();
    expect(within(card).getByText(/0 of 2 booked/)).toBeInTheDocument();
    expect(screen.getByText("₹600 per hour")).toBeInTheDocument();
  });

  it("starts in the worker's own locality and refetches when filters change", async () => {
    const f = installFetch({ ...baseRoutes("worker"), "GET /api/jobs": page([J1]) });
    renderApp("/worker");
    await screen.findByRole("link", { name: "Shift household goods" });
    expect(f.callsTo("GET /api/jobs")[0]?.search).toContain("locality_id=1");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Type of work"), "2");
    await waitFor(() => expect(f.callsTo("GET /api/jobs").at(-1)?.search).toContain("category_id=2"));

    await user.selectOptions(screen.getByLabelText("Locality"), "");
    await waitFor(() => expect(f.callsTo("GET /api/jobs").at(-1)?.search).not.toContain("locality_id"));
    expect(f.callsTo("GET /api/jobs").at(-1)?.search).toContain("category_id=2");
  });

  it("clears all filters", async () => {
    const f = installFetch({ ...baseRoutes("worker"), "GET /api/jobs": page([J1]) });
    renderApp("/worker");
    await screen.findByRole("link", { name: "Shift household goods" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Type of work"), "2");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(f.callsTo("GET /api/jobs").at(-1)?.search).toBe("?limit=20&offset=0"));
  });

  it("searches the loaded jobs by text", async () => {
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": page([J1, J2]) });
    renderApp("/worker");
    await screen.findByRole("link", { name: "Shift household goods" });
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("Search"), "clean");
    expect(screen.queryByRole("link", { name: "Shift household goods" })).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Deep clean a flat" })).toBeInTheDocument();
  });

  it("shows an empty state, and a filtered empty state with a way back", async () => {
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": page([]) });
    renderApp("/worker");
    expect(await screen.findByText("No jobs match your filters")).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Show all jobs" }));
    expect(await screen.findByText("No open jobs right now")).toBeInTheDocument();
  });

  it("shows an error with a working retry", async () => {
    const f = installFetch({ ...baseRoutes("worker"), "GET /api/jobs": { status: 500, json: { error: { code: "internal_error", message: "Something went wrong." } } } });
    renderApp("/worker");
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
    f.set("GET /api/jobs", page([J1]));
    await userEvent.setup().click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("link", { name: "Shift household goods" })).toBeInTheDocument();
  });

  it("offers 'Load more' only when a full page came back, and appends the next page", async () => {
    const full = Array.from({ length: 20 }, (_, i) => job({ id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`, title: `Job number ${i + 1}` }));
    const f = installFetch({
      ...baseRoutes("worker"),
      "GET /api/jobs": ({ url }) => (url.searchParams.get("offset") === "20" ? page([J2]).json && { json: { jobs: [J2], page: { limit: 20, offset: 20 } } } : page(full)),
    });
    renderApp("/worker");
    await screen.findByRole("link", { name: "Job number 1" });
    await userEvent.setup().click(screen.getByRole("button", { name: "Load more jobs" }));
    expect(await screen.findByRole("link", { name: "Deep clean a flat" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Job number 1" })).toBeInTheDocument();
    expect(f.callsTo("GET /api/jobs").at(-1)?.search).toContain("offset=20");
    expect(screen.queryByRole("button", { name: "Load more jobs" })).not.toBeInTheDocument();
  });

  it("nudges workers with an incomplete profile to finish it", async () => {
    const me = meFor("worker", { worker: { user_id: WORKER_ID, locality_id: null, category_ids: [], is_available: true } });
    installFetch({ ...baseRoutes("worker", me), "GET /api/jobs": page([J1]) });
    renderApp("/worker");
    expect(await screen.findByText("Finish your profile to apply")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Complete your profile" })).toHaveAttribute("href", "/worker/profile");
  });
});

describe("job detail: apply and withdraw", () => {
  const detailRoutes = (my: Application | null) => ({
    ...baseRoutes("worker"),
    [`GET /api/jobs/${J1.id}`]: { json: { job: J1, my_application: my } },
  });

  it("shows the full job, then applies with an optional message", async () => {
    const f = installFetch({
      ...detailRoutes(null),
      [`POST /api/jobs/${J1.id}/applications`]: { status: 201, json: { application_id: "x" } },
    });
    renderApp(`/worker/jobs/${J1.id}`);
    expect(await screen.findByRole("heading", { level: 1, name: "Shift household goods" })).toBeInTheDocument();
    expect(screen.getByText(/Third floor, no lift/)).toBeInTheDocument();
    expect(screen.getByText("₹850 per day")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.type(screen.getByLabelText(/message to the employer/i), "I can start at 8");
    f.set(`GET /api/jobs/${J1.id}`, { json: { job: J1, my_application: application({ message: "I can start at 8" }) } });
    await user.click(screen.getByRole("button", { name: "Apply for this job" }));

    expect(await screen.findByText(/application sent/i)).toBeInTheDocument();
    expect(f.callsTo(`POST /api/jobs/${J1.id}/applications`)[0]?.body).toEqual({ message: "I can start at 8" });
    expect(await screen.findByRole("button", { name: "Withdraw application" })).toBeInTheDocument();
    expect(screen.getByText("Waiting for employer")).toBeInTheDocument();
  });

  it("withdraws a pending application and allows applying again", async () => {
    const app = application();
    const f = installFetch({ ...detailRoutes(app), [`POST /api/applications/${app.id}/withdraw`]: { status: 204 } });
    renderApp(`/worker/jobs/${J1.id}`);
    const withdrawBtn = await screen.findByRole("button", { name: "Withdraw application" });
    f.set(`GET /api/jobs/${J1.id}`, { json: { job: J1, my_application: { ...app, status: "withdrawn" } } });
    await userEvent.setup().click(withdrawBtn);
    expect(await screen.findByText("Application withdrawn.")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Apply again" })).toBeInTheDocument();
    expect(f.callsTo(`POST /api/applications/${app.id}/withdraw`)).toHaveLength(1);
  });

  it("surfaces API errors in plain language and links to the profile when it is incomplete", async () => {
    installFetch({
      ...detailRoutes(null),
      [`POST /api/jobs/${J1.id}/applications`]: { status: 422, json: { error: { code: "worker_profile_incomplete", message: "Add a locality and at least one work category before applying." } } },
    });
    renderApp(`/worker/jobs/${J1.id}`);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Apply for this job" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Add a locality and at least one work category");
    expect(screen.getByRole("link", { name: "Complete your profile" })).toBeInTheDocument();
  });

  it("shows the outcome and reason when an application was rejected", async () => {
    installFetch(detailRoutes(application({ status: "rejected", status_reason: "job_filled" })));
    renderApp(`/worker/jobs/${J1.id}`);
    expect(await screen.findByText("Not selected")).toBeInTheDocument();
    expect(screen.getByText("The job filled up.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /apply/i })).not.toBeInTheDocument();
  });

  it("links to bookings once accepted", async () => {
    installFetch(detailRoutes(application({ status: "accepted" })));
    renderApp(`/worker/jobs/${J1.id}`);
    expect(await screen.findByRole("link", { name: "See your bookings" })).toHaveAttribute("href", "/worker/bookings");
  });

  it("does not offer applying to a cancelled or full job", async () => {
    installFetch({ ...baseRoutes("worker"), [`GET /api/jobs/${J1.id}`]: { json: { job: { ...J1, status: "cancelled" }, my_application: null } } });
    const { unmount } = renderApp(`/worker/jobs/${J1.id}`);
    expect(await screen.findByText("This job was cancelled.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Apply for this job" })).not.toBeInTheDocument();
    unmount();

    installFetch({ ...baseRoutes("worker"), [`GET /api/jobs/${J1.id}`]: { json: { job: { ...J1, status: "filled", positions_filled: 2 }, my_application: null } } });
    renderApp(`/worker/jobs/${J1.id}`);
    expect(await screen.findByText(/already has all the workers it needs/i)).toBeInTheDocument();
  });

  it("shows a not-found state for jobs the worker cannot see", async () => {
    installFetch({ ...baseRoutes("worker"), [`GET /api/jobs/${J1.id}`]: { status: 404, json: { error: { code: "job_not_found", message: "Job not found." } } } });
    renderApp(`/worker/jobs/${J1.id}`);
    expect(await screen.findByText("Job not found")).toBeInTheDocument();
  });
});

describe("my applications", () => {
  it("lists applications with status, reason and a withdraw action for pending ones", async () => {
    const pending = application();
    const rejected = application({ id: "66666666-6666-4666-8666-666666666666", job_id: J2.id, status: "rejected", status_reason: "job_cancelled" });
    const f = installFetch({
      ...baseRoutes("worker"),
      "GET /api/me/applications": { json: { applications: [{ ...pending, job: J1 }, { ...rejected, job: J2 }] } },
      [`POST /api/applications/${pending.id}/withdraw`]: { status: 204 },
    });
    renderApp("/worker/applications");
    expect(await screen.findByText("Waiting for employer")).toBeInTheDocument();
    expect(screen.getByText("Not selected")).toBeInTheDocument();
    expect(screen.getByText("The employer cancelled this job.")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Withdraw" })).toHaveLength(1);

    f.set("GET /api/me/applications", { json: { applications: [{ ...pending, status: "withdrawn", job: J1 }, { ...rejected, job: J2 }] } });
    await userEvent.setup().click(screen.getByRole("button", { name: "Withdraw" }));
    expect(await screen.findByText("Application withdrawn.")).toBeInTheDocument();
    expect(await screen.findByText("Withdrawn")).toBeInTheDocument();
  });

  it("shows an empty state with a link to find work", async () => {
    installFetch({ ...baseRoutes("worker"), "GET /api/me/applications": { json: { applications: [] } } });
    renderApp("/worker/applications");
    expect(await screen.findByText("You haven't applied for any jobs yet")).toBeInTheDocument();
    expect(within(screen.getByRole("main")).getByRole("link", { name: "Find work" })).toHaveAttribute("href", "/worker");
  });
});

describe("bookings (worker)", () => {
  const booking = (over: Partial<Booking> = {}): Booking => ({
    id: "77777777-7777-4777-8777-777777777777",
    job_id: J1.id,
    application_id: "55555555-5555-4555-8555-555555555555",
    worker_id: WORKER_ID,
    employer_id: J1.employer_id,
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

  it("shows confirmed bookings and lets the worker cancel with a reason", async () => {
    const b = booking();
    const f = installFetch({
      ...baseRoutes("worker"),
      "GET /api/me/bookings": { json: { bookings: [b] } },
      [`POST /api/bookings/${b.id}/cancel`]: { status: 204 },
    });
    renderApp("/worker/bookings");
    expect(await screen.findByText("Confirmed")).toBeInTheDocument();
    expect(screen.getByText("₹850 agreed")).toBeInTheDocument();

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Cancel booking" }));
    await user.type(screen.getByLabelText(/reason/i), "Family emergency");
    f.set("GET /api/me/bookings", { json: { bookings: [booking({ status: "cancelled_by_worker", cancel_reason: "Family emergency" })] } });
    await user.click(screen.getByRole("button", { name: "Yes, cancel booking" }));
    expect(await screen.findByText("Booking cancelled.")).toBeInTheDocument();
    expect(f.callsTo(`POST /api/bookings/${b.id}/cancel`)[0]?.body).toEqual({ reason: "Family emergency" });
    expect(await screen.findByText("Cancelled by worker")).toBeInTheDocument();
  });

  it("hides cancel for finished, cancelled or in-progress bookings (a worker cannot cancel mid-job)", async () => {
    installFetch({
      ...baseRoutes("worker"),
      "GET /api/me/bookings": {
        json: {
          bookings: [
            booking({ id: "a1111111-1111-4111-8111-111111111111", status: "in_progress" }),
            booking({ id: "a2222222-2222-4222-8222-222222222222", status: "cancelled_by_employer" }),
            booking({ id: "a3333333-3333-4333-8333-333333333333", status: "completed" }),
            booking({ id: "a4444444-4444-4444-8444-444444444444", job: { ...J1, ends_at: "2020-01-01T00:00:00+00:00", starts_at: "2019-12-31T00:00:00+00:00" } }),
          ],
        },
      },
    });
    renderApp("/worker/bookings");
    await screen.findByText("In progress");
    expect(screen.queryByRole("button", { name: "Cancel booking" })).not.toBeInTheDocument();
  });

  it("shows an empty state", async () => {
    installFetch({ ...baseRoutes("worker"), "GET /api/me/bookings": { json: { bookings: [] } } });
    renderApp("/worker/bookings");
    expect(await screen.findByText("No bookings yet")).toBeInTheDocument();
  });
});

describe("worker profile", () => {
  it("pre-fills from the account and saves name, area, work types and availability", async () => {
    const f = installFetch({
      ...baseRoutes("worker"),
      "PUT /api/me/profile": { json: { profile: meFor("worker").profile } },
      "PUT /api/me/worker-profile": { json: { worker: {} } },
    });
    renderApp("/worker/profile");
    const name = await screen.findByLabelText(/^Full name/);
    expect(name).toHaveValue("Ravi Patel");
    await screen.findByRole("option", { name: "Gotri" });
    expect(screen.getByLabelText(/^Area you work in/)).toHaveValue("1");
    expect(screen.getByRole("checkbox", { name: "Loading & unloading" })).toBeChecked();

    const user = userEvent.setup();
    await user.clear(name);
    await user.type(name, "Ravi K Patel");
    await user.selectOptions(screen.getByLabelText(/^Area you work in/), "2");
    await user.click(screen.getByRole("checkbox", { name: "Cleaning" }));
    await user.clear(screen.getByLabelText(/Years of experience/));
    await user.type(screen.getByLabelText(/Years of experience/), "5");
    await user.type(screen.getByLabelText(/About you/), "Own trolley");
    await user.click(screen.getByRole("checkbox", { name: /available for new work/i }));
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
    expect(f.callsTo("PUT /api/me/profile")[0]?.body).toEqual({ full_name: "Ravi K Patel", preferred_language: "en", org_name: null });
    expect(f.callsTo("PUT /api/me/worker-profile")[0]?.body).toEqual({
      bio: "Own trolley",
      years_experience: 5,
      locality_id: 2,
      is_available: false,
      category_ids: [1, 2],
      skills: [],
      availability_note: null,
    });
  });

  it("requires an area and at least one kind of work, and never sends a request until valid", async () => {
    const me = meFor("worker", { worker: { user_id: WORKER_ID, locality_id: null, category_ids: [], is_available: true } });
    const f = installFetch({ ...baseRoutes("worker", me) });
    renderApp("/worker/profile");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Choose the area you work in.")).toBeInTheDocument();
    expect(screen.getByText("Choose at least one kind of work.")).toBeInTheDocument();
    expect(f.callsTo("PUT /api/me/worker-profile")).toHaveLength(0);
  });

  it("limits work types to five", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({ id: i + 1, slug: `c${i}`, name_en: `Work ${i + 1}`, name_hi: "", name_gu: "" }));
    installFetch({ ...baseRoutes("worker", meFor("worker", { worker: { user_id: WORKER_ID, locality_id: 1, category_ids: [], is_available: true } })), "GET /api/categories": { json: { categories: many } } });
    renderApp("/worker/profile");
    const user = userEvent.setup();
    for (let i = 1; i <= 5; i++) await user.click(await screen.findByRole("checkbox", { name: `Work ${i}` }));
    expect(screen.getByRole("checkbox", { name: "Work 6" })).toBeDisabled();
  });

  it("treats years of experience as optional, never as zero", async () => {
    const f = installFetch({
      ...baseRoutes("worker", meFor("worker", { worker: { user_id: WORKER_ID, locality_id: 1, category_ids: [1], is_available: true, years_experience: null } })),
      "PUT /api/me/worker-profile": { json: { worker: {} } },
    });
    renderApp("/worker/profile");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile saved.");
    expect(f.callsTo("PUT /api/me/worker-profile")[0]?.body.years_experience).toBeNull();
  });

  it("shows server-side validation errors next to the field", async () => {
    installFetch({
      ...baseRoutes("worker"),
      "PUT /api/me/worker-profile": { status: 422, json: { error: { code: "validation_error", message: "The request is invalid.", details: [{ path: "bio", message: "Too long" }] } } },
    });
    renderApp("/worker/profile");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Too long")).toBeInTheDocument();
  });
});
