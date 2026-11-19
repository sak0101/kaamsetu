import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

// The demo scripts are plain ES modules in /scripts. They are imported dynamically so the TypeScript build never needs them.
const scripts = path.resolve(__dirname, "../../../scripts/demo");
const load = (f: string) => import(pathToFileURL(path.join(scripts, f)).href) as Promise<Record<string, any>>;

describe("demo data safety guard", () => {
  it("accepts exactly one project", async () => {
    const g = await load("guard.mjs");
    expect(g.DEMO_PROJECT_REF).toBe("praqzylbpqanqexhputi");
    expect(g.assertDemoTarget("https://praqzylbpqanqexhputi.supabase.co")).toBe("praqzylbpqanqexhputi");
    expect(g.assertDemoTarget("https://praqzylbpqanqexhputi.supabase.co/")).toBe("praqzylbpqanqexhputi");
  });

  it.each([
    ["the local stack", "http://127.0.0.1:54321"],
    ["localhost", "http://localhost:54321"],
    ["another project", "https://abcdefghijklmnopqrst.supabase.co"],
    ["a look-alike host", "https://praqzylbpqanqexhputi.supabase.co.evil.example"],
    ["a look-alike prefix", "https://evil-praqzylbpqanqexhputi.supabase.co"],
    ["the ref as a path", "https://example.com/praqzylbpqanqexhputi.supabase.co"],
    ["plain http", "http://praqzylbpqanqexhputi.supabase.co"],
    ["a missing URL", undefined],
    ["an empty URL", ""],
    ["junk", "not a url"],
  ])("refuses %s", async (_label, url) => {
    const g = await load("guard.mjs");
    expect(() => g.assertDemoTarget(url)).toThrow(/Refusing to run/);
  });

  it("requires an explicit --confirm with the exact ref", async () => {
    const g = await load("guard.mjs");
    expect(() => g.assertConfirmed([])).toThrow(/--confirm=praqzylbpqanqexhputi/);
    expect(() => g.assertConfirmed(["--confirm=other"])).toThrow();
    expect(() => g.assertConfirmed(["--confirm=praqzylbpqanqexhputi"])).not.toThrow();
  });

  it("reads passwords from the environment only, requires 12+ characters, and never echoes them", async () => {
    const g = await load("guard.mjs");
    expect(() => g.readPasswords({})).toThrow(/DEMO_PASSWORD_EMPLOYER, DEMO_PASSWORD_WORKER/);
    let message = "";
    try {
      g.readPasswords({ DEMO_PASSWORD_EMPLOYER: "short-secr", DEMO_PASSWORD_WORKER: "long-enough-password" });
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/at least 12/);
    expect(message).not.toContain("short-secr");
    expect(g.readPasswords({ DEMO_PASSWORD_EMPLOYER: "employer-password-1", DEMO_PASSWORD_WORKER: "worker-password-1" })).toEqual({ employer: "employer-password-1", worker: "worker-password-1" });
  });
});

