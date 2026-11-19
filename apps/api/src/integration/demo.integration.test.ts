// Runs the demo provisioner against the LOCAL Supabase stack (never hosted): complete, and idempotent.
// Run with: npm run test:integration -w @kaamsetu/api
import { randomBytes } from "node:crypto";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { loadSupabaseConfig } from "../config";

const cfg = loadSupabaseConfig(process.env);
const scripts = path.resolve(__dirname, "../../../../scripts/demo");
const load = (f: string) => import(pathToFileURL(path.join(scripts, f)).href) as Promise<Record<string, any>>;
const passwords = { employer: `Em-${randomBytes(9).toString("hex")}`, worker: `Wk-${randomBytes(9).toString("hex")}` };

describe("demo data provisioning (local stack)", () => {
  it("only ever runs here against a local URL", () => {
    expect(new URL(cfg.url).hostname).toMatch(/^(127\.0\.0\.1|localhost)$/);
  });

  it("creates the marketplace once, and a second run creates nothing", async () => {
    const { provision, makeClients, cancelDemoJobs } = await load("provision.mjs");
    const data = await load("data.mjs");
    const clients = makeClients({ url: cfg.url, anonKey: cfg.anonKey, serviceRoleKey: cfg.serviceRoleKey });

    const first = await provision(clients, passwords, {});
    expect(first).toMatchObject({ accounts: 7, profiles: 6, history: 0 });
    expect(first.jobs).toBe(data.buildJobs().length);
    expect(first.applications).toBeGreaterThan(8);
    expect(first.bookings).toBeGreaterThanOrEqual(3);
    expect(first.locations).toBe(2);
    expect(first.skipped).toEqual([]);

    const second = await provision(clients, passwords, {});
    expect(second).toMatchObject({ accounts: 0, jobs: 0, applications: 0, bookings: 0, locations: 0 });

    // what a judge sees
    const anon = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: false } });
    const { data: session } = await anon.auth.signInWithPassword({ email: data.WORKERS[0].email, password: passwords.worker });
    const asWorker = createClient(cfg.url, cfg.anonKey, { auth: { persistSession: false }, global: { headers: { Authorization: `Bearer ${session.session!.access_token}` } } });
    const jobs = await asWorker.from("jobs").select("title,workers_needed,positions_filled,description").eq("status", "open").like("description", "%[Demo data]%");
    expect(jobs.data!.length).toBeGreaterThanOrEqual(10);
    expect(jobs.data!.find((j) => j.title === "Wedding helpers, Alkapuri")).toMatchObject({ workers_needed: 8, positions_filled: 2 }); // "2 of 8 booked"

    // clean-up through the supported path cancels the demo jobs
    const gone = await cancelDemoJobs(clients, passwords, {});
    expect(gone.cancelled).toBeGreaterThanOrEqual(10);
  });
});
