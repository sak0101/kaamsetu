import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeSupabase } from "./fakeSupabase";
import { baseRoutes, installFetch, job, meFor, renderApp, signInAs, EMPLOYER_ID, WORKER_ID } from "./helpers";
import type { Booking } from "../lib/types";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

beforeEach(() => fakeSupabase.reset());
afterEach(() => vi.unstubAllGlobals());

describe("worker profile: skills, availability, phone", () => {
  beforeEach(() => signInAs("worker"));

  const routes = (extra: Record<string, unknown> = {}) => ({
    ...baseRoutes("worker"),
    "PUT /api/me/profile": { json: { profile: meFor("worker").profile } },
    "PUT /api/me/worker-profile": { json: { worker: {} } },
    "PUT /api/me/contact": ({ body }: { body: { phone: string | null } }) => ({ json: { phone: body.phone ? `+91${body.phone.replace(/\D/g, "").slice(-10)}` : null } }),
    ...extra,
  });

  it("adds skills by Enter, comma, button and suggestion; removes them; ignores duplicates", async () => {
    installFetch(routes());
    renderApp("/worker/profile");
    const user = userEvent.setup();
    const box = await screen.findByLabelText("Add a skill");
    await user.type(box, "Guest handling{Enter}");
    await user.type(box, "Stage setup,");
    await user.type(box, "Serving food");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.type(box, "guest HANDLING{Enter}"); // duplicate, case-insensitive
    await user.click(screen.getByRole("button", { name: "+ Hindi" }));

    const list = screen.getByRole("list", { name: "Your skills" });
    expect(within(list).getAllByRole("listitem").map((li) => li.textContent?.replace("×", ""))).toEqual(["Guest handling", "Stage setup", "Serving food", "Hindi"]);
    expect(screen.queryByRole("button", { name: "+ Hindi" })).not.toBeInTheDocument(); // suggestions disappear once used

    await user.click(screen.getByRole("button", { name: "Remove skill Stage setup" }));
    expect(within(screen.getByRole("list", { name: "Your skills" })).queryByText(/Stage setup/)).not.toBeInTheDocument();
  });

  it("limits skills to 8 and rejects 1-character skills", async () => {
    installFetch(routes());
    renderApp("/worker/profile");
    const user = userEvent.setup();
    const box = await screen.findByLabelText("Add a skill");
    await user.type(box, "x{Enter}");
    expect(await screen.findByText("A skill should be 2 to 40 characters.")).toBeInTheDocument();
    for (let i = 1; i <= 8; i++) await user.type(box, `Skill ${i}{Enter}`);
    await user.type(box, "One too many{Enter}");
    expect(await screen.findByText("Add up to 8 skills.")).toBeInTheDocument();
    expect(within(screen.getByRole("list", { name: "Your skills" })).getAllByRole("listitem")).toHaveLength(8);
  });

  it("saves skills, availability, intro and experience through the API", async () => {
    const f = installFetch(routes());
    renderApp("/worker/profile");
    const user = userEvent.setup();
    await screen.findByRole("option", { name: "Gotri" });
    await user.type(screen.getByLabelText("Add a skill"), "Guest handling{Enter}");
    await user.type(screen.getByLabelText("When are you available?"), "Evenings and weekends");
    await user.type(screen.getByLabelText(/About you/), "Reliable and punctual.");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText("Profile saved.")).toBeInTheDocument();
    expect(f.callsTo("PUT /api/me/worker-profile")[0]?.body).toMatchObject({
      skills: ["Guest handling"],
      availability_note: "Evenings and weekends",
      bio: "Reliable and punctual.",
      years_experience: 3,
      locality_id: 1,
      category_ids: [1],
    });
  });

  it("saves an optional phone number separately, explains who can see it, and only when changed", async () => {
    const f = installFetch(routes());
    renderApp("/worker/profile");
    const user = userEvent.setup();
    const phone = await screen.findByLabelText(/Phone number/);
    expect(screen.getByText(/Shared only with an employer who has booked you, and only while that booking is active/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await screen.findByText("Profile saved.");
    expect(f.callsTo("PUT /api/me/contact")).toHaveLength(0); // untouched = not sent

    await user.type(phone, "98765 43210");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(f.callsTo("PUT /api/me/contact")).toHaveLength(1));
    expect(f.callsTo("PUT /api/me/contact")[0]?.body).toEqual({ phone: "98765 43210" });
  });

  it("loads an existing number for editing and can clear it", async () => {
    const f = installFetch(routes({ "GET /api/me/contact": { json: { phone: "+919876543210" } } }));
    renderApp("/worker/profile");
    const user = userEvent.setup();
    const phone = await screen.findByLabelText(/Phone number/);
    await waitFor(() => expect(phone).toHaveValue("9876543210"));
    await user.clear(phone);
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(f.callsTo("PUT /api/me/contact")).toHaveLength(1));
    expect(f.callsTo("PUT /api/me/contact")[0]?.body).toEqual({ phone: null });
  });

  it.each(["12345", "5876543210", "call me", "+14155552671"])("rejects the phone number %j before sending anything", async (bad) => {
    const f = installFetch(routes());
    renderApp("/worker/profile");
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/Phone number/), bad);
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(await screen.findByText(/Enter a 10-digit Indian mobile number/)).toBeInTheDocument();
    expect(f.callsTo("PUT /api/me/worker-profile")).toHaveLength(0);
    expect(f.callsTo("PUT /api/me/contact")).toHaveLength(0);
  });

  it("never asks for Aadhaar or any ID, and says so", async () => {
    installFetch(routes());
    renderApp("/worker/profile");
    await screen.findByLabelText(/Phone number/);
    expect(document.body.textContent).toMatch(/never asks for Aadhaar or any ID number/i);
    for (const el of document.querySelectorAll("input, select, textarea")) {
      const label = (el as HTMLInputElement).labels?.[0]?.textContent ?? el.getAttribute("aria-label") ?? "";
      expect(label).not.toMatch(/aadhaar|aadhar|pan\b|passport|voter|licence|license|id number|date of birth|dob/i);
    }
  });

  it("shows a live completeness meter that only counts what has been provided", async () => {
    const bare = meFor("worker", { worker: { locality_id: null, category_ids: [], is_available: true } });
    installFetch(routes({ ...baseRoutes("worker", bare) }));
    renderApp("/worker/profile");
    const user = userEvent.setup();
    expect(await screen.findByText("Profile 0% complete")).toBeInTheDocument();
    await screen.findByRole("option", { name: "Gotri" });
    await user.selectOptions(screen.getByLabelText(/^Area you work in/), "1");
    await user.click(screen.getByRole("checkbox", { name: "Cleaning" }));
    expect(screen.getByRole("progressbar", { name: "Profile completeness" })).toHaveAttribute("aria-valuenow", "29"); // 2 of 7
    expect(screen.getByText(/Profile 29% complete/)).toBeInTheDocument();
  });

  it("maps server-side skill and phone errors onto the right field", async () => {
    installFetch(
      routes({
        "PUT /api/me/worker-profile": { status: 422, json: { error: { code: "invalid_skills", message: "invalid skills" } } },
      }),
    );
    renderApp("/worker/profile");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Save profile" }));
    expect(await screen.findByText(/Check your skills: up to 8, each 2 to 40 characters\./)).toBeInTheDocument();
  });
});

