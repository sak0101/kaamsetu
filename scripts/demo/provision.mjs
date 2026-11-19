// Provisions the KaamSetu demo marketplace. It is idempotent: running it twice creates nothing twice.
//
// It uses ONLY the supported write path: the Auth admin API for accounts, and the same database functions the Express
// API calls (as the service role, with the demo user as the actor). It never touches a table directly, never reads a
// secret from anywhere except the arguments, and never prints a password.
//
// This module does not decide WHERE to run: scripts/seed-demo.mjs does, behind guard.mjs. Tests call provision()
// directly against the local Supabase stack.
import { createClient } from "@supabase/supabase-js";
import { DEMO_MARKER, EMPLOYER, HISTORY_JOB, WORKERS, buildJobs } from "./data.mjs";

const OPTS = { auth: { persistSession: false, autoRefreshToken: false } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Builds the three clients: admin (service role: Auth admin + RPC only), anon (sign-in), and a per-user read client. */
export function makeClients({ url, anonKey, serviceRoleKey }) {
  return {
    admin: createClient(url, serviceRoleKey, OPTS),
    anon: createClient(url, anonKey, OPTS),
    userClient: (token) => createClient(url, anonKey, { ...OPTS, global: { headers: { Authorization: `Bearer ${token}` } } }),
  };
}

async function findUserId(admin, email) {
  for (let page = 1; page <= 10; page++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error) throw new Error(`Could not list users: ${error.message}`);
    const hit = data.users.find((u) => u.email?.toLowerCase() === email.toLowerCase());
    if (hit) return hit.id;
    if (data.users.length < 200) return null;
  }
  return null;
}

/** Creates the account if it is missing (pre-confirmed, role in metadata). Returns { id, created }. */
async function ensureUser(admin, { email, full_name }, role, password, resetPasswords) {
  const existing = await findUserId(admin, email);
  if (existing) {
    if (resetPasswords) {
      const { error } = await admin.auth.admin.updateUserById(existing, { password });
      if (error) throw new Error(`Could not reset the password for ${email}: ${error.message}`);
    }
    return { id: existing, created: false };
  }
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true, user_metadata: { role, full_name } });
  if (error) throw new Error(`Could not create ${email}: ${error.message}`);
  return { id: data.user.id, created: true };
}

async function signIn(anon, email, password) {
  const { data, error } = await anon.auth.signInWithPassword({ email, password });
  if (error || !data.session) {
    throw new Error(`Could not sign in as ${email}. If this demo account already exists with a different password, run again with --reset-passwords.`);
  }
  return data.session.access_token;
}

async function rpc(admin, fn, args) {
  const { data, error } = await admin.rpc(fn, args);
  if (error) throw new Error(`${fn} failed: ${error.message}`);
  return data;
}

/**
 * @param {{admin, anon, userClient}} clients
 * @param {{employer: string, worker: string}} passwords
 * @param {{log?: (s: string) => void, withHistory?: boolean, resetPasswords?: boolean, now?: Date}} options
 */
