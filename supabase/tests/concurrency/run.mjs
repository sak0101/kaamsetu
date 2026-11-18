// Concurrency tests against the LOCAL Supabase database container only.
//   node supabase/tests/concurrency/run.mjs
// Requires `supabase start`. Uses parallel psql sessions via `docker exec`.
// Creates users with @conc.invalid emails and removes them again.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

const CONTAINER = "supabase_db_kaamsetu"; // project_id = kaamsetu (local only)
const SVC_ROLE = `set role service_role; select set_config('request.jwt.claims','{"role":"service_role"}',false);`;
const SVC_CLAIM = `select set_config('request.jwt.claims','{"role":"service_role"}',false);`; // owner session + claim (lets stress subselects read tables)

function psql(sql) {
  return new Promise((resolve) => {
    const p = spawn("docker", ["exec", "-i", CONTAINER, "psql", "-U", "postgres", "-d", "postgres", "-X", "-q", "-A", "-t"], { stdio: ["pipe", "pipe", "pipe"] });
    let out = "", err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", () => resolve({ out, err }));
    p.stdin.end(sql);
  });
}
const q = async (sql) => (await psql(sql)).out.trim();
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/gm;
const successes = (r) => (r.out.match(UUID_RE) || []).length;

let failures = 0, checks = 0;
function check(name, ok, detail = "") {
  checks++;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : "  -> " + detail}`);
}

async function cleanup() {
  await psql(`
    delete from public.notifications where user_id in (select id from auth.users where email like '%@conc.invalid');
    delete from public.bookings where employer_id in (select id from auth.users where email like '%@conc.invalid');
    delete from public.job_applications where job_id in (select id from public.jobs where employer_id in (select id from auth.users where email like '%@conc.invalid'));
    delete from public.jobs where employer_id in (select id from auth.users where email like '%@conc.invalid');
    delete from auth.users where email like '%@conc.invalid';`);
}
async function mkUser(role, name) {
  const id = randomUUID();
  const r = await psql(`insert into auth.users (id,aud,role,email,raw_user_meta_data,created_at,updated_at) values
    ('${id}','authenticated','authenticated','${id}@conc.invalid','{"role":"${role}","full_name":"${name}"}',now(),now());
    ${role === "worker" ? `update public.worker_profiles set locality_id=1, years_experience=1 where user_id='${id}';
    insert into public.worker_categories values ('${id}',1);` : ""}`);
  if (r.err.includes("ERROR")) throw new Error(r.err);
  return id;
}
async function mkJob(employer, startHours, durHours, needed) {
  return q(`insert into public.jobs (employer_id,category_id,locality_id,title,description,starts_at,ends_at,workers_needed,pay_type,pay_amount_paise)
    values ('${employer}',1,1,'Concurrency job','x', now()+interval '${startHours} hours', now()+interval '${startHours + durHours} hours', ${needed},'daily',80000) returning id;`).then((s) => s.split("\n")[0]);
}
async function mkApp(job, worker) {
  return q(`insert into public.job_applications (job_id,worker_id) values ('${job}','${worker}') returning id;`).then((s) => s.split("\n")[0]);
}
const invariants = () => q(`
  select
   (select count(*) from public.jobs j where j.employer_id in (select id from auth.users where email like '%@conc.invalid')
      and (j.positions_filled <> (select count(*) from public.bookings b where b.job_id=j.id and b.status in ('confirmed','in_progress','completed'))
        or j.positions_filled < 0 or j.positions_filled > j.workers_needed)) || '|' ||
   (select count(*) from public.bookings a join public.bookings b on a.worker_id=b.worker_id and a.id<b.id
      and a.status in ('confirmed','in_progress') and b.status in ('confirmed','in_progress') and a.work_period && b.work_period
     where a.employer_id in (select id from auth.users where email like '%@conc.invalid'));`);

console.log("Cleaning previous concurrency data...");
await cleanup();

// ---- 0. isolation guard ---------------------------------------------------
{
  const e = await mkUser("employer", "Iso Employer");
  const r = await psql(`${SVC_ROLE} begin isolation level repeatable read; select public.update_profile('${e}','Iso Employer','en',null); rollback;`);
  check("API functions refuse REPEATABLE READ (KS500)", r.err.includes("unsupported_isolation_level"), r.err);
}

// ---- 1/2. simultaneous last-slot acceptance -------------------------------
for (const [needed, applicants] of [[1, 8], [3, 10]]) {
  const emp = await mkUser("employer", "Cap Employer");
  const job = await mkJob(emp, 24, 4, needed);
  const apps = [];
  for (let i = 0; i < applicants; i++) apps.push(await mkApp(job, await mkUser("worker", `Cap Worker ${i}`)));
  const results = await Promise.all(apps.map((a) => psql(`${SVC_ROLE} select public.accept_application('${emp}','${a}');`)));
  const won = results.reduce((n, r) => n + successes(r), 0);
  const row = await q(`select positions_filled||'/'||status||'/'||(select count(*) from public.bookings where job_id='${job}')||'/'||
    (select count(*) from public.job_applications where job_id='${job}' and status='accepted') from public.jobs where id='${job}';`);
  check(`last-slot race: ${applicants} parallel accepts on ${needed}-slot job -> exactly ${needed} succeed`, won === needed, `won=${won}`);
  check(`  counters consistent (${needed}/filled/${needed} bookings/${needed} accepted)`, row === `${needed}/filled/${needed}/${needed}`, row);
  check("  no unexpected errors (only job_full / not_pending style conflicts)",
    !/deadlock|serialize|KS500|duplicate key|violates/i.test(results.map((r) => r.err).join("")), results.map((r) => r.err).join("").slice(0, 300));
}

// ---- 3. same application accepted by many parallel callers -----------------
{
  const emp = await mkUser("employer", "Dbl Employer");
  const job = await mkJob(emp, 30, 4, 5);
  const app = await mkApp(job, await mkUser("worker", "Dbl Worker"));
  const results = await Promise.all(Array.from({ length: 6 }, () => psql(`${SVC_ROLE} select public.accept_application('${emp}','${app}');`)));
  check("double-click race: same application accepted by 6 parallel callers -> exactly 1 booking", results.reduce((n, r) => n + successes(r), 0) === 1);
  check("  exactly one booking row and counter 1", (await q(`select count(*)||'/'||(select positions_filled from public.jobs where id='${job}') from public.bookings where job_id='${job}';`)) === "1/1");
}

// ---- 4. one worker, many overlapping jobs, parallel accepts ----------------
{
  const emp = await mkUser("employer", "Ovl Employer");
  const worker = await mkUser("worker", "Ovl Worker");
  const jobs = [];
  for (let i = 0; i < 6; i++) jobs.push(await mkJob(emp, 40 + i, 8, 1)); // 8h long, staggered 1h: every pair overlaps
  const apps = [];
  for (const j of jobs) apps.push(await mkApp(j, worker));
  const results = await Promise.all(apps.map((a) => psql(`${SVC_ROLE} select public.accept_application('${emp}','${a}');`)));
  check("overlap race: 6 parallel accepts for one worker on overlapping jobs -> exactly 1 succeeds", results.reduce((n, r) => n + successes(r), 0) === 1);
  check("  worker holds exactly 1 active booking",
    (await q(`select count(*) from public.bookings where worker_id='${worker}' and status in ('confirmed','in_progress');`)) === "1");
  check("  failures are worker_double_booked, with no deadlock",
    !/deadlock/i.test(results.map((r) => r.err).join("")) && results.filter((r) => r.err.includes("worker_double_booked")).length === 5,
    results.map((r) => r.err.trim()).join(" | ").slice(0, 400));
}

// ---- 5. mixed-operation stress: deadlocks and invariants -------------------
const ALLOWED = ["application_not_found", "booking_not_found", "job_not_found", "job_full", "job_not_open", "application_not_pending",
  "worker_double_booked", "too_many_pending", "already_applied", "booking_not_cancellable", "booking_already_ended",
  "job_already_started", "job_not_cancellable", "worker_unavailable", "worker_not_available"];
for (let round = 1; round <= 2; round++) {
  const employers = [await mkUser("employer", "Stress E1"), await mkUser("employer", "Stress E2"), await mkUser("employer", "Stress E3")];
  const workers = [];
  for (let i = 0; i < 12; i++) workers.push(await mkUser("worker", `Stress W${i}`));
  const jobs = [];
  for (let i = 0; i < 9; i++) jobs.push({ id: await mkJob(employers[i % 3], 50 + (i % 4) * 3, 4, 2), employer: employers[i % 3] });
  const pick = (a) => a[Math.floor(Math.random() * a.length)];
  const workerOps = (w) => Array.from({ length: 60 }, () => {
    const r = Math.random();
    if (r < 0.5) return `select public.apply_to_job('${w}','${pick(jobs).id}',null);`;
    if (r < 0.7) return `select public.withdraw_application('${w}',(select id from public.job_applications where worker_id='${w}' and status='pending' order by random() limit 1));`;
    return `select public.cancel_booking('${w}',(select id from public.bookings where worker_id='${w}' and status='confirmed' order by random() limit 1));`;
  });
  const employerOps = (e) => Array.from({ length: 60 }, () => {
    const r = Math.random();
    const mine = jobs.filter((j) => j.employer === e);
    if (r < 0.55) return `select public.accept_application('${e}',(select id from public.job_applications where status='pending' and job_id in (select id from public.jobs where employer_id='${e}') order by random() limit 1));`;
    if (r < 0.7) return `select public.reject_application('${e}',(select id from public.job_applications where status='pending' and job_id in (select id from public.jobs where employer_id='${e}') order by random() limit 1),null);`;
    if (r < 0.95) return `select public.cancel_booking('${e}',(select id from public.bookings where employer_id='${e}' and status='confirmed' order by random() limit 1),null);`;
    return `select public.cancel_job('${e}','${pick(mine).id}',null);`;
  });
  // Owner session carrying the service_role claim, so the random-pick subselects can read tables.
  const sessions = [...workers.map((w) => psql(`${SVC_CLAIM}\n${workerOps(w).join("\n")}`)), ...employers.map((e) => psql(`${SVC_CLAIM}\n${employerOps(e).join("\n")}`))];
  const results = await Promise.all(sessions);
  const errText = results.map((r) => r.err).join("\n");
  const errors = [...errText.matchAll(/ERROR:\s+(\S+)/g)].map((m) => m[1]);
  const unexpected = [...new Set(errors.filter((e) => !ALLOWED.includes(e)))];
  const inv = await invariants();
  const stats = await q(`select (select count(*) from public.bookings where employer_id = any('{${employers.join(",")}}'::uuid[])) || ' bookings, ' ||
    (select count(*) from public.jobs where id = any('{${jobs.map((j) => j.id).join(",")}}'::uuid[]) and status='cancelled') || ' cancelled jobs';`);
  console.log(`  round ${round}: ${errors.length} expected-conflict errors, ${stats}`);
  check(`stress round ${round}: no deadlocks / serialization failures`, !/deadlock|could not serialize/i.test(errText));
  check(`stress round ${round}: no unexpected errors`, unexpected.length === 0, unexpected.join(", "));
  check(`stress round ${round}: invariants hold (counter == occupying bookings, within bounds | no overlapping active bookings)`, inv === "0|0", inv);
}

await cleanup();
console.log(`\n${checks - failures}/${checks} checks passed`);
process.exit(failures ? 1 : 0);