describe("booking contact", () => {
  const j = job();
  const booking = (status: string, id = "77777777-7777-4777-8777-777777777777"): Booking => ({
    id, job_id: j.id, application_id: "55555555-5555-4555-8555-555555555555", worker_id: WORKER_ID, employer_id: EMPLOYER_ID,
    agreed_pay_paise: 85000, status, cancelled_by: null, cancelled_at: null, cancel_reason: null, completed_at: null,
    created_at: "2026-11-20T10:00:00+00:00", job: j,
  });

  it("lets a worker reveal the employer's number for a live booking, as a tap-to-call link", async () => {
    signInAs("worker");
    const b = booking("confirmed");
    const f = installFetch({
      ...baseRoutes("worker"),
      "GET /api/me/bookings": { json: { bookings: [b] } },
      [`GET /api/bookings/${b.id}/contact`]: { json: { name: "Shree Traders", phone: "+919123456789", shared: true } },
    });
    renderApp("/worker/bookings");
    const user = userEvent.setup();
    await screen.findByText("Confirmed");
    expect(f.callsTo(`GET /api/bookings/${b.id}/contact`)).toHaveLength(0); // never fetched until asked
    await user.click(screen.getByRole("button", { name: "Show contact" }));
    const link = await screen.findByRole("link", { name: "+919123456789" });
    expect(link).toHaveAttribute("href", "tel:+919123456789");
    expect(within(screen.getByRole("status")).getByText(/Shree Traders/)).toBeInTheDocument();
  });

  it("lets an employer reveal the booked worker's number", async () => {
    signInAs("employer");
    const b = booking("in_progress");
    installFetch({
      ...baseRoutes("employer"),
      "GET /api/me/bookings": { json: { bookings: [b] } },
      [`GET /api/jobs/${j.id}/applicants`]: { json: { applicants: [] } },
      [`GET /api/bookings/${b.id}/contact`]: { json: { name: "Ravi Patel", phone: "+919876543210", shared: true } },
    });
    renderApp("/employer/bookings");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Show contact" }));
    expect(await screen.findByRole("link", { name: "+919876543210" })).toHaveAttribute("href", "tel:+919876543210");
  });

  it("says so when the other person hasn't added a number, without inventing one", async () => {
    signInAs("worker");
    const b = booking("confirmed");
    installFetch({
      ...baseRoutes("worker"),
      "GET /api/me/bookings": { json: { bookings: [b] } },
      [`GET /api/bookings/${b.id}/contact`]: { json: { name: "Shree Traders", phone: null, shared: true } },
    });
    renderApp("/worker/bookings");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Show contact" }));
    expect(await screen.findByText(/employer hasn't added a phone number yet/)).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /^\+91/ })).not.toBeInTheDocument();
  });

  it("offers no contact button once a booking is cancelled or finished", async () => {
    signInAs("worker");
    installFetch({
      ...baseRoutes("worker"),
      "GET /api/me/bookings": {
        json: { bookings: [booking("cancelled_by_employer", "a1111111-1111-4111-8111-111111111111"), booking("completed", "a2222222-2222-4222-8222-222222222222"), booking("no_show", "a3333333-3333-4333-8333-333333333333")] },
      },
    });
    renderApp("/worker/bookings");
    await screen.findByText("Cancelled by employer");
    expect(screen.queryByRole("button", { name: "Show contact" })).not.toBeInTheDocument();
  });

  it("shows a clear error if the contact can't be fetched, and lets the user retry", async () => {
    signInAs("worker");
    const b = booking("confirmed");
    const f = installFetch({
      ...baseRoutes("worker"),
      "GET /api/me/bookings": { json: { bookings: [b] } },
      [`GET /api/bookings/${b.id}/contact`]: { status: 500, json: { error: { code: "internal_error", message: "Something went wrong." } } },
    });
    renderApp("/worker/bookings");
    const user = userEvent.setup();
    await user.click(await screen.findByRole("button", { name: "Show contact" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Something went wrong.");
    f.set(`GET /api/bookings/${b.id}/contact`, { json: { name: "Shree Traders", phone: "+919123456789", shared: true } });
    await user.click(screen.getByRole("button", { name: "Show contact" }));
    expect(await screen.findByRole("link", { name: "+919123456789" })).toBeInTheDocument();
  });
});

describe("regression: slow phone lookup must not erase what the user typed", () => {
  it.each([
    ["worker", "/worker/profile"],
    ["employer", "/employer/profile"],
  ] as const)("%s profile keeps a number typed before the saved one finished loading", async (role, path) => {
    signInAs(role);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const f = installFetch({
      ...baseRoutes(role),
      "PUT /api/me/profile": { json: { profile: meFor(role).profile } },
      "PUT /api/me/worker-profile": { json: { worker: {} } },
      "PUT /api/me/contact": { json: { phone: "+919123456789" } },
    });
    // the saved-number request is held back until after the user has typed
    const original = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("/api/me/contact") && (init?.method ?? "GET") === "GET") await gate;
      return original(input, init);
    }));
    renderApp(path);
    const user = userEvent.setup();
    const phone = await screen.findByLabelText(/Phone number/);
    await user.type(phone, "9123456789");
    release();
    await new Promise((r) => setTimeout(r, 50));
    expect(phone).toHaveValue("9123456789"); // not wiped by the late response
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(f.callsTo("PUT /api/me/contact")).toHaveLength(1));
    expect(f.callsTo("PUT /api/me/contact")[0]?.body).toEqual({ phone: "9123456789" });
  });
});