export async function provision(clients, passwords, { log = () => {}, withHistory = false, resetPasswords = false, now = new Date() } = {}) {
  const { admin, anon, userClient } = clients;
  const report = { accounts: 0, profiles: 0, jobs: 0, applications: 0, bookings: 0, locations: 0, history: 0, skipped: [] };

  // ---- accounts -----------------------------------------------------------------------------------------------
  const employer = await ensureUser(admin, EMPLOYER, "employer", passwords.employer, resetPasswords);
  if (employer.created) report.accounts++;
  const workers = {};
  for (const w of WORKERS) {
    const u = await ensureUser(admin, w, "worker", passwords.worker, resetPasswords);
    workers[w.key] = { ...w, id: u.id };
    if (u.created) report.accounts++;
  }
  log(`accounts: ${report.accounts} created, ${WORKERS.length + 1 - report.accounts} already existed`);

  // ---- reference data (read as a demo user: row-level security allows signed-in users to read it) -----------
  const employerToken = await signIn(anon, EMPLOYER.email, passwords.employer);
  const employerClient = userClient(employerToken);
  const [cats, locs] = await Promise.all([
    employerClient.from("work_categories").select("id,slug"),
    employerClient.from("localities").select("id,name"),
  ]);
  if (cats.error || locs.error) throw new Error("Could not read categories and localities. Are the migrations applied?");
  const categoryId = (slug) => cats.data.find((c) => c.slug === slug)?.id;
  const localityId = (name) => locs.data.find((l) => l.name === name)?.id;

  // ---- employer profile -----------------------------------------------------------------------------------------
  await rpc(admin, "update_profile", { p_actor: employer.id, p_full_name: EMPLOYER.full_name, p_preferred_language: "en", p_org_name: EMPLOYER.org_name });
  await rpc(admin, "save_contact", { p_actor: employer.id, p_phone: EMPLOYER.phone });

  // ---- worker profiles ------------------------------------------------------------------------------------------
  for (const w of Object.values(workers)) {
    await rpc(admin, "update_profile", { p_actor: w.id, p_full_name: w.full_name, p_preferred_language: "en", p_org_name: null });
    await rpc(admin, "save_worker_profile", {
      p_actor: w.id, p_bio: w.bio, p_years_experience: w.years, p_locality_id: localityId(w.locality), p_is_available: true,
      p_category_ids: w.categories.map(categoryId), p_skills: w.skills, p_availability_note: w.availability,
    });
    if (w.phone) await rpc(admin, "save_contact", { p_actor: w.id, p_phone: w.phone });
    report.profiles++;
  }

  // ---- jobs (skip any title the demo employer already has: this is what makes a re-run harmless) --------------
  const have = await employerClient.from("jobs").select("id,title");
  if (have.error) throw new Error(`Could not read existing jobs: ${have.error.message}`);
  const existingByTitle = new Map(have.data.map((j) => [j.title, j.id]));
  const jobIds = new Map();

  for (const j of buildJobs(now)) {
    let id = existingByTitle.get(j.title);
    if (!id) {
      id = await rpc(admin, "create_job", {
        p_actor: employer.id, p_category_id: categoryId(j.category), p_locality_id: localityId(j.locality), p_title: j.title, p_description: j.description,
        p_starts_at: j.starts_at, p_ends_at: j.ends_at, p_workers_needed: j.workers_needed, p_pay_type: j.pay_type, p_pay_amount_paise: j.pay_amount_paise,
      });
      report.jobs++;
      if (j.address) {
        try {
          await rpc(admin, "save_job_location", { p_actor: employer.id, p_job_id: id, p_address_line: j.address, p_landmark: j.landmark ?? null });
          report.locations++;
        } catch (err) {
          report.skipped.push(`address for "${j.title}" (${err.message}). Apply the latest migrations to enable job locations.`);
        }
      }
    }
    jobIds.set(j.title, { id, spec: j });
  }

  // ---- applications and bookings --------------------------------------------------------------------------------
  const tokens = {};
  const myApplications = {};
  for (const w of Object.values(workers)) {
    tokens[w.key] = await signIn(anon, w.email, passwords.worker);
    const mine = await userClient(tokens[w.key]).from("job_applications").select("id,job_id,status");
    if (mine.error) throw new Error(`Could not read applications: ${mine.error.message}`);
    myApplications[w.key] = new Map(mine.data.map((a) => [a.job_id, a]));
  }

  for (const { id, spec } of jobIds.values()) {
    for (const key of spec.apply ?? []) {
      const w = workers[key];
      let app = myApplications[key].get(id);
      if (!app) {
        try {
          const appId = await rpc(admin, "apply_to_job", { p_actor: w.id, p_job_id: id, p_message: null });
          app = { id: appId, status: "pending" };
          report.applications++;
        } catch (err) {
          report.skipped.push(`${w.full_name} applying to "${spec.title}" (${err.message})`);
          continue;
        }
      }
      if ((spec.accept ?? []).includes(key) && app.status === "pending") {
        try {
          await rpc(admin, "accept_application", { p_actor: employer.id, p_application_id: app.id });
          report.bookings++;
        } catch (err) {
          report.skipped.push(`confirming ${w.full_name} for "${spec.title}" (${err.message})`);
        }
      }
    }
  }

  // ---- one finished job with ratings (optional: it has to wait for the job to start) -----------------------------
  if (withHistory && !existingByTitle.has(HISTORY_JOB.title)) {
    const w = workers[HISTORY_JOB.worker];
    const start = new Date(now.getTime() + 40_000);
    const end = new Date(start.getTime() + 2 * 3_600_000);
    const jobId = await rpc(admin, "create_job", {
      p_actor: employer.id, p_category_id: categoryId(HISTORY_JOB.category), p_locality_id: localityId(HISTORY_JOB.locality), p_title: HISTORY_JOB.title,
      p_description: HISTORY_JOB.description, p_starts_at: start.toISOString(), p_ends_at: end.toISOString(), p_workers_needed: HISTORY_JOB.workers_needed,
      p_pay_type: HISTORY_JOB.pay_type, p_pay_amount_paise: HISTORY_JOB.pay_amount_paise,
    });
    const appId = await rpc(admin, "apply_to_job", { p_actor: w.id, p_job_id: jobId, p_message: null });
    const bookingId = await rpc(admin, "accept_application", { p_actor: employer.id, p_application_id: appId });
    const wait = Math.max(0, start.getTime() - Date.now()) + 3_000;
    log(`waiting ${Math.ceil(wait / 1000)} s for the history job to start...`);
    await sleep(wait);
    await rpc(admin, "finish_booking", { p_actor: employer.id, p_booking_id: bookingId, p_outcome: "completed" });
    await rpc(admin, "submit_review", { p_actor: employer.id, p_booking_id: bookingId, p_rating: HISTORY_JOB.employerReview.rating, p_comment: HISTORY_JOB.employerReview.comment });
    await rpc(admin, "submit_review", { p_actor: w.id, p_booking_id: bookingId, p_rating: HISTORY_JOB.workerReview.rating, p_comment: HISTORY_JOB.workerReview.comment });
    report.history++;
  }

  return report;
}

/**
 * Reversible clean-up through the supported path: cancel every open demo job (their applications are declined and
 * their bookings cancelled by the database). Accounts and cancelled-job rows remain; see docs/demo-data.md for the
 * SQL that removes them completely.
 */
export async function cancelDemoJobs(clients, passwords, { log = () => {} } = {}) {
  const { admin, anon, userClient } = clients;
  const employerId = await findUserId(admin, EMPLOYER.email);
  if (!employerId) {
    log("no demo employer found: nothing to clean up");
    return { cancelled: 0 };
  }
  const token = await signIn(anon, EMPLOYER.email, passwords.employer);
  const jobs = await userClient(token).from("jobs").select("id,title,status,description").neq("status", "cancelled");
  if (jobs.error) throw new Error(`Could not read jobs: ${jobs.error.message}`);
  let cancelled = 0;
  for (const j of jobs.data.filter((x) => x.description.includes(DEMO_MARKER))) {
    try {
      await rpc(admin, "cancel_job", { p_actor: employerId, p_job_id: j.id, p_reason: "Demo data removed" });
      cancelled++;
    } catch {
      /* a job that already ended cannot be cancelled: leave it */
    }
  }
  return { cancelled };
}
