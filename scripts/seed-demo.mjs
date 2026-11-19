#!/usr/bin/env node
// Provisions KaamSetu demo accounts and a realistic marketplace for judges and demos.
//
//   node scripts/seed-demo.mjs --dry-run                         (shows the plan; connects to nothing)
//   node scripts/seed-demo.mjs --confirm=praqzylbpqanqexhputi    (creates the demo data)
//     options: --with-history        also create one finished job with ratings (waits ~45 s)
//              --reset-passwords     set the demo passwords again on accounts that already exist
//              --cleanup             cancel the demo jobs (reversible) instead of creating anything
//
// Environment (never printed, never committed): SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY,
// DEMO_PASSWORD_EMPLOYER, DEMO_PASSWORD_WORKER (each password at least 12 characters).
//
// SAFETY: it refuses unless SUPABASE_URL is exactly https://praqzylbpqanqexhputi.supabase.co and --confirm=praqzylbpqanqexhputi
// is given. Nothing else in this repository calls it. See docs/demo-data.md.
import { DEMO_PROJECT_REF, assertConfirmed, assertDemoTarget, readPasswords } from "./demo/guard.mjs";
import { DEMO_EMAIL_DOMAIN, EMPLOYER, WORKERS, buildJobs } from "./demo/data.mjs";
import { cancelDemoJobs, makeClients, provision } from "./demo/provision.mjs";

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const log = (s) => console.log(`[demo] ${s}`);

function printPlan() {
  log(`target project: ${DEMO_PROJECT_REF}`);
  log(`accounts (all @${DEMO_EMAIL_DOMAIN}, pre-confirmed): 1 employer + ${WORKERS.length} workers`);
  log(`  employer: ${EMPLOYER.email}`);
  for (const w of WORKERS) log(`  worker:   ${w.email}  (${w.locality}, ${w.categories.join(", ")})`);
  const jobs = buildJobs();
  log(`jobs (${jobs.length}), all tagged "[Demo data]":`);
  for (const j of jobs) log(`  - ${j.title} · ${j.locality} · ${j.workers_needed} needed · ${j.apply?.length ?? 0} applying · ${j.accept?.length ?? 0} booked`);
  if (has("--with-history")) log("  + 1 finished job with ratings (created to start in ~40 s, then completed)");
}

try {
  if (has("--dry-run")) {
    printPlan();
    log("dry run: nothing was changed and no connection was made.");
    process.exit(0);
  }

  const url = process.env.SUPABASE_URL;
  assertDemoTarget(url);
  assertConfirmed(argv);
  const passwords = readPasswords(process.env);
  for (const k of ["SUPABASE_ANON_KEY", "SUPABASE_SERVICE_ROLE_KEY"]) {
    if (!process.env[k]?.trim()) throw new Error(`Missing environment variable: ${k}.`);
  }
  const clients = makeClients({ url, anonKey: process.env.SUPABASE_ANON_KEY.trim(), serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY.trim() });

  if (has("--cleanup")) {
    const { cancelled } = await cancelDemoJobs(clients, passwords, { log });
    log(`cancelled ${cancelled} demo job(s). To remove the accounts and rows completely, see docs/demo-data.md.`);
  } else {
    printPlan();
    const report = await provision(clients, passwords, { log, withHistory: has("--with-history"), resetPasswords: has("--reset-passwords") });
    log(`done: ${report.accounts} accounts created, ${report.jobs} jobs created, ${report.applications} applications, ${report.bookings} bookings, ${report.locations} addresses${report.history ? ", 1 finished job with ratings" : ""}.`);
    for (const s of report.skipped) log(`skipped: ${s}`);
  }
} catch (err) {
  console.error(`[demo] ${err.message}`);
  process.exit(1);
}
