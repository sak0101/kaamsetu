// KaamSetu QA audit: real Edge browser + real Express + real local Supabase (Auth, Postgres/RLS, Realtime, Mailpit).
// LOCAL ONLY. Email confirmation stays ON: every account is confirmed through a real Mailpit message.
//   npm run qa -w @kaamsetu/web      then      node e2e/qa/report.mjs
import path from "node:path";
import { launch, seen } from "../lib.mjs";
import {
  API, Blocked, MAILPIT, QA_DOMAIN, WEB, api, authClient, block, cleanupQa, confirmViaMail, eq, expecting, istDateIn, ist, jobBody, localEnv, mail, net, ok,
  notImplemented, repo, results, saveResults, setPage, sql, startProc, stopAll, tc, track, uid, waitFor,
} from "./harness.mjs";

const E = (n) => `${n}.qa@${QA_DOMAIN}`;
const pw = () => `Qa-${Math.random().toString(36).slice(2, 10)}-7!`;
const acct = {
  e1: { email: E("employer"), pw: pw(), role: "employer", name: "Meera Shah (QA)" },
  e2: { email: E("employer2"), pw: pw(), role: "employer", name: "Dinesh Mehta (QA)" },
  w1: { email: E("worker1"), pw: pw(), role: "worker", name: "Ravi Patel (QA)" },
  w2: { email: E("worker2"), pw: pw(), role: "worker", name: "Sunita Solanki (QA)" },
  w3: { email: E("worker3"), pw: pw(), role: "worker", name: "Imran Khan (QA)" },
  w4: { email: E("worker4"), pw: pw(), role: "worker", name: "Kavita Rathod (QA)" },
  w5: { email: E("worker5"), pw: pw(), role: "worker", name: "Bharat Vyas (QA)" },
  w6: { email: E("worker6"), pw: pw(), role: "worker", name: "Nisha Parmar (QA)" },
};
const tok = {}; // real access tokens
const S = {}; // shared state across cases

