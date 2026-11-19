import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dateRangeFor } from "../pages/WorkerJobs";
import { addDays, directionsUrl, formatDuration, todayIst, urgencyOf } from "../lib/format";
import { fakeSupabase } from "./fakeSupabase";
import { baseRoutes, installFetch, job, renderApp, signInAs } from "./helpers";

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
const J2 = job({ id: "44444444-4444-4444-8444-444444444444", title: "Deep clean a flat", category_id: 2 });
const quiet = { "GET /api/me/bookings": { json: { bookings: [] } }, "GET /api/me/applications": { json: { applications: [] } } };
const lastQuery = (f: ReturnType<typeof installFetch>) => new URLSearchParams(f.callsTo("GET /api/jobs").at(-1)!.search);

describe("urgency, duration and directions helpers", () => {
  // 2026-11-19 10:00 IST
  const now = new Date("2026-11-19T04:30:00Z");

  it("labels Today, Tomorrow and This week by IST calendar day, and nothing otherwise", () => {
    expect(urgencyOf("2026-11-19T12:30:00Z", now)).toEqual({ label: "Today", level: "urgent" }); // 6 pm IST
    expect(urgencyOf("2026-11-19T06:00:00Z", now)).toEqual({ label: "Starting soon", level: "urgent" }); // 11:30 am IST, within 3 hours
    expect(urgencyOf("2026-11-20T03:30:00Z", now)).toEqual({ label: "Tomorrow", level: "soon" });
    expect(urgencyOf("2026-11-22T03:30:00Z", now)).toEqual({ label: "This week", level: "week" });
    expect(urgencyOf("2026-11-25T03:30:00Z", now)).toEqual({ label: "This week", level: "week" }); // 6 days away
    expect(urgencyOf("2026-11-26T03:30:00Z", now)).toBeNull(); // 7 days away
    expect(urgencyOf("2026-11-19T03:00:00Z", now)).toBeNull(); // already started
  });

  it("uses IST, not UTC, for the day boundary", () => {
    // 11:30 pm IST on the 19th is still "today" even though it is 18:00 UTC on the 19th; 00:30 IST on the 20th is "tomorrow" (19:00 UTC on the 19th)
    expect(urgencyOf("2026-11-19T18:00:00Z", now)?.label).toBe("Today");
    expect(urgencyOf("2026-11-19T19:00:00Z", now)?.label).toBe("Tomorrow");
  });

  it("formats durations plainly", () => {
    const at = (h: number, m = 0) => new Date(Date.UTC(2026, 10, 20, 4, 0) + (h * 60 + m) * 60_000).toISOString();
    const start = at(0);
    expect(formatDuration(start, at(0, 45))).toBe("45 min");
    expect(formatDuration(start, at(1))).toBe("1 hour");
    expect(formatDuration(start, at(4))).toBe("4 hours");
    expect(formatDuration(start, at(5, 30))).toBe("5 h 30 min");
    expect(formatDuration(start, at(24))).toBe("1 day");
    expect(formatDuration(start, at(26))).toBe("1 day 2 hours");
    expect(formatDuration(start, at(50))).toBe("2 days 2 hours");
  });

  it("builds a keyless Google Maps directions link from the address and locality", () => {
    const url = directionsUrl("12 Race Course Circle", "Race Course");
    expect(url.startsWith("https://www.google.com/maps/dir/?api=1&destination=")).toBe(true);
    expect(decodeURIComponent(url.split("destination=")[1]!)).toBe("12 Race Course Circle, Race Course, Vadodara, Gujarat");
    expect(url).not.toMatch(/key=/i);
    expect(directionsUrl("A&B <x>", "Gotri")).not.toContain("<");
  });

  it("turns a 'When' preset or a picked date into an inclusive IST range (a picked date wins)", () => {
    expect(dateRangeFor("today", "", now)).toEqual({ date_from: "2026-11-19", date_to: "2026-11-19" });
    expect(dateRangeFor("tomorrow", "", now)).toEqual({ date_from: "2026-11-20", date_to: "2026-11-20" });
    expect(dateRangeFor("week", "", now)).toEqual({ date_from: "2026-11-19", date_to: "2026-11-25" });
    expect(dateRangeFor("today", "2026-12-01", now)).toEqual({ date_from: "2026-12-01", date_to: "2026-12-01" });
    expect(dateRangeFor("", "", now)).toEqual({});
    expect(addDays(todayIst(now), 1)).toBe("2026-11-20");
  });
});

describe("job cards show urgency and duration", () => {
  it("shows Tomorrow and the length of the job on the card", async () => {
    const tomorrow = new Date(Date.now() + 26 * 3_600_000).toISOString();
    const end = new Date(Date.now() + 30 * 3_600_000).toISOString();
    installFetch({ ...baseRoutes("worker"), ...quiet, "GET /api/jobs": page([job({ starts_at: tomorrow, ends_at: end })]) });
    renderApp("/worker");
    const card = (await screen.findByRole("link", { name: "Shift household goods" })).closest("article") as HTMLElement;
    expect(within(card).getByText("Lasts 4 hours")).toBeInTheDocument();
    expect(within(card).getByText(/^(Tomorrow|Today|This week|Starting soon)$/)).toBeInTheDocument();
  });

  it("shows no urgency badge for a job that is weeks away", async () => {
    installFetch({ ...baseRoutes("worker"), ...quiet, "GET /api/jobs": page([J1]) }); // starts in 2099
    renderApp("/worker");
    const card = (await screen.findByRole("link", { name: "Shift household goods" })).closest("article") as HTMLElement;
    expect(within(card).queryByText(/^(Tomorrow|Today|This week|Starting soon)$/)).not.toBeInTheDocument();
    expect(within(card).getByText(/^Lasts 4 hours$/)).toBeInTheDocument();
  });
});

