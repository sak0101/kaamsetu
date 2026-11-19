import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { baseRoutes, installFetch, job, renderApp, signInAs, WORKER_ID, EMPLOYER_ID } from "./helpers";
import { fakeSupabase } from "./fakeSupabase";
import type { NotificationItem } from "../lib/types";

vi.mock("../lib/supabase", async () => {
  const m = await import("./fakeSupabase");
  return { getSupabase: () => Promise.resolve(m.fakeSupabase.client) };
});

beforeEach(() => fakeSupabase.reset());
afterEach(() => vi.unstubAllGlobals());

const emptyJobs = { json: { jobs: [], page: { limit: 20, offset: 0 } } };
const notif = (over: Partial<NotificationItem> = {}): NotificationItem => ({
  id: "n1",
  type: "booking_confirmed",
  entity_type: "booking",
  entity_id: "b1",
  payload: { job_title: "Shift household goods", job_id: "j1" },
  read_at: null,
  created_at: new Date().toISOString(),
  ...over,
});

describe("notifications", () => {
  it("shows an unread badge on the bell with an accessible name", async () => {
    signInAs("worker");
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": emptyJobs, "GET /api/notifications": { json: { notifications: [notif(), notif({ id: "n2" }), notif({ id: "n3", read_at: "2026-11-20T00:00:00Z" })] } } });
    renderApp("/worker");
    expect(await screen.findByRole("link", { name: "Notifications, 2 unread" })).toHaveAttribute("href", "/notifications");
  });

  it("lists notifications in plain language, links them, and marks them read", async () => {
    signInAs("worker");
    const f = installFetch({
      ...baseRoutes("worker"),
      "GET /api/notifications": { json: { notifications: [notif(), notif({ id: "n2", type: "application_rejected", payload: { job_title: "Deep clean", reason: "job_filled" } })] } },
      "POST /api/notifications/read": { json: { updated: 2 } },
    });
    renderApp("/notifications");
    expect(await screen.findByText("You're booked for “Shift household goods”")).toBeInTheDocument();
    expect(screen.getByText(/Your application for “Deep clean” wasn't selected\. The job filled up\./)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "View" })[0]).toHaveAttribute("href", "/worker/bookings");
    expect(screen.getByText("2 unread")).toBeInTheDocument();

    const user = userEvent.setup();
    f.set("GET /api/notifications", { json: { notifications: [notif({ read_at: "2026-11-20T00:00:00Z" }), notif({ id: "n2", read_at: "2026-11-20T00:00:00Z" })] } });
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    await waitFor(() => expect(screen.getByText("You're all caught up.")).toBeInTheDocument());
    expect(f.callsTo("POST /api/notifications/read")[0]?.body).toEqual({});
  });

  it("marks a single notification read by id", async () => {
    signInAs("employer");
    const f = installFetch({
      ...baseRoutes("employer"),
      "GET /api/notifications": { json: { notifications: [notif({ type: "new_application", payload: { job_title: "Sofa", job_id: "j9" } })] } },
      "POST /api/notifications/read": { json: { updated: 1 } },
    });
    renderApp("/notifications");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Mark read" }));
    expect(f.callsTo("POST /api/notifications/read")[0]?.body).toEqual({ ids: ["n1"] });
  });

  it("shows an empty state", async () => {
    signInAs("worker");
    installFetch({ ...baseRoutes("worker") });
    renderApp("/notifications");
    expect(await screen.findByText("No notifications yet")).toBeInTheDocument();
  });

  it("subscribes to Realtime for the signed-in user only, and toasts a new notification", async () => {
    signInAs("worker");
    const f = installFetch({ ...baseRoutes("worker"), "GET /api/jobs": emptyJobs });
    renderApp("/worker");
    await screen.findByRole("heading", { name: "Find work" });
    await waitFor(() => expect(fakeSupabase.channels).toHaveLength(1));
    expect(fakeSupabase.channels[0]?.filter).toBe(`user_id=eq.${WORKER_ID}`);

    // A new booking_confirmed arrives: the realtime event triggers a refetch, a toast and a badge.
    f.set("GET /api/notifications", { json: { notifications: [notif()] } });
    fakeSupabase.pushRealtime({ id: "n1" });
    expect(await screen.findByText(/You're booked for “Shift household goods”/)).toBeInTheDocument();
    expect(await screen.findByRole("link", { name: "Notifications, 1 unread" })).toBeInTheDocument();
  });

  it("unsubscribes from Realtime when leaving", async () => {
    signInAs("worker");
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": emptyJobs });
    const { unmount } = renderApp("/worker");
    await waitFor(() => expect(fakeSupabase.channels).toHaveLength(1));
    unmount();
    await waitFor(() => expect(fakeSupabase.client.removeChannel).toHaveBeenCalled());
  });

  it("refreshes lists when a new notification arrives", async () => {
    signInAs("employer");
    const f = installFetch({ ...baseRoutes("employer"), "GET /api/employer/jobs": { json: { jobs: [], page: { limit: 20, offset: 0 } } } });
    renderApp("/employer");
    await screen.findByText("You haven't posted any jobs yet");
    await waitFor(() => expect(fakeSupabase.channels).toHaveLength(1));
    const before = f.callsTo("GET /api/employer/jobs").length;
    f.set("GET /api/notifications", { json: { notifications: [notif({ type: "new_application", payload: { job_title: "Sofa", job_id: "j1" } })] } });
    fakeSupabase.pushRealtime({});
    await waitFor(() => expect(f.callsTo("GET /api/employer/jobs").length).toBeGreaterThan(before));
  });
});

describe("responsive navigation", () => {
  it("gives each role its own navigation", async () => {
    signInAs("worker");
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": emptyJobs });
    const { unmount } = renderApp("/worker");
    const nav = (await screen.findAllByRole("navigation", { name: "Main" }))[0]!;
    expect(within(nav).getAllByRole("link").map((l) => l.textContent)).toEqual(["Find work", "My applications", "Bookings", "Profile"]);
    unmount();

    fakeSupabase.reset();
    signInAs("employer");
    installFetch({ ...baseRoutes("employer"), "GET /api/employer/jobs": emptyJobs });
    renderApp("/employer");
    const nav2 = (await screen.findAllByRole("navigation", { name: "Main" }))[0]!;
    expect(within(nav2).getAllByRole("link").map((l) => l.textContent)).toEqual(["My jobs", "Create with AI", "Post a job", "Bookings", "Profile"]);
  });

  it("has a keyboard-operable mobile menu that reports its state", async () => {
    signInAs("worker");
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": emptyJobs });
    renderApp("/worker");
    const toggle = await screen.findByRole("button", { name: "Open menu" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    expect(toggle).toHaveAttribute("aria-controls", "mobile-nav");
    const user = userEvent.setup();
    toggle.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button", { name: "Close menu" })).toHaveAttribute("aria-expanded", "true");
    expect(document.getElementById("mobile-nav")).toBeInTheDocument();
    await user.click(within(document.getElementById("mobile-nav")!).getByRole("link", { name: "Bookings" }));
    expect(document.getElementById("mobile-nav")).not.toBeInTheDocument();
  });

  it("provides a skip link and a main landmark", async () => {
    signInAs("worker");
    installFetch({ ...baseRoutes("worker"), "GET /api/jobs": emptyJobs });
    renderApp("/worker");
    const skip = await screen.findByRole("link", { name: "Skip to main content" });
    expect(skip).toHaveAttribute("href", "#main");
    expect(screen.getByRole("main")).toHaveAttribute("id", "main");
  });

  it("marks the current page in the navigation", async () => {
    signInAs("worker");
    installFetch({ ...baseRoutes("worker"), "GET /api/me/applications": { json: { applications: [] } } });
    renderApp("/worker/applications");
    const nav = (await screen.findAllByRole("navigation", { name: "Main" }))[0]!;
    expect(within(nav).getByRole("link", { name: "My applications" })).toHaveAttribute("aria-current", "page");
    expect(within(nav).getByRole("link", { name: "Find work" })).not.toHaveAttribute("aria-current");
  });
});

describe("accessible forms", () => {
  const pages: [string, "worker" | "employer" | null, string][] = [
    ["login", null, "/login"],
    ["signup", null, "/signup"],
    ["new job", "employer", "/employer/jobs/new"],
    ["worker profile", "worker", "/worker/profile"],
    ["employer profile", "employer", "/employer/profile"],
  ];

  it.each(pages)("%s: exactly one h1 and every control has a label", async (_name, role, path) => {
    if (role) signInAs(role);
    installFetch({ ...baseRoutes(role ?? "worker") });
    renderApp(path);
    await screen.findAllByRole("heading", { level: 1 });
    await waitFor(() => expect(document.querySelectorAll("input, select, textarea").length).toBeGreaterThan(0));
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    const controls = [...document.querySelectorAll<HTMLInputElement>("input, select, textarea")].filter((c) => c.type !== "hidden");
    for (const c of controls) expect((c.labels?.length ?? 0) > 0 || c.getAttribute("aria-label"), `${c.outerHTML} has no label`).toBeTruthy();
  });

  it("links each field's error message to the field with aria-describedby and announces it", async () => {
    installFetch({ ...baseRoutes("worker") });
    renderApp("/signup");
    await userEvent.setup().click(await screen.findByRole("button", { name: "Create account" }));
    const email = await screen.findByLabelText(/^Email/);
    expect(email).toHaveAttribute("aria-invalid", "true");
    const errorId = email.getAttribute("aria-describedby")!.split(" ").find((id) => id.endsWith("-error"))!;
    const message = document.getElementById(errorId)!;
    expect(message).toHaveTextContent("Enter a valid email address.");
    expect(message).toHaveAttribute("role", "alert");
  });

  it("groups the role choice and category choices in labelled fieldsets", async () => {
    installFetch({ ...baseRoutes("worker") });
    const { unmount } = renderApp("/signup");
    expect(await screen.findByRole("group", { name: /I am/ })).toBeInTheDocument();
    unmount();
    signInAs("worker");
    installFetch({ ...baseRoutes("worker") });
    renderApp("/worker/profile");
    expect(await screen.findByRole("group", { name: /Work you do/ })).toBeInTheDocument();
  });

  it("announces loading states to assistive technology", async () => {
    signInAs("worker");
    // The job list request never resolves, so the loading state stays on screen.
    vi.stubGlobal("fetch", vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/jobs")) return new Promise<Response>(() => {});
      const json = url.includes("/api/me") ? { profile: { id: WORKER_ID, role: "worker", full_name: "Ravi", org_name: null, preferred_language: "en", created_at: "", updated_at: "" }, worker: { category_ids: [1], locality_id: 1 } }
        : url.includes("categories") ? { categories: [] } : url.includes("localities") ? { localities: [] } : url.includes("public-config") ? { supabaseUrl: "u", supabaseAnonKey: "k" } : { notifications: [] };
      return Promise.resolve(new Response(JSON.stringify(json), { status: 200, headers: { "content-type": "application/json" } }));
    }));
    renderApp("/worker");
    const loading = await screen.findByText("Loading jobs…");
    expect(loading.closest("[role=status]")).toHaveAttribute("aria-live", "polite");
  });
});

describe("architecture guardrails", () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const files = (dir: string): string[] =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "test" ? [] : files(path.join(dir, e.name))) : [path.join(dir, e.name)]));
  const prod = files(srcDir).filter((f) => /\.(ts|tsx)$/.test(f));
  const read = (f: string) => fs.readFileSync(f, "utf8");
  const rel = (f: string) => path.relative(srcDir, f).replaceAll("\\", "/");

  it("never references a service-role key", () => {
    expect(prod.filter((f) => /service_role|SERVICE_ROLE|serviceRole/i.test(read(f))).map(rel)).toEqual([]);
  });

  it("never reads or writes database tables or calls RPCs through the Supabase client (the API is the only data path)", () => {
    // A table or function name is always passed as a string literal; Array.from(...) is not a match.
    expect(prod.filter((f) => /\.(from|rpc)\(\s*["'`]/.test(read(f))).map(rel)).toEqual([]);
  });

  it("only talks to the network through lib/api.ts", () => {
    expect(prod.filter((f) => /\bfetch\(/.test(read(f))).map(rel)).toEqual(["lib/api.ts"]);
  });

  it("uses the Supabase client only for auth and Realtime", () => {
    const users = prod.filter((f) => /getSupabase/.test(read(f))).map(rel).sort();
    expect(users).toEqual(["lib/auth.tsx", "lib/notifications.tsx", "lib/supabase.ts"]);
  });

  it("does not hard-code Supabase URLs or keys", () => {
    expect(prod.filter((f) => /supabase\.co|eyJ[A-Za-z0-9_-]{20,}|sb_(secret|publishable)_/i.test(read(f))).map(rel)).toEqual([]);
  });

  it("ships no test doubles or mock data in production code", () => {
    expect(prod.filter((f) => /from ["'](\.\.?\/)+test\//.test(read(f)) || /\bfaker\b|lorem ipsum|MOCK_/i.test(read(f))).map(rel)).toEqual([]);
  });

  it("uses only the endpoints documented in docs/api.md", () => {
    const documented = new Set([
      "/public-config", "/me", "/me/profile", "/me/worker-profile", "/categories", "/localities", "/jobs", "/employer/jobs", "/me/applications",
      "/me/bookings", "/notifications", "/notifications/read", "/me/contact", "/ai/status", "/ai/job-draft", "/contact",
    ]);
    const dynamic = [/^\/jobs\/\$\{[^}]+\}$/, /^\/jobs\/\$\{[^}]+\}\/(cancel|applications|applicants)$/, /^\/applications\/\$\{[^}]+\}\/(withdraw|accept|reject)$/, /^\/bookings\/\$\{[^}]+\}\/(cancel|contact)$/];
    const used = [...read(path.join(srcDir, "lib/api.ts")).matchAll(/request<[^>]*(?:<[^>]*>[^>]*)*>\(\s*"[A-Z]+",\s*[`"]([^`"]+)[`"]/g)].map((m) => m[1]!);
    expect(used.length).toBeGreaterThan(15);
    for (const u of used) expect(documented.has(u) || dynamic.some((re) => re.test(u)), `undocumented endpoint ${u}`).toBe(true);
  });

  void [job, EMPLOYER_ID];
});