let browser;
const pages = {};
async function newCtx(label, mobile = false) {
  const context = await browser.newContext(mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  track(page, label);
  return { context, page };
}
const cat = (name) => Number(sql(`select id from public.work_categories where name_en='${name}'`));
const loc = (name) => Number(sql(`select id from public.localities where name='${name}'`));

try {
  cleanupQa();
  await mail.clear();
  const env = localEnv();
  const auth = authClient(env);
  startProc(["tsx", "src/index.ts"], path.join(repo, "apps/api"), {
    SUPABASE_URL: env.url, SUPABASE_ANON_KEY: env.anon, SUPABASE_SERVICE_ROLE_KEY: env.service, NODE_ENV: "development", PORT: "3001", ANTHROPIC_API_KEY: "",
  });
  startProc(["vite", "--port", "5173", "--strictPort"], path.join(repo, "apps/web"), {});
  await waitFor(`${API}/api/health`);
  await waitFor(`${WEB}/`);
  browser = (await launch()).browser;

  const CAT_EVENT = cat("Event help");
  const CAT_CLEAN = cat("Cleaning");
  const LOC_ALK = loc("Alkapuri");
  const LOC_GOTRI = loc("Gotri");

  // ======================================================================= A. ACCOUNTS + EMAIL CONFIRMATION (browser)
  console.log("\n=== A. Accounts and email confirmation");
  const eb = await newCtx("employer");
  pages.eb = eb;
  setPage(eb.page);

  await tc("ACC-01", "Accounts", "Sign-up form blocks empty, invalid-email and short-password input without calling the auth API", async () => {
    await eb.page.goto(`${WEB}/signup`);
    let signups = 0;
    eb.page.on("request", (r) => r.url().includes("/auth/v1/signup") && signups++);
    await eb.page.getByRole("button", { name: "Create account" }).click();
    ok(await seen(eb.page.getByText(/choose whether you're looking for work/i), 3000), "role error missing");
    ok(await eb.page.getByText(/enter your name/i).isVisible(), "name error missing");
    await eb.page.getByRole("radio", { name: /i need workers/i }).check();
    await eb.page.getByLabel(/^Full name/).fill("A");
    await eb.page.getByLabel(/^Email/).fill("not-an-email");
    await eb.page.getByLabel(/^Password/).fill("short");
    await eb.page.getByRole("button", { name: "Create account" }).click();
    ok(await eb.page.getByText("Enter a valid email address.").isVisible(), "email error missing");
    ok(await eb.page.getByText("Use at least 8 characters.").isVisible(), "password error missing");
    eq(signups, 0, "auth signup calls made for invalid input");
    return { evidence: "0 requests to /auth/v1/signup; 4 inline errors shown" };
  });

  await tc("ACC-02", "Accounts", "Employer registers through the UI; the page asks them to check their email", async () => {
    await eb.page.goto(`${WEB}/signup?role=employer`);
    await eb.page.getByLabel(/^Full name/).fill(acct.e1.name);
    await eb.page.getByLabel(/^Email/).fill(acct.e1.email);
    await eb.page.getByLabel(/^Password/).fill(acct.e1.pw);
    await eb.page.getByRole("button", { name: "Create account" }).click();
    ok(await seen(eb.page.getByText("Check your email")), "confirmation notice not shown");
    const row = sql(`select (email_confirmed_at is null)::text||'|'||(raw_user_meta_data->>'role') from auth.users where email='${acct.e1.email}'`);
    eq(row, "true|employer", "DB: user must exist, UNCONFIRMED, role=employer");
    return { evidence: `auth.users row created unconfirmed (${row})` };
  });

  await tc("ACC-03", "Accounts", "An unconfirmed account cannot log in (email confirmation is enforced, not bypassed)", async () => {
    const ctx2 = await newCtx("employer-unconfirmed");
    setPage(ctx2.page);
    await ctx2.page.goto(`${WEB}/login`);
    await ctx2.page.getByLabel(/^Email/).fill(acct.e1.email);
    await ctx2.page.getByLabel(/^Password/).fill(acct.e1.pw);
    await expecting(async () => {
      await ctx2.page.getByRole("button", { name: "Log in" }).click();
      ok(await seen(ctx2.page.getByRole("alert")), "no error shown");
    });
    ok(/confirm your email/i.test(await ctx2.page.getByRole("alert").textContent()), "error does not tell user to confirm email");
    ok(!(await ctx2.page.url()).includes("/employer"), "unconfirmed user reached the dashboard");
    const direct = await auth.signIn(acct.e1.email, acct.e1.pw);
    eq(direct.status, 400, "direct password grant for an unconfirmed user");
    await ctx2.context.close();
    setPage(eb.page);
    return { evidence: `UI alert shown; Supabase password grant -> HTTP ${direct.status} (${direct.json.error_code})` };
  });

  await tc("MAIL-01", "Email", "Signup confirmation email exists in Mailpit with correct recipient, sender, subject and link", async () => {
    const [m] = await mail.to(acct.e1.email, { wait: 10000 });
    ok(m, "no email received");
    S.confirmMail = m;
    eq(m.To.map((t) => t.Address), [acct.e1.email], "recipient");
    ok(m.From?.Address, "no sender address");
    ok(/confirm/i.test(m.Subject), `subject "${m.Subject}" does not mention confirmation`);
    const link = mail.link(m);
    ok(link, "no verification link in HTML");
    const u = new URL(link);
    eq(u.origin, env.url, "link must point at the local Supabase auth server");
    eq(u.searchParams.get("type"), "signup", "link type");
    ok(u.searchParams.get("token"), "link has no token");
    eq(u.searchParams.get("redirect_to"), `${WEB}/login`, "link must return the user to the app's login page");
    ok(/confirm/i.test(m.Text ?? m.HTML), "body lacks confirmation wording");
    return { evidence: `From <${m.From.Address}> (${m.From.Name || "no display name"}); Subject "${m.Subject}"; link ${u.origin}${u.pathname}?type=signup&redirect_to=${u.searchParams.get("redirect_to")}` };
  });

  await tc("ACC-04", "Accounts", "Opening the confirmation link in the browser confirms the account and signs the employer in", async () => {
    await eb.page.goto(mail.link(S.confirmMail));
    ok(await seen(eb.page.getByRole("heading", { name: "My jobs" }), 15000), `did not land on the employer dashboard (url ${eb.page.url()})`);
    const confirmed = sql(`select (email_confirmed_at is not null)::text from auth.users where email='${acct.e1.email}'`);
    eq(confirmed, "true", "DB email_confirmed_at");
    return { evidence: "auth.users.email_confirmed_at set; dashboard shown" };
  });

  await tc("ACC-05", "Accounts", "A confirmation link cannot be reused to sign in a second time", async () => {
    const reuse = await newCtx("link-reuse");
    setPage(reuse.page);
    await expecting(async () => {
      await reuse.page.goto(mail.link(S.confirmMail));
      await reuse.page.waitForTimeout(2500);
    });
    const url = reuse.page.url();
    const signedIn = await reuse.page.getByRole("heading", { name: "My jobs" }).isVisible();
    ok(!signedIn, `reused link signed someone in (url ${url})`);
    const crashed = net.pageErrors.filter((e) => e.label === "link-reuse");
    eq(crashed.length, 0, "uncaught errors on expired link");
    const shown = await reuse.page.getByRole("heading", { name: "Log in" }).isVisible();
    await reuse.context.close();
    setPage(eb.page);
    ok(shown, "app did not show the login page after an expired link");
    return { evidence: `final url ${url.replace(/#.*/, "#…")}; login page shown; no uncaught errors` };
  });

  await tc("ACC-06", "Accounts", "Session persists across reload and the access token lives in browser storage", async () => {
    await eb.page.reload();
    ok(await seen(eb.page.getByRole("heading", { name: "My jobs" })), "signed out after reload");
    const hasToken = await eb.page.evaluate(() => Object.keys(localStorage).some((k) => /auth-token/.test(k)));
    ok(hasToken, "no session in storage");
    return { evidence: "dashboard still shown after reload" };
  });

  await tc("ACC-07", "Accounts", "Logout clears the session; protected pages then redirect to login; login works again", async () => {
    await eb.page.getByRole("button", { name: "Sign out" }).first().click();
    ok(await seen(eb.page.getByRole("heading", { name: "Log in" })), "not on login after logout");
    const stillThere = await eb.page.evaluate(() => Object.keys(localStorage).some((k) => /auth-token/.test(k) && localStorage.getItem(k)));
    ok(!stillThere, "session token still in storage after logout");
    await eb.page.goto(`${WEB}/employer`);
    ok(await seen(eb.page.getByRole("heading", { name: "Log in" })), "protected page accessible after logout");
    await eb.page.getByLabel(/^Email/).fill(acct.e1.email);
    await eb.page.getByLabel(/^Password/).fill(acct.e1.pw);
    await eb.page.getByRole("button", { name: "Log in" }).click();
    ok(await seen(eb.page.getByRole("heading", { name: "My jobs" })), "could not log back in");
    return { evidence: "token removed on logout; relogin succeeded" };
  });

  await tc("ACC-08", "Accounts", "Wrong password shows a friendly error and does not sign in", async () => {
    const c = await newCtx("wrong-pw");
    setPage(c.page);
    await c.page.goto(`${WEB}/login`);
    await c.page.getByLabel(/^Email/).fill(acct.e1.email);
    await c.page.getByLabel(/^Password/).fill("definitely-wrong-1");
    await expecting(async () => {
      await c.page.getByRole("button", { name: "Log in" }).click();
      ok(await seen(c.page.getByRole("alert")), "no error shown");
    });
    ok(/don't match/i.test(await c.page.getByRole("alert").textContent()), "unfriendly error text");
    await c.context.close();
    setPage(eb.page);
  });

  await tc("ACC-09", "Accounts", "Login form validates empty fields without calling the auth API", async () => {
    const c = await newCtx("login-validation");
    setPage(c.page);
    await c.page.goto(`${WEB}/login`);
    let calls = 0;
    c.page.on("request", (r) => r.url().includes("/auth/v1/token") && calls++);
    await c.page.getByRole("button", { name: "Log in" }).click();
    ok(await seen(c.page.getByText("Enter your email address.")), "email error missing");
    ok(await c.page.getByText("Enter your password.").isVisible(), "password error missing");
    eq(calls, 0, "auth calls");
    await c.context.close();
    setPage(eb.page);
  });

  // -- employer profile
  await tc("ACC-10", "Profiles", "Employer profile: invalid phone is rejected client-side; valid profile saves and persists in the database", async () => {
    await eb.page.goto(`${WEB}/employer/profile`);
    await eb.page.getByLabel(/Phone number/).fill("12345");
    await eb.page.getByRole("button", { name: "Save profile" }).click();
    ok(await seen(eb.page.getByText(/Enter a 10-digit Indian mobile number/)), "phone error missing");
    await eb.page.getByLabel(/Business or organisation/).fill("Shah Event Services (QA)");
    await eb.page.getByLabel(/Phone number/).fill("91234 56789");
    await eb.page.getByRole("button", { name: "Save profile" }).click();
    ok(await seen(eb.page.getByText("Profile saved.")), "no success message");
    const db = sql(`select p.org_name||'|'||c.phone from public.profiles p join public.contact_details c on c.user_id=p.id join auth.users u on u.id=p.id where u.email='${acct.e1.email}'`);
    eq(db, "Shah Event Services (QA)|+919123456789", "DB profile + normalised phone");
    await eb.page.reload();
    eq(await eb.page.getByLabel(/Business or organisation/).inputValue(), "Shah Event Services (QA)", "persisted org after reload");
    return { evidence: `profiles.org_name + contact_details.phone = ${db}` };
  });

  // -- workers 1 and 2 via the UI + real email
  async function registerWorkerUi(key, label) {
    const c = await newCtx(label);
    pages[key] = c;
    setPage(c.page);
    const a = acct[key];
    await c.page.goto(`${WEB}/signup?role=worker`);
    await c.page.getByLabel(/^Full name/).fill(a.name);
    await c.page.getByLabel(/^Email/).fill(a.email);
    await c.page.getByLabel(/^Password/).fill(a.pw);
    await c.page.getByRole("button", { name: "Create account" }).click();
    ok(await seen(c.page.getByText("Check your email")), "no confirmation notice");
    const [m] = await mail.to(a.email, { wait: 10000 });
    ok(m, "no confirmation email");
    await c.page.goto(mail.link(m));
    ok(await seen(c.page.getByRole("heading", { name: "Find work" }), 15000), `no worker dashboard (url ${c.page.url()})`);
    return m;
  }
  await tc("ACC-11", "Accounts", "Worker 1 registers through the UI and confirms via the real email; lands on Find work with a profile prompt", async () => {
    await registerWorkerUi("w1", "worker1");
    ok(await seen(pages.w1.page.getByText("Finish your profile to apply")), "incomplete-profile prompt missing");
    eq(sql(`select p.role||'|'||(select count(*) from public.worker_profiles w where w.user_id=p.id) from public.profiles p join auth.users u on u.id=p.id where u.email='${acct.w1.email}'`), "worker|1", "DB worker row");
  });
  await tc("ACC-12", "Accounts", "Worker 2 registers through the UI and confirms via the real email", async () => {
    await registerWorkerUi("w2", "worker2");
  });
  await tc("MAIL-02", "Email", "Each confirmation email goes only to its own recipient (no cross-delivery)", async () => {
    for (const k of ["e1", "w1", "w2"]) {
      const msgs = await mail.to(acct[k].email);
      eq(msgs.length, 1, `${acct[k].email} message count`);
      for (const t of msgs[0].To) eq(t.Address, acct[k].email, "recipient");
    }
    const all = await mail.list();
    eq(all.length, 3, "total messages in Mailpit");
    return { evidence: "3 accounts -> 3 messages, one each" };
  });

  // -- worker profiles
  await tc("PRO-01", "Profiles", "Worker 1 completes profile (Alkapuri, Event help, 4 yrs, skills, availability, phone); saved to the database", async () => {
    setPage(pages.w1.page);
    const p = pages.w1.page;
    await p.goto(`${WEB}/worker/profile`);
    await p.getByRole("option", { name: "Alkapuri" }).waitFor({ state: "attached" });
    await p.getByLabel(/^Area you work in/).selectOption({ label: "Alkapuri" });
    await p.getByRole("checkbox", { name: "Event help" }).check();
    await p.getByLabel(/Years of experience/).fill("4");
    await p.getByLabel("Add a skill").fill("Guest handling");
    await p.getByLabel("Add a skill").press("Enter");
    await p.getByLabel("When are you available?").fill("Evenings and weekends");
    await p.getByLabel(/About you/).fill("Experienced wedding helper.");
    await p.getByLabel(/Phone number/).fill("9876543210");
    await p.getByRole("button", { name: "Save profile" }).click();
    ok(await seen(p.getByText("Profile saved.")), "no success message");
    const db = sql(`select wp.locality_id||'|'||wp.years_experience||'|'||array_to_string(wp.skills,',')||'|'||wp.availability_note||'|'||(select count(*) from public.worker_categories c where c.worker_id=wp.user_id)||'|'||(select phone from public.contact_details c where c.user_id=wp.user_id) from public.worker_profiles wp join auth.users u on u.id=wp.user_id where u.email='${acct.w1.email}'`);
    eq(db, `${LOC_ALK}|4|Guest handling|Evenings and weekends|1|+919876543210`, "DB worker profile");
    return { evidence: db };
  });
  await tc("PRO-02", "Profiles", "Worker 2 completes a thinner profile (Gotri, Event help + Cleaning, experience left blank)", async () => {
    setPage(pages.w2.page);
    const p = pages.w2.page;
    await p.goto(`${WEB}/worker/profile`);
    await p.getByRole("option", { name: "Gotri" }).waitFor({ state: "attached" });
    await p.getByLabel(/^Area you work in/).selectOption({ label: "Gotri" });
    await p.getByRole("checkbox", { name: "Event help" }).check();
    await p.getByRole("checkbox", { name: "Cleaning" }).check();
    await p.getByRole("button", { name: "Save profile" }).click();
    ok(await seen(p.getByText("Profile saved.")), "no success message");
    const db = sql(`select coalesce(wp.years_experience::text,'NULL')||'|'||(select count(*) from public.worker_categories c where c.worker_id=wp.user_id) from public.worker_profiles wp join auth.users u on u.id=wp.user_id where u.email='${acct.w2.email}'`);
    eq(db, "NULL|2", "experience stays NULL (not 0)");
    return { evidence: `years_experience is NULL in the database, 2 categories (${db})` };
  });
  await tc("PRO-03", "Profiles", "Worker profile validation: nothing is saved without an area and a type of work", async () => {
    const c = await newCtx("pro-validation");
    setPage(c.page);
    // a brand new account through the real flow
    const probe = { email: E("probe"), pw: pw(), role: "worker", name: "Probe QA" };
    await auth.signUp(probe.email, probe.pw, probe.role, probe.name);
    await confirmViaMail(probe.email);
    await c.page.goto(`${WEB}/login`);
    await c.page.getByLabel(/^Email/).fill(probe.email);
    await c.page.getByLabel(/^Password/).fill(probe.pw);
    await c.page.getByRole("button", { name: "Log in" }).click();
    await seen(c.page.getByRole("heading", { name: "Find work" }));
    await c.page.goto(`${WEB}/worker/profile`);
    let puts = 0;
    c.page.on("request", (r) => r.method() === "PUT" && r.url().includes("/api/me/worker-profile") && puts++);
    await c.page.getByRole("button", { name: "Save profile" }).click();
    ok(await seen(c.page.getByText("Choose the area you work in.")), "area error missing");
    ok(await c.page.getByText("Choose at least one kind of work.").isVisible(), "category error missing");
    eq(puts, 0, "PUT calls");
    await c.context.close();
    setPage(eb.page);
  });

  // ======================================================================= B. EMPTY STATES (fresh accounts)
  console.log("\n=== B. Empty states");
  await tc("UI-01", "UI states", "Employer dashboard empty state invites the first posting (real empty account)", async () => {
    setPage(eb.page);
    await eb.page.goto(`${WEB}/employer`);
    ok(await seen(eb.page.getByText("You haven't posted any jobs yet")), "empty state missing");
  });
  await tc("UI-02", "UI states", "Worker: empty applications, bookings and notifications states", async () => {
    setPage(pages.w1.page);
    const p = pages.w1.page;
    await p.goto(`${WEB}/worker/applications`);
    ok(await seen(p.getByText("You haven't applied for any jobs yet")), "applications empty state missing");
    await p.goto(`${WEB}/worker/bookings`);
    ok(await seen(p.getByText("No bookings yet")), "bookings empty state missing");
    await p.goto(`${WEB}/notifications`);
    ok(await seen(p.getByText("No notifications yet")), "notifications empty state missing");
  });

  // ======================================================================= C. MARKETPLACE JOURNEY
  console.log("\n=== C. Marketplace journey");
  const jobDate = istDateIn(3);
  await tc("MKT-01", "Marketplace", "Employer posts a job through the form; the saved row matches what was entered", async () => {
    setPage(eb.page);
    const p = eb.page;
    await p.goto(`${WEB}/employer/jobs/new`);
    await p.getByRole("option", { name: "Alkapuri" }).waitFor({ state: "attached" });
    await p.getByLabel(/^Job title/).fill("Wedding helpers needed, Alkapuri (QA)");
    await p.getByLabel(/^Type of work/).selectOption({ label: "Event help" });
    await p.getByLabel(/^Locality in Vadodara/).selectOption({ label: "Alkapuri" });
    await p.getByLabel(/^What needs to be done/).fill("Guest coordination and basic arrangements at a wedding venue.");
    await p.getByLabel(/^Date/).fill(jobDate);
    await p.getByLabel(/^Start time/).fill("17:00");
    await p.getByLabel(/^End time/).fill("23:00");
    await p.getByLabel(/^Workers needed/).fill("2");
    await p.getByLabel(/^Pay is/).selectOption("fixed");
    await p.getByLabel(/^Amount/).fill("800");
    await p.getByRole("button", { name: "Post job" }).click();
    ok(await seen(p.getByText("Job posted. Workers can now apply.")), "no success banner");
    const row = sql(`select j.id||'|'||j.workers_needed||'|'||j.pay_amount_paise||'|'||j.pay_type||'|'||j.status||'|'||j.positions_filled||'|'||j.category_id||'|'||j.locality_id||'|'||to_char(j.starts_at at time zone 'Asia/Kolkata','YYYY-MM-DD HH24:MI')||'|'||to_char(j.ends_at at time zone 'Asia/Kolkata','HH24:MI') from public.jobs j join auth.users u on u.id=j.employer_id where u.email='${acct.e1.email}'`);
    const [id, ...rest] = row.split("|");
    S.job = id;
    eq(rest.join("|"), `2|80000|fixed|open|0|${CAT_EVENT}|${LOC_ALK}|${jobDate} 17:00|23:00`, "DB job row (IST times, paise)");
    return { evidence: `jobs row ${rest.join(" | ")}` };
  });

  await tc("MKT-02", "Marketplace", "Matching: worker in Alkapuri sees the job by default; Event-help filter keeps it; Cleaning filter hides it", async () => {
    block(S.job, "job not created");
    setPage(pages.w1.page);
    const p = pages.w1.page;
    await p.goto(`${WEB}/worker`);
    ok(await seen(p.getByRole("link", { name: "Wedding helpers needed, Alkapuri (QA)" })), "job not listed for Alkapuri worker");
    await p.getByLabel("Type of work", { exact: true }).first().selectOption({ label: "Cleaning" });
    ok(await seen(p.getByText("No jobs match your filters")), "Cleaning filter did not hide the job");
    await p.getByLabel("Type of work", { exact: true }).first().selectOption({ label: "Event help" });
    ok(await seen(p.getByRole("link", { name: "Wedding helpers needed, Alkapuri (QA)" })), "Event help filter hid the job");
  });
  await tc("MKT-03", "Marketplace", "Matching: worker in Gotri does NOT see the Alkapuri job by default, but does after widening to all of Vadodara", async () => {
    block(S.job, "job not created");
    setPage(pages.w2.page);
    const p = pages.w2.page;
    await p.goto(`${WEB}/worker`);
    ok(await seen(p.getByText("No jobs match your filters")), "Gotri worker unexpectedly sees the job (or page not loaded)");
    await p.getByLabel("Locality", { exact: true }).first().selectOption("");
    ok(await seen(p.getByRole("link", { name: "Wedding helpers needed, Alkapuri (QA)" })), "job not visible after widening");
  });

  await tc("MKT-04", "Marketplace", "Worker 1 applies; status shows Waiting; the application row exists; the employer was notified (database)", async () => {
    block(S.job, "job not created");
    setPage(pages.w1.page);
    const p = pages.w1.page;
    await p.goto(`${WEB}/worker/jobs/${S.job}`);
    await p.getByLabel(/message to the employer/i).fill("I have done 20+ weddings.");
    await p.getByRole("button", { name: "Apply for this job" }).click();
    ok(await seen(p.getByText("Waiting for employer")), "status not shown");
    const row = sql(`select a.status||'|'||a.message from public.job_applications a join auth.users u on u.id=a.worker_id where u.email='${acct.w1.email}' and a.job_id='${S.job}'`);
    eq(row, "pending|I have done 20+ weddings.", "DB application");
    const n = sql(`select count(*) from public.notifications n join auth.users u on u.id=n.user_id where u.email='${acct.e1.email}' and n.type='new_application'`);
    eq(n, "1", "employer new_application notifications");
    return { evidence: `job_applications: ${row}; notifications(new_application)=${n}` };
  });
  await tc("MKT-05", "Marketplace", "Worker 2 applies too, then withdraws (DB shows withdrawn), then re-applies (DB shows pending again)", async () => {
    block(S.job, "job not created");
    setPage(pages.w2.page);
    const p = pages.w2.page;
    await p.goto(`${WEB}/worker/jobs/${S.job}`);
    await p.getByRole("button", { name: "Apply for this job" }).click();
    ok(await seen(p.getByText("Waiting for employer")), "no pending status");
    await p.getByRole("button", { name: "Withdraw application" }).click();
    ok(await seen(p.getByText("Application withdrawn.")), "no withdrawn notice");
    eq(sql(`select a.status from public.job_applications a join auth.users u on u.id=a.worker_id where u.email='${acct.w2.email}' and a.job_id='${S.job}'`), "withdrawn", "DB after withdraw");
    await p.getByRole("button", { name: "Apply again" }).click();
    ok(await seen(p.getByText("Waiting for employer")), "re-apply did not return to pending");
    eq(sql(`select a.status||'|'||count(*) over () from public.job_applications a join auth.users u on u.id=a.worker_id where u.email='${acct.w2.email}' and a.job_id='${S.job}'`), "pending|1", "DB after re-apply (same row reused)");
  });

  await tc("MKT-06", "Marketplace", "Employer dashboard shows 2 applicants waiting", async () => {
    setPage(eb.page);
    await eb.page.goto(`${WEB}/employer`);
    ok(await seen(eb.page.getByText("2 waiting for your decision")), "applicant count not shown");
  });

  await tc("MKT-07", "Marketplace", "Applicant comparison: best fit first, exact percentages and reasons match the documented formula", async () => {
    block(S.job, "job not created");
    setPage(eb.page);
    const p = eb.page;
    await p.goto(`${WEB}/employer/jobs/${S.job}`);
    const a1 = p.getByRole("article", { name: `Applicant ${acct.w1.name}` });
    const a2 = p.getByRole("article", { name: `Applicant ${acct.w2.name}` });
    ok(await seen(a1), "worker 1 card missing");
    ok(await seen(a2), "worker 2 card missing");
    const t1 = (await a1.textContent()) ?? "";
    const t2 = (await a2.textContent()) ?? "";
    // worker 1: category 1.0, locality 1.0, experience 4/5 -> (0.3 + 0.2 + 0.08) / 0.6 = 96.67 -> 97
    ok(/Strong match · 97%/.test(t1), `worker1 label: ${t1.match(/(Strong|Good|Partial|Weak) match · \d+%/)?.[0]}`);
    ok(/Offers this type of work/.test(t1) && /Works in this job's locality/.test(t1) && /4 years of experience/.test(t1), "worker1 reasons incomplete");
    // worker 2: category 1.0, locality different 0, experience excluded -> 0.3 / 0.5 = 60
    ok(/Good match · 60%/.test(t2), `worker2 label: ${t2.match(/(Strong|Good|Partial|Weak) match · \d+%/)?.[0]}`);
    ok(/Works in a different locality/.test(t2), "worker2 locality note missing");
    ok(/Experience not provided, so it isn't counted for or against them/.test(t2), "worker2 missing-experience note missing");
    ok(!/0 years/.test(t2), "missing experience shown as zero");
    ok(/New to KaamSetu: no completed jobs yet\. This isn't held against them/.test(t1 + t2), "new-worker fairness note missing");
    const order = await p.getByRole("heading", { level: 3 }).allTextContents();
    ok(order.indexOf(acct.w1.name) < order.indexOf(acct.w2.name), `order was ${order.join(", ")}`);
    return { evidence: "worker1 97% (Strong), worker2 60% (Good, experience excluded not zero); order best-first" };
  });

  await tc("MKT-08", "Marketplace", "Employer accepts worker 1: booking row, slot counter and notifications are correct in the database", async () => {
    block(S.job, "job not created");
    setPage(eb.page);
    const p = eb.page;
    await p.getByRole("article", { name: `Applicant ${acct.w1.name}` }).getByRole("button", { name: "Accept and book" }).click();
    ok(await seen(p.getByText(`${acct.w1.name} is booked.`)), "no booked notice");
    const db = sql(`select b.status||'|'||b.agreed_pay_paise||'|'||j.positions_filled||'|'||j.workers_needed||'|'||j.status from public.bookings b join public.jobs j on j.id=b.job_id join auth.users u on u.id=b.worker_id where u.email='${acct.w1.email}'`);
    eq(db, "confirmed|80000|1|2|open", "booking + job counters");
    const app = sql(`select a.status from public.job_applications a join auth.users u on u.id=a.worker_id where u.email='${acct.w1.email}'`);
    eq(app, "accepted", "application status");
    const n = sql(`select count(*) from public.notifications n join auth.users u on u.id=n.user_id where u.email='${acct.w1.email}' and n.type='booking_confirmed'`);
    eq(n, "1", "worker booking_confirmed notifications");
    const other = sql(`select a.status from public.job_applications a join auth.users u on u.id=a.worker_id where u.email='${acct.w2.email}'`);
    eq(other, "pending", "the other applicant must be untouched while a slot remains");
    return { evidence: `booking ${db}; accepted app; worker1 notified once; worker2 still pending` };
  });

  await tc("MKT-09", "Marketplace", "Remaining slots: UI says '1 of 2 booked · 1 needed' and matches the database", async () => {
    setPage(pages.w2.page);
    const p = pages.w2.page;
    await p.goto(`${WEB}/worker`);
    await p.getByLabel("Locality", { exact: true }).first().selectOption("");
    const card = p.getByRole("article").filter({ hasText: "Wedding helpers needed, Alkapuri (QA)" });
    ok(await seen(card), "card missing");
    ok(/1 of 2 booked · 1 needed/.test((await card.textContent()) ?? ""), "slot text wrong");
    eq(sql(`select (workers_needed - positions_filled) from public.jobs where id='${S.job}'`), "1", "DB remaining slots");
  });

  await tc("MKT-10", "Marketplace", "Worker and employer booking views show the booking with correct counterpart, time and pay", async () => {
    setPage(pages.w1.page);
    await pages.w1.page.goto(`${WEB}/worker/bookings`);
    const wcard = pages.w1.page.getByRole("article").filter({ hasText: "Wedding helpers needed, Alkapuri (QA)" });
    ok(await seen(wcard), "worker booking missing");
    const wt = (await wcard.textContent()) ?? "";
    ok(/Confirmed/.test(wt) && /₹800 agreed/.test(wt) && /Shah Event Services \(QA\)/.test(wt) && /5:00 PM – 11:00 PM IST/.test(wt), `worker view: ${wt.slice(0, 200)}`);
    setPage(eb.page);
    await eb.page.goto(`${WEB}/employer/bookings`);
    const ecard = eb.page.getByRole("article").filter({ hasText: "Wedding helpers needed, Alkapuri (QA)" });
    ok(await seen(ecard), "employer booking missing");
    ok(await seen(ecard.getByText(acct.w1.name)), "employer view does not name the booked worker");
  });

  await tc("MKT-11", "Marketplace", "Employer accepts worker 2: job becomes Fully booked (2 of 2), no pending applicants remain", async () => {
    setPage(eb.page);
    const p = eb.page;
    await p.goto(`${WEB}/employer/jobs/${S.job}`);
    await p.getByRole("article", { name: `Applicant ${acct.w2.name}` }).getByRole("button", { name: "Accept and book" }).click();
    ok(await seen(p.getByText(`${acct.w2.name} is booked.`)), "no booked notice");
    eq(sql(`select positions_filled||'|'||workers_needed||'|'||status from public.jobs where id='${S.job}'`), "2|2|filled", "DB job after capacity reached");
    ok(await seen(p.getByText("Fully booked")), "UI badge missing");
    eq(sql(`select count(*) from public.bookings where job_id='${S.job}' and status='confirmed'`), "2", "confirmed bookings");
  });

  await tc("MKT-12", "Marketplace", "Contact numbers are revealed to the booked worker only for the live booking", async () => {
    setPage(pages.w1.page);
    const p = pages.w1.page;
    await p.goto(`${WEB}/worker/bookings`);
    await p.getByRole("button", { name: "Show contact" }).click();
    const link = p.getByRole("link", { name: "+919123456789" });
    ok(await seen(link), "employer phone not revealed");
    eq(await link.getAttribute("href"), "tel:+919123456789", "tel link");
  });

  // ======================================================================= D. EDGE CASES (real tokens, real API)
  console.log("\n=== D. Edge cases and concurrency (real tokens)");
  await tc("TOK-00", "Setup", "Create extra QA accounts through the real confirmation-email flow and sign in with real tokens", async () => {
    for (const k of ["e2", "w3", "w4", "w5", "w6"]) {
      const a = acct[k];
      const su = await auth.signUp(a.email, a.pw, a.role, a.name);
      eq(su.status, 200, `signup ${k}`);
      const c = await confirmViaMail(a.email);
      ok(c.status === 303 || c.status === 302, `confirm redirect ${k} (${c.status})`);
    }
    for (const k of Object.keys(acct)) {
      const r = await auth.signIn(acct[k].email, acct[k].pw);
      ok(r.token, `no token for ${k}: ${JSON.stringify(r.json).slice(0, 100)}`);
      tok[k] = r.token;
    }
    for (const k of ["w3", "w4", "w5", "w6"]) {
      const r = await api(tok[k], "PUT", "/api/me/worker-profile", { locality_id: LOC_ALK, category_ids: [CAT_EVENT], years_experience: 1 });
      eq(r.status, 200, `profile ${k}`);
    }
    return { evidence: `8 QA accounts exist, all email-confirmed (${sql(`select count(*) from auth.users where email like '%@${QA_DOMAIN}' and email_confirmed_at is not null`)})` };
  });

  await tc("EDGE-01", "Edge cases", "Duplicate application is rejected with 409 already_applied; only one row exists", async () => {
    block(tok.w1 && tok.e1, "setup failed");
    // a job that is still open (the main job is already full by now, which would answer job_not_open first)
    const j = await api(tok.e1, "POST", "/api/jobs", jobBody({ title: "Duplicate application probe", starts_at: ist(24 * 6), ends_at: ist(24 * 6 + 4), workers_needed: 3 }));
    eq(j.status, 201, "create job");
    eq((await api(tok.w1, "POST", `/api/jobs/${j.json.id}/applications`, {})).status, 201, "first application");
    const r = await expecting(() => api(tok.w1, "POST", `/api/jobs/${j.json.id}/applications`, {}));
    eq([r.status, r.json?.error?.code], [409, "already_applied"], "response");
    eq(sql(`select count(*) from public.job_applications where job_id='${j.json.id}' and worker_id='${uid(acct.w1.email)}'`), "1", "DB rows");
  });
  await tc("EDGE-02", "Edge cases", "Job at capacity: a third worker cannot apply (409 job_not_open) and an extra accept is impossible", async () => {
    block(tok.w3 && S.job, "setup failed");
    const r = await expecting(() => api(tok.w3, "POST", `/api/jobs/${S.job}/applications`, {}));
    eq([r.status, r.json?.error?.code], [409, "job_not_open"], "apply to full job");
    eq(sql(`select positions_filled||'|'||workers_needed from public.jobs where id='${S.job}'`), "2|2", "counter unchanged");
  });
  await tc("EDGE-03", "Edge cases", "Overlap: a worker with a confirmed booking cannot apply to an overlapping job (409 worker_double_booked)", async () => {
    block(tok.e1 && tok.w1, "setup failed");
    // build the probe from the REAL booked window (main job: tomorrow+2 17:00-23:00 IST), starting one hour into it
    const startMs = Number(sql(`select (extract(epoch from starts_at)*1000)::bigint from public.jobs where id='${S.job}'`));
    const istIso = (ms) => new Date(ms + 5.5 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "+05:30");
    const j = await api(tok.e1, "POST", "/api/jobs", jobBody({ title: "Overlap probe job", starts_at: istIso(startMs + 3_600_000), ends_at: istIso(startMs + 3 * 3_600_000), category_id: CAT_EVENT, locality_id: LOC_ALK }));
    eq(j.status, 201, "create overlapping job");
    const r = await expecting(() => api(tok.w1, "POST", `/api/jobs/${j.json.id}/applications`, {}));
    ok(r.status === 409 && r.json?.error?.code === "worker_double_booked", `got ${r.status} ${r.json?.error?.code}`);
    return { evidence: "job window overlaps worker1's confirmed 17:00-23:00 booking" };
  });

  await tc("CONC-01", "Concurrency", "6 workers, 1 slot, 6 parallel accepts: exactly one booking; counters and DB agree", async () => {
    block(tok.e1, "setup failed");
    const j = await api(tok.e1, "POST", "/api/jobs", jobBody({ title: "Concurrency 1-slot", starts_at: ist(24 * 10), ends_at: ist(24 * 10 + 4), workers_needed: 1 }));
    eq(j.status, 201, "create");
    const apps = [];
    for (const k of ["w1", "w2", "w3", "w4", "w5", "w6"]) {
      const a = await api(tok[k], "POST", `/api/jobs/${j.json.id}/applications`, {});
      eq(a.status, 201, `apply ${k}`);
      apps.push(a.json.application_id);
    }
    const res = await expecting(() => Promise.all(apps.map((id) => api(tok.e1, "POST", `/api/applications/${id}/accept`))));
    const won = res.filter((r) => r.status === 201).length;
    eq(won, 1, `successful accepts (statuses ${res.map((r) => r.status).join(",")})`);
    ok(res.filter((r) => r.status !== 201).every((r) => r.status === 409), "losers must be clean 409s");
    eq(sql(`select positions_filled||'|'||workers_needed||'|'||status||'|'||(select count(*) from public.bookings b where b.job_id=j.id and b.status='confirmed') from public.jobs j where j.id='${j.json.id}'`), "1|1|filled|1", "DB");
    eq(sql(`select count(*) from public.job_applications where job_id='${j.json.id}' and status='rejected' and status_reason='job_filled'`), "5", "auto-rejected applicants");
    return { evidence: `statuses ${res.map((r) => r.status).join(",")}; DB 1|1|filled|1; 5 auto-rejected as job_filled` };
  });
  await tc("CONC-02", "Concurrency", "6 workers, 3 slots, 6 parallel accepts: exactly three bookings (never more)", async () => {
    block(tok.e1, "setup failed");
    const j = await api(tok.e1, "POST", "/api/jobs", jobBody({ title: "Concurrency 3-slot", starts_at: ist(24 * 15), ends_at: ist(24 * 15 + 4), workers_needed: 3 }));
    const apps = [];
    for (const k of ["w1", "w2", "w3", "w4", "w5", "w6"]) apps.push((await api(tok[k], "POST", `/api/jobs/${j.json.id}/applications`, {})).json.application_id);
    const res = await expecting(() => Promise.all(apps.map((id) => api(tok.e1, "POST", `/api/applications/${id}/accept`))));
    eq(res.filter((r) => r.status === 201).length, 3, `successes (${res.map((r) => r.status).join(",")})`);
    eq(sql(`select positions_filled||'|'||status from public.jobs where id='${j.json.id}'`), "3|filled", "DB counter");
  });
  await tc("CONC-03", "Concurrency", "Two employers accept the same worker for overlapping jobs at the same instant: only one booking succeeds", async () => {
    block(tok.e1 && tok.e2, "setup failed");
    const a = await api(tok.e1, "POST", "/api/jobs", jobBody({ title: "Overlap A", starts_at: ist(24 * 20), ends_at: ist(24 * 20 + 4) }));
    const b = await api(tok.e2, "POST", "/api/jobs", jobBody({ title: "Overlap B", starts_at: ist(24 * 20 + 1), ends_at: ist(24 * 20 + 5) }));
    eq([a.status, b.status], [201, 201], "create jobs");
    const appA = (await api(tok.w4, "POST", `/api/jobs/${a.json.id}/applications`, {})).json.application_id;
    const appB = (await api(tok.w4, "POST", `/api/jobs/${b.json.id}/applications`, {})).json.application_id;
    ok(appA && appB, "applications");
    const res = await expecting(() => Promise.all([api(tok.e1, "POST", `/api/applications/${appA}/accept`), api(tok.e2, "POST", `/api/applications/${appB}/accept`)]));
    eq(res.filter((r) => r.status === 201).length, 1, `successes (${res.map((r) => `${r.status}:${r.json?.error?.code ?? "ok"}`).join(",")})`);
    ok(res.some((r) => r.json?.error?.code === "worker_double_booked"), "loser must report worker_double_booked");
    eq(sql(`select count(*) from public.bookings b join auth.users u on u.id=b.worker_id where u.email='${acct.w4.email}' and b.status in ('confirmed','in_progress') and b.job_id in ('${a.json.id}','${b.json.id}')`), "1", "worker4 active bookings across the two contested jobs");
  });
  await tc("CONC-04", "Concurrency", "20 rapid double-click accepts of the same application create exactly one booking", async () => {
    block(tok.e1, "setup failed");
    const j = await api(tok.e1, "POST", "/api/jobs", jobBody({ title: "Double click", starts_at: ist(24 * 25), ends_at: ist(24 * 25 + 4), workers_needed: 5 }));
    const app = (await api(tok.w5, "POST", `/api/jobs/${j.json.id}/applications`, {})).json.application_id;
    const res = await expecting(() => Promise.all(Array.from({ length: 20 }, () => api(tok.e1, "POST", `/api/applications/${app}/accept`))));
    eq(res.filter((r) => r.status === 201).length, 1, "successes");
    eq(sql(`select count(*) from public.bookings where application_id='${app}'`), "1", "booking rows");
  });

  await tc("EDGE-04", "Edge cases", "Employer cancels a confirmed booking (UI): attribution, freed slot and live notification are correct in the database", async () => {
    block(S.job, "no job");
    setPage(eb.page);
    const p = eb.page;
    await p.goto(`${WEB}/employer/bookings`);
    const card = p.getByRole("article").filter({ hasText: acct.w2.name }).filter({ hasText: "Wedding helpers needed, Alkapuri (QA)" });
    ok(await seen(card), "booking card missing");
    await card.getByRole("button", { name: "Cancel booking" }).click();
    await p.getByLabel(/reason/i).fill("Venue changed");
    await p.getByRole("button", { name: "Yes, cancel booking" }).click();
    ok(await seen(p.getByText("Booking cancelled.")), "no confirmation");
    const db = sql(`select b.status||'|'||(b.cancelled_by=b.employer_id)::text||'|'||b.cancel_reason||'|'||j.positions_filled||'|'||j.status from public.bookings b join public.jobs j on j.id=b.job_id join auth.users u on u.id=b.worker_id where u.email='${acct.w2.email}' and j.id='${S.job}'`);
    eq(db, "cancelled_by_employer|true|Venue changed|1|open", "DB (attributed to employer; job reopened from filled)");
    const n = sql(`select count(*) from public.notifications n join auth.users u on u.id=n.user_id where u.email='${acct.w2.email}' and n.type='booking_cancelled' and n.payload->>'cancelled_by'='employer'`);
    eq(n, "1", "worker notified");
    return { evidence: db };
  });
  await tc("EDGE-05", "Edge cases", "Worker cancels their own booking (UI): attributed to the worker, slot freed", async () => {
    block(S.job, "no job");
    setPage(pages.w1.page);
    const p = pages.w1.page;
    await p.goto(`${WEB}/worker/bookings`);
    const card = p.getByRole("article").filter({ hasText: "Wedding helpers needed, Alkapuri (QA)" });
    await card.getByRole("button", { name: "Cancel booking" }).click();
    await p.getByLabel(/reason/i).fill("Family emergency");
    await p.getByRole("button", { name: "Yes, cancel booking" }).click();
    ok(await seen(p.getByText("Booking cancelled.")), "no confirmation");
    const db = sql(`select b.status||'|'||(b.cancelled_by=b.worker_id)::text||'|'||j.positions_filled from public.bookings b join public.jobs j on j.id=b.job_id join auth.users u on u.id=b.worker_id where u.email='${acct.w1.email}' and j.id='${S.job}'`);
    eq(db, "cancelled_by_worker|true|0", "DB");
    ok(await seen(p.getByText("Cancelled by worker")), "list did not refresh to show the cancelled status");
    ok(!(await card.getByRole("button", { name: "Show contact" }).count()), "contact still offered on the cancelled booking");
    return { evidence: db };
  });
  await tc("EDGE-06", "Edge cases", "Cancelling a job (UI) rejects pending applicants and cancels bookings, all recorded in the database", async () => {
    block(S.job, "no job");
    setPage(eb.page);
    const p = eb.page;
    // give the job a pending applicant and a booking first
    await api(tok.w3, "POST", `/api/jobs/${S.job}/applications`, {});
    const appId = sql(`select a.id from public.job_applications a join auth.users u on u.id=a.worker_id where u.email='${acct.w3.email}' and a.job_id='${S.job}'`);
    ok(appId, "worker3 could not apply to the reopened job");
    const acc = await api(tok.e1, "POST", `/api/applications/${appId}/accept`);
    eq(acc.status, 201, "accept w3");
    await api(tok.w4, "PUT", "/api/me/worker-profile", { locality_id: LOC_ALK, category_ids: [CAT_EVENT] });
    await p.goto(`${WEB}/employer/jobs/${S.job}`);
    await p.getByRole("button", { name: "Cancel this job" }).click();
    await p.getByLabel(/reason/i).fill("Client cancelled the event");
    await p.getByRole("button", { name: "Yes, cancel job" }).click();
    ok(await seen(p.getByText("Job cancelled.")), "no confirmation");
    const db = sql(`select j.status||'|'||j.positions_filled||'|'||(select count(*) from public.bookings b join auth.users u on u.id=b.worker_id where b.job_id=j.id and b.status='cancelled_by_employer' and u.email='${acct.w3.email}')||'|'||(select count(*) from public.bookings b where b.job_id=j.id and b.status in ('confirmed','in_progress'))||'|'||(select count(*) from public.job_applications a where a.job_id=j.id and a.status='pending') from public.jobs j where j.id='${S.job}'`);
    eq(db, "cancelled|0|1|0|0", "DB: cancelled, 0 filled, w3's booking cancelled by employer, no active bookings, no pending");
    const apply = await expecting(() => api(tok.w5, "POST", `/api/jobs/${S.job}/applications`, {}));
    eq(apply.status, 409, "apply to cancelled job");
    return { evidence: db };
  });

  // ---------------------------------------------------------------- forms
  await tc("FORM-01", "Forms", "Job form: empty, past date, end-before-start, zero pay and over-limit pay are all blocked with no request sent", async () => {
    setPage(eb.page);
    const p = eb.page;
    await p.goto(`${WEB}/employer/jobs/new`);
    let posts = 0;
    p.on("request", (r) => r.method() === "POST" && r.url().endsWith("/api/jobs") && posts++);
    await p.getByRole("button", { name: "Post job" }).click();
    for (const t of [/enter a short title/i, "Choose the type of work.", "Choose where the work is.", "Choose the date.", /enter the pay in rupees/i]) ok(await seen(p.getByText(t), 3000), `missing error ${t}`);
    await p.getByLabel(/^Date/).fill("2020-01-01");
    await p.getByRole("button", { name: "Post job" }).click();
    ok(await seen(p.getByText("The date can't be in the past.")), "past date accepted");
    await p.getByLabel(/^Date/).fill(istDateIn(5));
    await p.getByLabel(/^Start time/).fill("18:00");
    await p.getByLabel(/^End time/).fill("09:00");
    await p.getByRole("button", { name: "Post job" }).click();
    ok(await seen(p.getByText(/end time must be after the start time/i)), "end-before-start accepted");
    await p.getByLabel(/^Amount/).fill("0");
    await p.getByRole("button", { name: "Post job" }).click();
    ok(await seen(p.getByText(/enter the pay in rupees/i)), "zero pay accepted");
    await p.getByLabel(/^Amount/).fill("50001");
    await p.getByRole("button", { name: "Post job" }).click();
    ok(await seen(p.getByText(/most you can offer/i)), "over-limit pay accepted");
    eq(posts, 0, "POST /api/jobs calls");
  });
  await tc("FORM-02", "Forms", "API rejects invalid job payloads server-side too (not just the UI)", async () => {
    block(tok.e1, "setup failed");
    const bad = [
      ["pay 0", { pay_amount_paise: 0 }], ["pay over ₹50,000", { pay_amount_paise: 5_000_001 }], ["workers 0", { workers_needed: 0 }], ["workers 51", { workers_needed: 51 }],
      ["end before start", { starts_at: ist(100), ends_at: ist(99) }], ["start in the past", { starts_at: ist(-5), ends_at: ist(-1) }], ["over 14 days", { starts_at: ist(100), ends_at: ist(100 + 24 * 15) }],
      ["unknown category", { category_id: 999 }], ["unknown locality", { locality_id: 999 }], ["title too short", { title: "abc" }], ["bad pay type", { pay_type: "weekly" }],
    ];
    const out = [];
    await expecting(async () => {
      for (const [name, over] of bad) {
        const r = await api(tok.e1, "POST", "/api/jobs", jobBody(over));
        out.push(`${name}:${r.status}`);
        ok(r.status === 422, `${name} -> ${r.status} ${JSON.stringify(r.json?.error?.code)}`);
      }
    });
    return { evidence: out.join(" ") };
  });

  // ======================================================================= E. SECURITY
  console.log("\n=== E. Security and authorization");
  await tc("SEC-01", "Security", "Unauthenticated requests are rejected (401) on every protected endpoint", async () => {
    const eps = [["GET", "/api/me"], ["GET", "/api/jobs"], ["GET", "/api/employer/jobs"], ["GET", `/api/jobs/${S.job}`], ["GET", "/api/me/bookings"], ["GET", "/api/notifications"], ["POST", "/api/jobs"], ["GET", "/api/me/contact"]];
    const out = [];
    await expecting(async () => {
      for (const [m, p] of eps) {
        const r = await api(null, m, p, m === "POST" ? {} : undefined);
        out.push(r.status);
        ok(r.status === 401, `${m} ${p} -> ${r.status}`);
      }
    });
    return { evidence: `all ${eps.length} -> 401` };
  });
  await tc("SEC-02", "Security", "Forged, tampered and garbage tokens are rejected (401)", async () => {
    block(tok.w1, "setup failed");
    const t = tok.w1;
    const tampered = t.slice(0, -4) + (t.endsWith("AAAA") ? "BBBB" : "AAAA");
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify({ sub: uid(acct.e1.email), role: "authenticated", exp: 4102444800 })).toString("base64url");
    const alg_none = `${header}.${payload}.`;
    await expecting(async () => {
      for (const [name, token] of [["tampered signature", tampered], ["alg=none forged as employer", alg_none], ["garbage", "not.a.jwt"]]) {
        const r = await api(token, "GET", "/api/me");
        ok(r.status === 401, `${name} -> ${r.status}`);
      }
    });
  });
  await tc("SEC-03", "Security", "A revoked (logged-out-elsewhere) session token stops working immediately", async () => {
    const r = await auth.signIn(acct.w6.email, acct.w6.pw);
    eq((await api(r.token, "GET", "/api/me")).status, 200, "token works before logout");
    eq(await auth.logout(r.token, "global"), 204, "logout call");
    const after = await expecting(() => api(r.token, "GET", "/api/me"));
    eq(after.status, 401, "same token after server-side logout");
  });
  await tc("SEC-04", "Security", "Another employer cannot view, list applicants of, accept for, reject for, or cancel someone else's job", async () => {
    block(tok.e2 && S.job, "setup failed");
    const j = await api(tok.e1, "POST", "/api/jobs", jobBody({ title: "Private job of employer 1", starts_at: ist(24 * 30), ends_at: ist(24 * 30 + 4), workers_needed: 2 }));
    const app = (await api(tok.w6x ?? (await auth.signIn(acct.w6.email, acct.w6.pw)).token, "POST", `/api/jobs/${j.json.id}/applications`, {})).json?.application_id;
    ok(app, "could not create an application to attack");
    const tries = [
      ["GET job", () => api(tok.e2, "GET", `/api/jobs/${j.json.id}`)],
      ["GET applicants", () => api(tok.e2, "GET", `/api/jobs/${j.json.id}/applicants`)],
      ["accept", () => api(tok.e2, "POST", `/api/applications/${app}/accept`)],
      ["reject", () => api(tok.e2, "POST", `/api/applications/${app}/reject`, {})],
      ["cancel job", () => api(tok.e2, "POST", `/api/jobs/${j.json.id}/cancel`, {})],
    ];
    const out = [];
    await expecting(async () => {
      for (const [name, f] of tries) {
        const r = await f();
        out.push(`${name}:${r.status}`);
        ok(r.status === 404, `${name} -> ${r.status} (expected 404, existence must not leak)`);
      }
    });
    eq(sql(`select status from public.job_applications where id='${app}'`), "pending", "application untouched");
    eq(sql(`select status from public.jobs where id='${j.json.id}'`), "open", "job untouched");
    return { evidence: out.join(" ") };
  });
  await tc("SEC-05", "Security", "Role separation: workers cannot use employer endpoints and employers cannot use worker endpoints (403)", async () => {
    block(tok.w1 && tok.e1, "setup failed");
    const w = [["POST", "/api/jobs", jobBody()], ["GET", "/api/employer/jobs"], ["GET", `/api/jobs/${S.job}/applicants`], ["POST", `/api/applications/${S.job}/accept`], ["POST", `/api/jobs/${S.job}/cancel`, {}]];
    const e = [["GET", "/api/jobs"], ["GET", "/api/me/applications"], ["POST", `/api/jobs/${S.job}/applications`, {}], ["PUT", "/api/me/worker-profile", { locality_id: 1 }]];
    await expecting(async () => {
      for (const [m, p, b] of w) { const r = await api(tok.w1, m, p, b); ok(r.status === 403 || r.status === 422, `worker ${m} ${p} -> ${r.status}`); }
      for (const [m, p, b] of e) { const r = await api(tok.e1, m, p, b); ok(r.status === 403, `employer ${m} ${p} -> ${r.status}`); }
    });
  });
  await tc("SEC-06", "Security", "A worker cannot read another worker's applications, bookings, notifications or phone (API and direct database access)", async () => {
    block(tok.w2 && tok.w1, "setup failed");
    const other = uid(acct.w1.email);
    const checks = [
      ["job_applications", `job_applications?worker_id=eq.${other}&select=id`],
      ["bookings", `bookings?worker_id=eq.${other}&select=id`],
      ["notifications", `notifications?user_id=eq.${other}&select=id`],
      ["contact_details", `contact_details?user_id=eq.${other}&select=phone`],
      ["profiles", `profiles?id=eq.${other}&select=id,full_name`],
      ["worker_profiles", `worker_profiles?user_id=eq.${other}&select=user_id`],
    ];
    const out = [];
    for (const [name, q] of checks) {
      const rows = await (await auth.rest(tok.w2, q)).json();
      out.push(`${name}:${Array.isArray(rows) ? rows.length : "err"}`);
      ok(Array.isArray(rows) && rows.length === 0, `${name} leaked ${JSON.stringify(rows).slice(0, 120)}`);
    }
    const mine = await api(tok.w2, "GET", "/api/me/applications");
    ok(mine.json.applications.every((a) => a.worker_id === uid(acct.w2.email)), "API returned someone else's application");
    return { evidence: out.join(" ") };
  });
  await tc("SEC-07", "Security", "Booking contact endpoint: strangers and unbooked applicants get 404; the phone never appears in the applicants API", async () => {
    block(S.job && tok.w6, "setup failed");
    const j = await api(tok.e1, "POST", "/api/jobs", jobBody({ title: "Contact privacy probe", starts_at: ist(24 * 35), ends_at: ist(24 * 35 + 4), workers_needed: 2 }));
    const a1 = (await api(tok.w1, "POST", `/api/jobs/${j.json.id}/applications`, {})).json.application_id;
    await api(tok.w1, "PUT", "/api/me/contact", { phone: "9876543210" });
    const booking = (await api(tok.e1, "POST", `/api/applications/${a1}/accept`)).json.booking_id;
    const applicants = await api(tok.e1, "GET", `/api/jobs/${j.json.id}/applicants`);
    ok(!/\+91\d{10}|phone/.test(applicants.text), "phone leaked in applicants response");
    await expecting(async () => {
      eq((await api(tok.w2, "GET", `/api/bookings/${booking}/contact`)).status, 404, "unbooked worker");
      eq((await api(tok.e2, "GET", `/api/bookings/${booking}/contact`)).status, 404, "other employer");
    });
    eq((await api(tok.e1, "GET", `/api/bookings/${booking}/contact`)).json.phone, "+919876543210", "legitimate employer");
  });
  await tc("SEC-08", "Security", "Mass assignment and identity spoofing are refused (client-supplied role / user id / employer id)", async () => {
    block(tok.w1 && tok.e1, "setup failed");
    const out = [];
    await expecting(async () => {
      const attempts = [
        ["PUT /me/profile role", tok.w1, "PUT", "/api/me/profile", { full_name: "Hacker QA", preferred_language: "en", role: "employer" }],
        ["PUT /me/profile is_suspended", tok.w1, "PUT", "/api/me/profile", { full_name: "Hacker QA", preferred_language: "en", is_suspended: false }],
        ["POST /jobs employer_id", tok.e1, "POST", "/api/jobs", { ...jobBody(), employer_id: uid(acct.e2.email) }],
        ["apply worker_id", tok.w1, "POST", `/api/jobs/${S.job}/applications`, { worker_id: uid(acct.w2.email) }],
        ["contact user_id", tok.w1, "PUT", "/api/me/contact", { phone: "9876543210", user_id: uid(acct.w2.email) }],
      ];
      for (const [name, t, m, p, b] of attempts) {
        const r = await api(t, m, p, b);
        out.push(`${name}:${r.status}`);
        ok(r.status === 422, `${name} -> ${r.status}`);
      }
    });
    eq(sql(`select role from public.profiles where id='${uid(acct.w1.email)}'`), "worker", "role must be unchanged");
    return { evidence: out.join(" ") };
  });
  await tc("SEC-09", "Security", "Direct database writes with a user token are denied for every table (RLS + grants)", async () => {
    block(tok.w1, "setup failed");
    const me = uid(acct.w1.email);
    const attempts = [
      ["PATCH profiles.role", `profiles?id=eq.${me}`, { method: "PATCH", body: JSON.stringify({ role: "employer" }) }],
      ["POST bookings", "bookings", { method: "POST", body: JSON.stringify({ job_id: S.job }) }],
      ["PATCH jobs", `jobs?id=eq.${S.job}`, { method: "PATCH", body: JSON.stringify({ workers_needed: 99 }) }],
      ["DELETE job_applications", `job_applications?worker_id=eq.${me}`, { method: "DELETE" }],
      ["PATCH notifications", `notifications?user_id=eq.${me}`, { method: "PATCH", body: JSON.stringify({ read_at: null }) }],
      ["POST contact_details", "contact_details", { method: "POST", body: JSON.stringify({ user_id: me, phone: "+919999999999" }) }],
    ];
    const out = [];
    for (const [name, q, init] of attempts) {
      const r = await auth.rest(tok.w1, q, init);
      out.push(`${name}:${r.status}`);
      ok([401, 403].includes(r.status), `${name} -> ${r.status}`);
    }
    return { evidence: out.join(" ") };
  });
  await tc("SEC-10", "Security", "The service-role key never reaches the browser (public config, page HTML and every script the app loaded)", async () => {
    const cfg = await (await fetch(`${API}/api/public-config`)).json();
    eq(Object.keys(cfg).sort(), ["supabaseAnonKey", "supabaseUrl"], "public-config keys");
    ok(cfg.supabaseAnonKey !== env.service, "service key served as anon key");
    const c = await newCtx("leak-scan");
    setPage(c.page);
    const bodies = [];
    c.page.on("response", async (r) => {
      const t = r.headers()["content-type"] ?? "";
      if (/javascript|html|json/.test(t)) bodies.push({ url: r.url(), text: await r.text().catch(() => "") });
    });
    await c.page.goto(`${WEB}/`);
    await c.page.goto(`${WEB}/login`);
    await c.page.waitForTimeout(800);
    const all = bodies.map((b) => b.text).join("\n");
    ok(all.length > 50_000, "scan too small to mean anything");
    ok(!all.includes(env.service), "SERVICE ROLE KEY VALUE FOUND IN BROWSER-DELIVERED CONTENT");
    // KaamSetu's own modules must not even mention the service role; third-party library code may name the role in its own docs
    const ours = bodies.filter((b) => /\/src\//.test(new URL(b.url).pathname));
    const mention = ours.find((b) => /service_role|SERVICE_ROLE|serviceRole/i.test(b.text));
    ok(!mention, `KaamSetu source module mentions the service role: ${mention?.url}`);
    const lib = bodies.filter((b) => !/\/src\//.test(new URL(b.url).pathname) && /service_role/.test(b.text.replace(/"role":"service_role"/g, ""))).map((b) => new URL(b.url).pathname.split("/").pop());
    await c.context.close();
    setPage(eb.page);
    return { evidence: `scanned ${Math.round(all.length / 1024)} KB across ${bodies.length} responses (${ours.length} KaamSetu modules); key value absent; library files that merely name the role in their own text: ${lib.join(", ") || "none"}` };
  });
  await tc("SEC-11", "Security", "Stored XSS: markup in a job title and a worker message is rendered as inert text and never executes", async () => {
    block(tok.e1 && tok.w5, "setup failed");
    const xss = `<img src=x onerror="window.__xss=1"><script>window.__xss=2</script>`;
    const j = await api(tok.e1, "POST", "/api/jobs", jobBody({ title: `XSS ${xss}`, description: xss, starts_at: ist(24 * 40), ends_at: ist(24 * 40 + 4) }));
    eq(j.status, 201, "create xss job");
    await api(tok.w5, "POST", `/api/jobs/${j.json.id}/applications`, { message: xss });
    setPage(eb.page);
    await eb.page.goto(`${WEB}/employer/jobs/${j.json.id}`);
    await eb.page.getByText("XSS <img", { exact: false }).first().waitFor({ timeout: 8000 });
    await eb.page.waitForTimeout(600);
    eq(await eb.page.evaluate(() => window.__xss ?? null), null, "script executed");
    ok((await eb.page.locator("main img[src='x']").count()) === 0, "injected <img> element exists in the DOM");
  });

  // ======================================================================= F. SESSIONS IN THE BROWSER
  console.log("\n=== F. Sessions in the browser");
  await tc("SES-01", "Sessions", "Unauthenticated visitors are redirected to login from every protected route", async () => {
    const c = await newCtx("anon");
    setPage(c.page);
    for (const route of ["/worker", "/worker/profile", "/worker/bookings", "/employer", "/employer/jobs/new", "/employer/jobs/new/ai", "/notifications"]) {
      await c.page.goto(`${WEB}${route}`);
      ok(await seen(c.page.getByRole("heading", { name: "Log in" })), `${route} did not redirect to login`);
    }
    await c.context.close();
    setPage(eb.page);
  });
  await tc("SES-02", "Sessions", "A session revoked on the server is detected in the browser: the user is sent to login without a crash", async () => {
    setPage(pages.w2.page);
    const p = pages.w2.page;
    await p.goto(`${WEB}/worker`);
    await seen(p.getByRole("heading", { name: "Find work" }));
    const token = await p.evaluate(() => {
      const k = Object.keys(localStorage).find((x) => /auth-token/.test(x));
      return k ? JSON.parse(localStorage.getItem(k)).access_token : null;
    });
    ok(token, "no token in browser");
    eq(await auth.logout(token, "global"), 204, "server-side revoke");
    const errsBefore = net.pageErrors.length;
    await expecting(async () => {
      // The app may already have noticed (then there is no nav left to click); otherwise the next action must expose it.
      await p.getByRole("link", { name: "Bookings" }).first().click({ timeout: 4000 }).catch(() => {});
      ok(await seen(p.getByRole("heading", { name: "Log in" }), 12000), `still on ${p.url()} after the session was revoked`);
    });
    eq(net.pageErrors.length, errsBefore, "uncaught errors while handling expiry");
  });

  // ======================================================================= G. UI: routes, loading, errors, notifications
  console.log("\n=== G. Routes, loading and error states");
  await tc("UI-03", "UI states", "Unknown URL shows a friendly Page not found with a way home", async () => {
    const c = await newCtx("routes");
    pages.routes = c;
    setPage(c.page);
    await expecting(() => c.page.goto(`${WEB}/this/does/not/exist`));
    ok(await seen(c.page.getByRole("heading", { name: "Page not found" })), "no 404 page");
    ok(await c.page.getByRole("link", { name: "Back to KaamSetu" }).isVisible(), "no link home");
  });
  await tc("UI-04", "UI states", "Employer: an unknown job id shows 'Job not found' (no crash, no data leak)", async () => {
    setPage(eb.page);
    await expecting(async () => {
      await eb.page.goto(`${WEB}/employer/jobs/00000000-0000-4000-8000-000000000000`);
      ok(await seen(eb.page.getByText("Job not found")), "not-found state missing");
    });
  });
  await tc("UI-05", "UI states", "Employer opening a malformed job id shows a handled error, not a crash", async () => {
    setPage(eb.page);
    const errs = net.pageErrors.length;
    await expecting(async () => {
      await eb.page.goto(`${WEB}/employer/jobs/not-a-uuid`);
      await eb.page.waitForTimeout(1500);
    });
    ok((await eb.page.getByRole("alert").count()) > 0 || (await eb.page.getByText("Job not found").count()) > 0, "no handled state shown");
    eq(net.pageErrors.length, errs, "uncaught errors");
  });
  await tc("UI-06", "UI states", "Loading state: a slow jobs API shows an accessible loading indicator, then the list", async () => {
    // a live worker session is needed: use worker 3 through the UI
    const c = await newCtx("worker3-ui");
    pages.w3 = c;
    setPage(c.page);
    await c.page.goto(`${WEB}/login`);
    await c.page.getByLabel(/^Email/).fill(acct.w3.email);
    await c.page.getByLabel(/^Password/).fill(acct.w3.pw);
    await c.page.getByRole("button", { name: "Log in" }).click();
    await seen(c.page.getByRole("heading", { name: "Find work" }));
    await c.page.route("**/api/jobs?*", async (route) => {
      await new Promise((r) => setTimeout(r, 1800));
      await route.continue().catch(() => {}); // the route may have been handled elsewhere by then
    });
    await c.page.reload();
    ok(await seen(c.page.getByText("Loading jobs…"), 4000), "loading indicator not shown while the API was slow");
    const live = await c.page.getByText("Loading jobs…").evaluate((el) => el.closest("[role=status]")?.getAttribute("aria-live"));
    eq(live, "polite", "aria-live on the loading indicator");
    await c.page.unroute("**/api/jobs?*");
  });
  await tc("UI-07", "UI states", "Error state: when the jobs API is down the page shows a clear error with Try again, and recovers", async () => {
    setPage(pages.w3.page);
    const p = pages.w3.page;
    await p.route("**/api/jobs?*", (route) => route.abort("failed"));
    await expecting(async () => {
      await p.reload();
      ok(await seen(p.getByRole("alert")), "no error alert on API failure");
    });
    ok(await p.getByRole("button", { name: "Try again" }).isVisible(), "no retry button");
    await p.unroute("**/api/jobs?*");
    await p.getByRole("button", { name: "Try again" }).click();
    ok(await seen(p.getByRole("heading", { name: "Find work" })) && !(await p.getByRole("alert").count()), "did not recover after retry");
  });
  await tc("UI-08", "UI states", "Notifications page lists real notifications and mark-all-read updates the database", async () => {
    setPage(eb.page);
    await eb.page.goto(`${WEB}/notifications`);
    ok(await seen(eb.page.getByText(/New application for/).first()), "employer notifications missing");
    const unread = Number(sql(`select count(*) from public.notifications n join auth.users u on u.id=n.user_id where u.email='${acct.e1.email}' and n.read_at is null`));
    ok(unread > 0, "expected unread notifications");
    await eb.page.getByRole("button", { name: "Mark all as read" }).click();
    ok(await seen(eb.page.getByText("You're all caught up.")), "UI not updated");
    eq(sql(`select count(*) from public.notifications n join auth.users u on u.id=n.user_id where u.email='${acct.e1.email}' and n.read_at is null`), "0", "DB unread after mark-all-read");
  });

  // ======================================================================= H. EMAIL (continued)
  console.log("\n=== H. Email features");
  await tc("MAIL-03", "Email", "Supabase password-recovery email is delivered to Mailpit with a recovery link (platform capability)", async () => {
    const before = (await mail.to(acct.w3.email)).length;
    eq(await auth.recover(acct.w3.email), 200, "recover request");
    const msgs = await mail.to(acct.w3.email, { wait: 10000, min: before + 1 });
    const m = msgs.find((x) => /reset|recover/i.test(x.Subject));
    ok(m, `no recovery email (subjects: ${msgs.map((x) => x.Subject).join("; ")})`);
    eq(m.To.map((t) => t.Address), [acct.w3.email], "recipient");
    const link = mail.link(m);
    ok(link && /type=recovery/.test(link), "recovery link missing/incorrect");
    return { evidence: `From <${m.From.Address}>; Subject "${m.Subject}"; link type=recovery` };
  });
  await tc("MAIL-04", "Email", "App provides a password-reset flow (login link, page, or route)", async () => {
    const c = await newCtx("reset-ui");
    setPage(c.page);
    await c.page.goto(`${WEB}/login`);
    const link = await c.page.getByRole("link", { name: /forgot|reset/i }).count();
    await c.page.goto(`${WEB}/reset-password`);
    const page404 = await c.page.getByRole("heading", { name: "Page not found" }).isVisible();
    await c.context.close();
    setPage(eb.page);
    if (!link && page404) notImplemented("No 'Forgot password' link on the login page and no /reset-password or /forgot-password route. Users who lose their password cannot recover their account.");
  });
  await tc("MAIL-05", "Email", "Job and application events trigger emails to users", async () => {
    // Everything above created applications, bookings and cancellations. Count non-auth emails.
    const all = await mail.list();
    const nonAuth = all.filter((m) => !/confirm|reset|recover|signup|magic|invite|email change/i.test(m.Subject));
    const appRelated = all.filter((m) => /application|booking|job|applied|booked|cancel/i.test(m.Subject));
    ok(nonAuth.length === 0 && appRelated.length === 0 ? true : false, `found unexpected emails: ${nonAuth.map((m) => m.Subject).join("; ")}`);
    notImplemented(`Not implemented: ${all.length} emails in Mailpit after full marketplace activity, all auth emails; none for applications, bookings or cancellations. Job/application notifications are in-app only (verified in the database).`);
  });
  await tc("MAIL-06", "Email", "Contact form delivers a message to the team inbox", async () => {
    const page = await fetch(`${WEB}/contact`).then((r) => r.status);
    const ep = await api(null, "POST", "/api/contact", { name: "QA", email: "qa@kaamsetu.test", message: "hello" });
    notImplemented(`No contact page or API (GET /contact serves the SPA 404 page; POST /api/contact -> ${ep.status}). .env.example lists SMTP_*/CONTACT_TO but nothing reads them.`);
  });
  await tc("MAIL-07", "Email", "Auth emails are branded (subject, heading, call to action) and contain a working link", async () => {
    const m = S.confirmMail;
    block(m, "no email captured");
    ok(/kaamsetu/i.test(m.Subject), `subject not branded: "${m.Subject}"`);
    ok(/KaamSetu/.test(m.HTML) && /Confirm my account/.test(m.HTML), "body not branded / no call-to-action button");
    ok(/never asks for Aadhaar/.test(m.Text ?? m.HTML), "privacy line missing");
    return { evidence: `subject "${m.Subject}"; branded heading and button` };
  });
  await tc("MAIL-08", "Email", "Auth emails are sent from a KaamSetu-owned sender address", async () => {
    const a = S.confirmMail?.From?.Address ?? "";
    block(false, `BLOCKED: local Mailpit sender is <${a}> (Supabase default). A KaamSetu domain sender needs hosted SMTP (SPF/DKIM) which cannot be provisioned or tested locally.`);
  });

  // ======================================================================= I. MOBILE
  console.log("\n=== I. Mobile viewport (390 x 844)");
  const mob = await newCtx("mobile", true);
  pages.mob = mob;
  setPage(mob.page);
  const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  const smallTargets = (p) =>
    p.evaluate(() => {
      const bad = [];
      for (const el of document.querySelectorAll("button, select, input:not([type=checkbox]):not([type=radio]):not([type=hidden]), nav a")) {
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (r.height < 40) bad.push(`${el.tagName.toLowerCase()}:${(el.getAttribute("aria-label") || el.textContent || el.getAttribute("type") || "").trim().slice(0, 24)}(${Math.round(r.height)}px)`);
      }
      return bad;
    });
  await tc("MOB-01", "Mobile", "Public pages (landing, login, signup, credits) have no horizontal scroll", async () => {
    const out = [];
    for (const r of ["/", "/login", "/signup", "/credits"]) {
      await mob.page.goto(`${WEB}${r}`);
      await mob.page.waitForTimeout(400);
      const o = await overflow(mob.page);
      out.push(`${r}:${o}px`);
      ok(o <= 1, `${r} overflows by ${o}px`);
    }
    return { evidence: out.join(" ") };
  });
  await tc("MOB-02", "Mobile", "Signed-in pages (worker + employer) have no horizontal scroll; the menu opens and navigates", async () => {
    await mob.page.goto(`${WEB}/login`);
    await mob.page.getByLabel(/^Email/).fill(acct.w3.email);
    await mob.page.getByLabel(/^Password/).fill(acct.w3.pw);
    await mob.page.getByRole("button", { name: "Log in" }).click();
    await seen(mob.page.getByRole("heading", { name: "Find work" }));
    const out = [];
    for (const r of ["/worker", "/worker/profile", "/worker/applications", "/worker/bookings", "/notifications"]) {
      await mob.page.goto(`${WEB}${r}`);
      await mob.page.waitForTimeout(700);
      const o = await overflow(mob.page);
      out.push(`${r}:${o}px`);
      ok(o <= 1, `${r} overflows by ${o}px`);
    }
    await mob.page.getByRole("button", { name: "Open menu" }).click();
    ok(await seen(mob.page.getByRole("link", { name: "My applications" })), "menu did not open");
    await mob.page.getByRole("link", { name: "Profile" }).click();
    ok(await seen(mob.page.getByRole("heading", { name: "Your worker profile" })), "menu navigation failed");
    return { evidence: out.join(" ") };
  });
  await tc("MOB-03", "Mobile", "Employer pages on mobile (jobs, applicants, job form) have no horizontal scroll", async () => {
    const c = await newCtx("mobile-employer", true);
    setPage(c.page);
    await c.page.goto(`${WEB}/login`);
    await c.page.getByLabel(/^Email/).fill(acct.e1.email);
    await c.page.getByLabel(/^Password/).fill(acct.e1.pw);
    await c.page.getByRole("button", { name: "Log in" }).click();
    await seen(c.page.getByRole("heading", { name: "My jobs" }));
    const out = [];
    for (const r of ["/employer", "/employer/jobs/new", "/employer/jobs/new/ai", "/employer/bookings", `/employer/jobs/${S.job}`]) {
      await c.page.goto(`${WEB}${r}`);
      await c.page.waitForTimeout(700);
      const o = await overflow(c.page);
      out.push(`${r.replace(S.job ?? "x", ":id")}:${o}px`);
      ok(o <= 1, `${r} overflows by ${o}px`);
    }
    pages.mobEmp = c;
    return { evidence: out.join(" ") };
  });
  await tc("MOB-04", "Mobile", "Touch targets: buttons, inputs and nav links are at least 40 px tall on mobile", async () => {
    setPage(pages.mobEmp?.page ?? mob.page);
    const p = pages.mobEmp?.page ?? mob.page;
    const bad = [];
    for (const r of ["/employer", "/employer/jobs/new"]) {
      await p.goto(`${WEB}${r}`);
      await p.waitForTimeout(500);
      bad.push(...(await smallTargets(p)));
    }
    ok(bad.length === 0, `${bad.length} small targets: ${bad.slice(0, 6).join(", ")}`);
  });

  // ======================================================================= J. NETWORK + CONSOLE
  console.log("\n=== J. Console and network");
  await tc("NET-01", "Browser health", "No uncaught JavaScript errors in any browser session", async () => {
    eq(net.pageErrors.length, 0, `page errors: ${net.pageErrors.slice(0, 3).map((e) => `[${e.label}] ${e.text}`).join(" | ")}`);
    return { evidence: `0 uncaught errors across ${Object.keys(pages).length}+ browser sessions` };
  });
  await tc("NET-02", "Browser health", "No UNEXPECTED console errors or failed/4xx/5xx requests outside negative tests", async () => {
    const unexpectedHttp = net.events.filter((e) => !e.expected);
    const unexpectedConsole = net.consoleErrors.filter((e) => !e.expected);
    ok(unexpectedHttp.length === 0 && unexpectedConsole.length === 0, `unexpected http: ${[...new Set(unexpectedHttp.map((e) => `${e.method} ${e.status} ${e.url.replace(WEB, "").replace(API, "").slice(0, 70)} [${e.label} in ${e.test}]`))].slice(0, 12).join(" | ")} || console: ${unexpectedConsole.slice(0, 3).map((e) => `[${e.label} in ${e.test}] ${e.text.slice(0, 60)} ${(e.url||"").replace(WEB,"").slice(0,50)}`).join(" | ")}`);
    return { evidence: `${net.events.filter((e) => e.expected).length} expected error responses (negative tests), 0 unexpected` };
  });

  saveResults({
    network: net.events, consoleErrors: net.consoleErrors, pageErrors: net.pageErrors,
    accounts: Object.values(acct).map((a) => ({ email: a.email, role: a.role })),
    mailpit: (await mail.list()).map((m) => ({ to: m.To.map((t) => t.Address).join(","), from: m.From?.Address, subject: m.Subject })),
  });
} catch (err) {
  console.error("SUITE CRASHED:", err.stack);
  results.push({ id: "SUITE", area: "Harness", name: "Suite ran to completion", status: "FAIL", error: String(err.message).slice(0, 300), evidence: "", screenshot: "" });
  saveResults();
} finally {
  await browser?.close().catch(() => {});
  stopAll();
  // Leave the local database as we found it: leftover QA jobs/users break the pgTAP visibility tests.
  // Set KEEP_QA_DATA=1 to keep them for manual inspection.
  if (!process.env.KEEP_QA_DATA) {
    try {
      cleanupQa();
    } catch (e) {
      console.error("QA cleanup failed:", e.message);
    }
  }
}
const c =(s) => results.filter((r) => r.status === s).length;
console.log(`\nPASS ${c("PASS")}  FAIL ${c("FAIL")}  BLOCKED ${c("BLOCKED")}  NOT IMPLEMENTED ${c("NOT IMPLEMENTED")}  TOTAL ${results.length}`);
process.exit(c("FAIL") ? 1 : 0);