describe("server-side filters on the worker page", () => {
  it("sends duration presets as min/max hours and re-queries each time", async () => {
    const f = installFetch({ ...baseRoutes("worker"), ...quiet, "GET /api/jobs": page([J1, J2]) });
    renderApp("/worker");
    await screen.findByRole("link", { name: "Shift household goods" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("How long"), "long");
    await waitFor(() => expect(Object.fromEntries(lastQuery(f))).toMatchObject({ min_hours: "8" }));
    expect(lastQuery(f).get("max_hours")).toBeNull();
    await user.selectOptions(screen.getByLabelText("How long"), "short");
    await waitFor(() => expect(lastQuery(f).get("max_hours")).toBe("4"));
    expect(lastQuery(f).get("min_hours")).toBeNull();
    await user.selectOptions(screen.getByLabelText("How long"), "medium");
    await waitFor(() => expect([lastQuery(f).get("min_hours"), lastQuery(f).get("max_hours")]).toEqual(["4", "8"]));
  });

  it("sends the 'When' presets as an IST date range, and a picked date overrides them", async () => {
    const f = installFetch({ ...baseRoutes("worker"), ...quiet, "GET /api/jobs": page([J1]) });
    renderApp("/worker");
    await screen.findByRole("link", { name: "Shift household goods" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("When"), "tomorrow");
    const tomorrow = addDays(todayIst(), 1);
    await waitFor(() => expect([lastQuery(f).get("date_from"), lastQuery(f).get("date_to")]).toEqual([tomorrow, tomorrow]));
    await user.selectOptions(screen.getByLabelText("When"), "week");
    await waitFor(() => expect(lastQuery(f).get("date_to")).toBe(addDays(todayIst(), 6)));
    const date = screen.getAllByLabelText("Date").find((el) => el.closest("form")?.getAttribute("aria-label") === "Filter jobs")!;
    await user.type(date, "2099-12-24");
    await waitFor(() => expect([lastQuery(f).get("date_from"), lastQuery(f).get("date_to")]).toEqual(["2099-12-24", "2099-12-24"]));
    expect(screen.getByLabelText("When")).toBeDisabled(); // the picked date is in charge
  });

  it("keeps locality and category filters working alongside the new ones, and 'Clear filters' resets everything", async () => {
    const f = installFetch({ ...baseRoutes("worker"), ...quiet, "GET /api/jobs": page([J1]) });
    renderApp("/worker");
    await screen.findByRole("link", { name: "Shift household goods" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("Type of work", { selector: "#" + (screen.getAllByLabelText("Type of work").at(-1) as HTMLElement).id }), "2");
    await user.selectOptions(screen.getByLabelText("How long"), "short");
    await waitFor(() => expect(lastQuery(f).get("category_id")).toBe("2"));
    expect(lastQuery(f).get("locality_id")).toBe("1"); // the worker's own area is still the default
    expect(lastQuery(f).get("max_hours")).toBe("4");
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    await waitFor(() => expect(lastQuery(f).get("category_id")).toBeNull());
    expect([lastQuery(f).get("max_hours"), lastQuery(f).get("q"), lastQuery(f).get("locality_id")]).toEqual([null, null, null]);
  });

  it("shows the loader while a new search runs, then only the new results (no stale list)", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    installFetch({ ...baseRoutes("worker"), ...quiet, "GET /api/jobs": page([J1]) });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("duration") || String(args[0]).includes("min_hours=8")) await gate;
      return real(...args);
    }));
    renderApp("/worker");
    await screen.findByRole("link", { name: "Shift household goods" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("How long"), "long");
    expect(await screen.findByText("Loading jobs…")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Shift household goods" })).not.toBeInTheDocument();
    release();
    expect(await screen.findByRole("link", { name: "Shift household goods" })).toBeInTheDocument();
  });

  it("ignores a slow, outdated response that arrives after a newer search", async () => {
    let releaseOld: () => void = () => {};
    const slow = new Promise<void>((r) => (releaseOld = r));
    installFetch({
      ...baseRoutes("worker"),
      ...quiet,
      "GET /api/jobs": ({ url }) => (url.searchParams.get("max_hours") === "4" ? page([J1]) : url.searchParams.get("min_hours") === "8" ? page([J2]) : page([J1, J2])),
    });
    const real = globalThis.fetch;
    vi.stubGlobal("fetch", vi.fn(async (...args: Parameters<typeof fetch>) => {
      if (String(args[0]).includes("max_hours=4")) await slow; // the OLD search is slow
      return real(...args);
    }));
    renderApp("/worker");
    await screen.findByRole("link", { name: "Shift household goods" });
    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("How long"), "short"); // old search: held up
    await user.selectOptions(screen.getByLabelText("How long"), "long"); // newer search: answers first
    expect(await screen.findByRole("link", { name: "Deep clean a flat" })).toBeInTheDocument();
    releaseOld();
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("link", { name: "Shift household goods" })).not.toBeInTheDocument(); // the stale result did not overwrite it
    expect(screen.getByRole("link", { name: "Deep clean a flat" })).toBeInTheDocument();
  });
});