describe("demo data content", () => {
  it("is clearly demo data: reserved email domain, '(Demo)' names, and a marker on every job", async () => {
    const d = await load("data.mjs");
    const accounts = [d.EMPLOYER, ...d.WORKERS];
    expect(accounts).toHaveLength(7);
    for (const a of accounts) {
      expect(a.email).toMatch(/@kaamsetu\.invalid$/);
      expect(a.full_name).toMatch(/\(Demo\)$/);
      expect(a.phone === null || /^\+91[6-9]\d{9}$/.test(a.phone)).toBe(true);
    }
    expect(d.EMPLOYER.org_name).toMatch(/\(Demo\)$/);
    const jobs = d.buildJobs(new Date("2026-11-19T04:30:00Z"));
    expect(jobs.length).toBeGreaterThanOrEqual(8);
    for (const j of jobs) {
      expect(j.description).toContain("[Demo data]");
      expect(j.description.length).toBeLessThanOrEqual(1000);
      expect(j.title.length).toBeGreaterThanOrEqual(5);
      expect(j.title.length).toBeLessThanOrEqual(100);
      expect(Date.parse(j.ends_at)).toBeGreaterThan(Date.parse(j.starts_at));
      expect(j.pay_amount_paise).toBeGreaterThan(0);
      expect(j.pay_amount_paise).toBeLessThanOrEqual(5_000_000);
      expect(j.workers_needed).toBeGreaterThanOrEqual(1);
      expect((j.accept ?? []).length).toBeLessThanOrEqual(j.workers_needed);
      for (const k of [...(j.apply ?? []), ...(j.accept ?? [])]) expect(d.WORKERS.map((w: any) => w.key)).toContain(k);
      for (const k of j.accept ?? []) expect(j.apply).toContain(k);
    }
    expect(new Set(jobs.map((j: any) => j.title)).size).toBe(jobs.length); // titles are the idempotency key
  });

  it("covers the product's story: urgency, every kind of event, fairness for a worker with no stated experience, an address, and booked progress", async () => {
    const d = await load("data.mjs");
    const jobs = d.buildJobs(new Date("2026-11-19T04:30:00Z"));
    const text = jobs.map((j: any) => j.title.toLowerCase()).join(" | ");
    for (const kind of ["wedding", "catering", "exhibition", "puja", "corporate"]) expect(text).toContain(kind);
    expect(d.WORKERS.some((w: any) => w.years === null)).toBe(true);
    expect(jobs.some((j: any) => j.address)).toBe(true);
    expect(jobs.some((j: any) => (j.accept ?? []).length > 0 && j.workers_needed > j.accept.length)).toBe(true);
    // some job starts within the next day, some later in the week
    const hours = jobs.map((j: any) => (Date.parse(j.starts_at) - Date.parse("2026-11-19T04:30:00Z")) / 3_600_000);
    expect(Math.min(...hours)).toBeLessThan(24);
    expect(Math.max(...hours)).toBeGreaterThan(24 * 4);
  });

  it("the earliest job always starts in the future, whatever time of day the script runs", async () => {
    const d = await load("data.mjs");
    for (const hour of [0, 3, 8, 12, 18, 21, 23]) {
      const now = new Date(Date.UTC(2026, 10, 19, hour, 10));
      for (const j of d.buildJobs(now)) {
        expect(Date.parse(j.starts_at), `${j.title} at ${hour}:10 UTC`).toBeGreaterThan(now.getTime());
        expect(Date.parse(j.ends_at) - Date.parse(j.starts_at)).toBeLessThanOrEqual(14 * 86_400_000);
      }
    }
  });

  it("the seed script refuses, without connecting, when pointed at the local stack or given no confirmation", async () => {
    const { spawnSync } = await import("node:child_process");
    const script = path.resolve(__dirname, "../../../scripts/seed-demo.mjs");
    const run = (args: string[], env: Record<string, string>) =>
      spawnSync(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? "", ...env }, encoding: "utf8" });
    const local = run(["--confirm=praqzylbpqanqexhputi"], { SUPABASE_URL: "http://127.0.0.1:54321", DEMO_PASSWORD_EMPLOYER: "x".repeat(20), DEMO_PASSWORD_WORKER: "y".repeat(20) });
    expect(local.status).toBe(1);
    expect(local.stderr).toMatch(/Refusing to run/);
    const unconfirmed = run([], { SUPABASE_URL: "https://praqzylbpqanqexhputi.supabase.co", DEMO_PASSWORD_EMPLOYER: "x".repeat(20), DEMO_PASSWORD_WORKER: "y".repeat(20) });
    expect(unconfirmed.status).toBe(1);
    expect(unconfirmed.stderr).toMatch(/--confirm=praqzylbpqanqexhputi/);
    const dry = run(["--dry-run"], {});
    expect(dry.status).toBe(0);
    expect(dry.stdout).toMatch(/dry run: nothing was changed/);
    expect(dry.stdout).not.toMatch(/password/i);
  });
});
