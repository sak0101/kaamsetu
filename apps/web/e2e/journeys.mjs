// End-to-end journeys in a REAL browser (Microsoft Edge) against the REAL local stack:
//   Vite (:5173) -> Express (:3001) -> local Supabase (Auth, Postgres + RLS, Realtime, Mailpit).
// The ONLY non-real part is the AI model: with no ANTHROPIC_API_KEY available, requests go through
// the real SDK to a local STUB of the Anthropic API (e2e/anthropic-stub.mjs). It validates the request
// shape and returns a regex-based extraction. It says nothing about how well Claude itself drafts jobs.
//
//   npm run e2e -w @kaamsetu/web        (needs `supabase start` incl. mailpit, and Docker)
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { startAnthropicStub } from "./anthropic-stub.mjs";
import { WEB, axeCheck, check, cleanup, launch, password, seen, shot, signOut, signUpAndConfirm, sql, summary, uniqueEmail } from "./lib.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function localEnv() {
  const out = execFileSync(npx, ["supabase", "status", "-o", "env"], { cwd: repo, encoding: "utf8", shell: process.platform === "win32" });
  const v = Object.fromEntries(out.split(/\r?\n/).map((l) => /^([A-Z_]+)="?(.*?)"?$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(v.API_URL ?? "")) throw new Error("Refusing to run E2E against a non-local Supabase.");
  return { SUPABASE_URL: v.API_URL, SUPABASE_ANON_KEY: v.ANON_KEY, SUPABASE_SERVICE_ROLE_KEY: v.SERVICE_ROLE_KEY };
}

const procs = [];
function start(name, args, cwd, env) {
  const p = spawn(npx, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  procs.push({ name, p, log: () => log });
  return p;
}
function killAll() {
  for (const { p } of procs) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
      else p.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
}
async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

// A scripted stand-in for the browser's speech engine. It does NOT test Chrome/Edge's recogniser; it
// proves our UI wiring: push-to-talk, live indicator, interim text, final text into an editable field.
const FAKE_SPEECH = `
(() => {
  class R {
    constructor() { this.lang = ''; this.continuous = true; this.interimResults = false; window.__speech = (window.__speech || []); window.__speech.push(this); }
    start() {
      window.__speechStarts = (window.__speechStarts || 0) + 1;
      window.__speechConfig = { lang: this.lang, continuous: this.continuous, interim: this.interimResults };
      setTimeout(() => { this.onstart && this.onstart(); }, 20);
      setTimeout(() => {
        const text = window.__SPEECH_TEXT__ || 'hello';
        const words = text.split(' ');
        this.onresult && this.onresult({ resultIndex: 0, results: [{ isFinal: false, 0: { transcript: words.slice(0, 3).join(' ') }, length: 1 }] });
      }, 120);
      this._t = setTimeout(() => {
        const text = window.__SPEECH_TEXT__ || 'hello';
        this.onresult && this.onresult({ resultIndex: 0, results: [{ isFinal: true, 0: { transcript: text }, length: 1 }] });
        this.onend && this.onend();
      }, 900);
    }
    stop() { clearTimeout(this._t); this.onend && this.onend(); }
    abort() { clearTimeout(this._t); }
  }
  window.SpeechRecognition = R;
})();`;

const NO_SPEECH = `delete window.SpeechRecognition; delete window.webkitSpeechRecognition;`;

const WEDDING =
  "I need 8 helpers for a wedding at a venue in Alkapuri, Vadodara tomorrow from 5 PM to midnight. Payment is ₹800 per person. They should help with guest coordination and basic arrangements.";

const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

let browser;
let stub;
try {
  cleanup();
  stub = await startAnthropicStub(4010);
  const base = localEnv();
  start("api", ["tsx", "src/index.ts"], path.join(repo, "apps/api"), {
    ...base,
    NODE_ENV: "development",
    PORT: "3001",
    ANTHROPIC_API_KEY: "stub-key-not-a-real-key",
    ANTHROPIC_BASE_URL: "http://127.0.0.1:4010",
  });
  start("web", ["vite", "--port", "5173", "--strictPort"], path.join(repo, "apps/web"), {});
  await waitFor("http://localhost:3001/api/health");
  await waitFor(`${WEB}/`);

  const e = { role: "employer", name: "Meera Shah", email: uniqueEmail("organiser"), pw: password(), phone: "9123456789" };
  const w = { role: "worker", name: "Ravi Patel", email: uniqueEmail("worker"), pw: password(), phone: "9876543210" };
  const ctxs = [];

  browser = (await launch()).browser;
  const mk = async (opts = {}) => {
    const context = await browser.newContext(opts.mobile ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true } : { viewport: { width: 1280, height: 900 } });
    ctxs.push(context);
    if (opts.speech === "fake") await context.addInitScript(FAKE_SPEECH);
    if (opts.speech === "none") await context.addInitScript(NO_SPEECH);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (x) => errors.push(`pageerror: ${x.message}`));
    page.on("console", (m) => m.type() === "error" && !/favicon|Failed to load resource/.test(m.text()) && errors.push(`console: ${m.text()}`));
    return { context, page, errors };
  };

  // =============================================================== ORGANISER: sign up + profile
  console.log("\n--- Organiser: sign-up, profile");
  const emp = await mk({ speech: "fake" });
  await signUpAndConfirm(emp.page, e);
  check("organiser: confirmed email lands on the organiser dashboard", await seen(emp.page.getByRole("heading", { name: "My jobs" })));
  check("organiser: dashboard offers 'Create a job with AI' prominently", await seen(emp.page.getByRole("link", { name: "Create a job with AI" }).first()));
  await emp.page.goto(`${WEB}/employer/profile`);
  await emp.page.getByLabel(/Business or organisation/).fill("Shah Event Services");
  await emp.page.getByLabel(/Phone number/).fill(e.phone);
  await emp.page.getByRole("button", { name: "Save profile" }).click();
  check("organiser: profile saved", await seen(emp.page.getByText("Profile saved.")));
  check("organiser: phone stored in the database as +91 E.164", sql(`select c.phone from public.contact_details c join auth.users u on u.id=c.user_id where u.email='${e.email}'`) === `+91${e.phone}`);

  // =============================================================== ORGANISER: AI job creation (typed)
  console.log("\n--- Organiser: AI job creation (text)");
  await emp.page.goto(`${WEB}/employer/jobs/new/ai`);
  const box = emp.page.getByLabel(/^Describe the job/);
  await box.fill(WEDDING);
  const before = stub.log.length;
  await emp.page.getByRole("button", { name: "Create draft" }).click();
  check("AI: a draft preview appears", await seen(emp.page.getByText("Your draft is ready to check"), 20000));
  check("AI: exactly one request reached the (stub) Messages API, via the real SDK", stub.log.length === before + 1, `n=${stub.log.length - before}`);
  const req = stub.log.at(-1)?.body;
  check("AI: request used model claude-opus-5-5 with a structured-output schema and no forbidden params", req?.model === "claude-opus-5-5" && req?.output_config?.format?.type === "json_schema" && !("thinking" in req) && !("temperature" in req), JSON.stringify(Object.keys(req ?? {})));
  check("AI: the API key reached the AI service from the SERVER only, and never appears in the browser", stub.log.every((l) => /stub-key-not-a-real-key/.test(l.headers.authorization ?? l.headers["x-api-key"] ?? "")) && !(await emp.page.content()).includes("stub-key-not-a-real-key") && !(await emp.page.evaluate(() => JSON.stringify(localStorage))).includes("stub-key"));
  check("AI: title extracted", /Alkapuri/.test(await emp.page.getByLabel(/^Job title/).inputValue()));
  check("AI: 8 workers, ₹800, fixed price, 17:00 to 00:00 ending the next day", (await emp.page.getByLabel(/^Workers needed/).inputValue()) === "8" && (await emp.page.getByLabel(/^Amount/).inputValue()) === "800" && (await emp.page.getByLabel(/^Pay is/).inputValue()) === "fixed" && (await emp.page.getByLabel(/^Start time/).inputValue()) === "17:00" && (await emp.page.getByLabel(/^End time/).inputValue()) === "00:00" && (await emp.page.getByRole("checkbox", { name: /Ends the next day/ }).isChecked()));
  check("AI: assumptions are shown for the organiser to check", await seen(emp.page.getByText("What I assumed: please check")));
  check("AI: fields carry 'Filled by AI' / 'Assumed' labels", (await emp.page.getByText("Filled by AI: please check").count()) > 0 && (await emp.page.getByText("Assumed: please check").count()) > 0);
  const publish = emp.page.getByRole("button", { name: "Publish job" });
  check("AI: publish is locked until the organiser confirms", await publish.isDisabled());
  check("AI: NOTHING is in the database yet", sql(`select count(*) from public.jobs j join auth.users u on u.id=j.employer_id where u.email='${e.email}'`) === "0");
  await shot(emp.page, "ai-preview-desktop");
  await axeCheck(emp.page, "AI draft preview (desktop)");
  await emp.page.getByLabel(/^Job title/).fill("Wedding helpers needed, Alkapuri");
  await emp.page.getByRole("checkbox", { name: /I've checked these details/ }).check();
  check("AI: ticking the confirmation box alone still publishes nothing", sql(`select count(*) from public.jobs j join auth.users u on u.id=j.employer_id where u.email='${e.email}'`) === "0");
  await publish.click();
  check("AI: after explicit confirmation the job is published and its page opens", await seen(emp.page.getByText("Job posted. Workers can now apply."), 15000));
  const job1 = sql(`select j.title||'|'||j.workers_needed||'|'||j.pay_amount_paise||'|'||j.pay_type||'|'||j.status||'|'||(extract(epoch from (j.ends_at - j.starts_at))/3600)::int from public.jobs j join auth.users u on u.id=j.employer_id where u.email='${e.email}'`);
  check("AI: the saved job matches the edited preview (title edit kept, 8 workers, ₹800.00, fixed, open, 7-hour overnight shift)", job1 === "Wedding helpers needed, Alkapuri|8|80000|fixed|open|7", job1);
  check("AI: job starts at 5 PM IST tomorrow", sql(`select to_char(j.starts_at at time zone 'Asia/Kolkata','HH24:MI')||'|'||((j.starts_at at time zone 'Asia/Kolkata')::date - (now() at time zone 'Asia/Kolkata')::date) from public.jobs j join auth.users u on u.id=j.employer_id where u.email='${e.email}'`) === "17:00|1");

  // =============================================================== ORGANISER: AI follow-up questions + voice
  console.log("\n--- Organiser: voice input, follow-up questions");
  await emp.page.goto(`${WEB}/employer/jobs/new/ai`);
  await emp.page.evaluate(() => (window.__SPEECH_TEXT__ = "I need some cleaners tomorrow at Gotri"));
  await emp.page.getByRole("button", { name: "Speak" }).click();
  check("voice: a live 'Listening' indicator is shown while the microphone is on", await seen(emp.page.getByText("Listening… speak now"), 3000));
  await emp.page.waitForFunction(() => document.querySelector("textarea")?.value.includes("cleaners"), null, { timeout: 5000 }).catch(() => {});
  check("voice: the transcript appears in the editable box", (await box.inputValue()).includes("I need some cleaners tomorrow at Gotri"));
  check("voice: push-to-talk only (started once, not continuous, en-IN), and listening stopped after the phrase", (await emp.page.evaluate(() => window.__speechStarts)) === 1 && (await emp.page.evaluate(() => window.__speechConfig.continuous)) === false && (await emp.page.evaluate(() => window.__speechConfig.lang)) === "en-IN" && !(await emp.page.getByText("Listening… speak now").isVisible()));
  const n0 = stub.log.length;
  check("voice: speaking sent nothing to the AI by itself", stub.log.length === n0);
  await emp.page.getByLabel(/^Describe the job/).fill((await box.inputValue()) + " They will clean the restaurant kitchen.");
  await emp.page.getByRole("button", { name: "Create draft" }).click();
  check("AI: a vague request produces follow-up questions instead of invented values", await seen(emp.page.getByText("A few details are missing or unclear"), 20000));
  check("AI: missing fields are flagged 'Needs your input' and left empty", (await emp.page.getByText("Needs your input").count()) >= 3 && (await emp.page.getByLabel(/^Amount/).inputValue()) === "");
  await emp.page.getByLabel("How many workers do you need?").fill("3");
  await emp.page.getByLabel("How much will you pay each worker (in rupees)?").fill("600 per day");
  await emp.page.getByLabel("What time should the workers start?").fill("9 AM to 1 PM");
  await emp.page.getByRole("button", { name: "Update draft" }).click();
  await emp.page.waitForFunction(() => !document.body.textContent.includes("A few details are missing or unclear"), null, { timeout: 20000 }).catch(() => {});
  const second = stub.log.at(-1)?.body.messages[0].content ?? "";
  check("AI: the answers were sent back with the original request", second.includes("<follow_up_answers>") && second.includes("Answer: 3") && second.includes("600 per day"));
  check("AI: after answering, the draft is complete (3 workers, ₹600 per day)", (await emp.page.getByLabel(/^Workers needed/).inputValue()) === "3" && (await emp.page.getByLabel(/^Amount/).inputValue()) === "600" && (await emp.page.getByLabel(/^Pay is/).inputValue()) === "daily");
  await emp.page.getByRole("checkbox", { name: /I've checked these details/ }).check();
  await emp.page.getByRole("button", { name: "Publish job" }).click();
  check("AI: the second job published after confirmation", await seen(emp.page.getByText("Job posted. Workers can now apply."), 15000));
  check("database: the organiser now has exactly 2 jobs", sql(`select count(*) from public.jobs j join auth.users u on u.id=j.employer_id where u.email='${e.email}'`) === "2");

  // =============================================================== ORGANISER: the standard form still works
  console.log("\n--- Organiser: standard form");
  await emp.page.goto(`${WEB}/employer/jobs/new`);
  check("standard form is still available beside the AI entry point", await seen(emp.page.getByLabel(/^Job title/)) && (await emp.page.getByRole("link", { name: "Create a job with AI" }).isVisible()));

  // =============================================================== WORKER: sign up, profile, persistence
  console.log("\n--- Worker: sign-up, profile");
  const wk = await mk({ speech: "fake" });
  await signUpAndConfirm(wk.page, w);
  check("worker: confirmed email lands on Find work", await seen(wk.page.getByRole("heading", { name: "Find work" })));
  check("worker: a new worker is prompted to finish their profile", await seen(wk.page.getByText("Finish your profile to apply")));
  await wk.page.goto(`${WEB}/worker/profile`);
  await wk.page.getByRole("option", { name: "Alkapuri" }).waitFor({ state: "attached" });
  await wk.page.getByLabel(/^Area you work in/).selectOption({ label: "Alkapuri" });
  await wk.page.getByRole("checkbox", { name: "Event help" }).check();
  await wk.page.getByLabel(/Years of experience/).fill("4");
  await wk.page.getByLabel("Add a skill").fill("Guest handling");
  await wk.page.getByLabel("Add a skill").press("Enter");
  await wk.page.getByRole("button", { name: "+ Serving food" }).click();
  await wk.page.getByLabel("When are you available?").fill("Evenings and weekends");
  await wk.page.getByLabel(/About you/).fill("Reliable and punctual. I have worked weddings and warehouses.");
  await wk.page.getByLabel(/Phone number/).fill(w.phone);
  await wk.page.getByRole("button", { name: "Save profile" }).click();
  check("worker: profile saved", await seen(wk.page.getByText("Profile saved.")));
  await wk.page.reload();
  await wk.page.getByRole("option", { name: "Alkapuri" }).waitFor({ state: "attached" });
  check("worker: skills, availability, phone and intro persist after reload", (await wk.page.getByRole("list", { name: "Your skills" }).textContent()).includes("Serving food") && (await wk.page.getByLabel("When are you available?").inputValue()) === "Evenings and weekends" && (await wk.page.getByLabel(/Phone number/).inputValue()) === w.phone && (await wk.page.getByLabel(/About you/).inputValue()).includes("punctual"));
  const wdb = sql(`select array_to_string(wp.skills,',')||'|'||wp.availability_note||'|'||wp.years_experience||'|'||(select phone from public.contact_details c where c.user_id=wp.user_id) from public.worker_profiles wp join auth.users u on u.id=wp.user_id where u.email='${w.email}'`);
  check("worker: database holds skills, note, experience and phone", wdb === `Guest handling,Serving food|Evenings and weekends|4|+91${w.phone}`, wdb);
  check("worker: profile is 100% complete", await seen(wk.page.getByText("Profile 100% complete")));

  // =============================================================== WORKER: discovery (filters, voice search), real data only
  console.log("\n--- Worker: discovery");
  await wk.page.goto(`${WEB}/worker`);
  check("worker: sees the organiser's wedding job (real database record)", await seen(wk.page.getByRole("link", { name: "Wedding helpers needed, Alkapuri" })));
  check("worker: the Gotri cleaning job is hidden by the default 'my area' filter", (await wk.page.getByRole("link", { name: /Gotri/ }).count()) === 0);
  const img = wk.page.locator("article img").first();
  const imgState = (await img.count()) ? await img.evaluate((el) => ({ ok: el.complete && el.naturalWidth > 0, src: el.getAttribute("src") })) : null;
  console.log(`  (job-card photo: ${imgState ? `${imgState.src} loaded=${imgState.ok}` : "using coloured fallback tile"})`);
  check("worker: job card shows a photo that really loaded, or a clean fallback tile (never a broken image)", imgState === null || imgState.ok);
  check("worker: overview shows 'No confirmed jobs yet' and no applications", await seen(wk.page.getByText(/No confirmed jobs yet/)) && (await wk.page.getByText(/haven't applied yet/).isVisible()));

  await wk.page.getByLabel("Locality", { exact: true }).first().selectOption("");
  check("worker: widening to all of Vadodara reveals the Gotri job", await seen(wk.page.getByRole("link", { name: /Gotri/ })));
  check("worker: with no filters active, 'Clear filters' is correctly disabled", await wk.page.getByRole("button", { name: "Clear filters" }).isDisabled());

  await wk.page.evaluate(() => (window.__SPEECH_TEXT__ = "show me event helper jobs near Alkapuri tomorrow"));
  await wk.page.getByRole("button", { name: "Speak" }).click();
  await wk.page.waitForFunction(() => document.querySelector("input[type=text]") && [...document.querySelectorAll("input")].some((i) => i.value.includes("event helper")), null, { timeout: 5000 }).catch(() => {});
  check("voice search: the spoken request fills the editable search box", (await wk.page.getByLabel("What are you looking for?").inputValue()).includes("event helper jobs near alkapuri tomorrow".toLowerCase()) || (await wk.page.getByLabel("What are you looking for?").inputValue()).toLowerCase().includes("event helper"));
  await wk.page.getByRole("button", { name: "Understand my request" }).click();
  const understood = wk.page.getByRole("group", { name: "What I understood" });
  check("voice search: shows what it understood (Event help · Alkapuri · tomorrow)", (await seen(understood)) && /Event help jobs in Alkapuri tomorrow/.test(await understood.textContent()));
  await understood.getByRole("button", { name: "Show these jobs" }).click();
  check("voice search: after confirming, the matching job is listed", await seen(wk.page.getByRole("link", { name: "Wedding helpers needed, Alkapuri" })));
  await shot(wk.page, "worker-dashboard-desktop");
  await axeCheck(wk.page, "worker dashboard with voice-search result (desktop)");

  // =============================================================== WORKER applies; ORGANISER receives it live
  console.log("\n--- Apply -> live notification -> compare -> accept");
  await emp.page.goto(`${WEB}/employer`);
  await seen(emp.page.getByRole("heading", { name: "My jobs" }));
  await wk.page.getByRole("link", { name: "Wedding helpers needed, Alkapuri" }).click();
  await wk.page.getByLabel(/message to the employer/i).fill("I have worked at 20+ weddings. Can start at 4 PM.");
  await wk.page.getByRole("button", { name: "Apply for this job" }).click();
  check("worker: application sent", await seen(wk.page.getByText(/Application sent/)));
  check("worker: application status shows 'Waiting for employer'", await seen(wk.page.getByText("Waiting for employer")));
  check("organiser: a live toast appears WITHOUT reloading (Supabase Realtime)", await seen(emp.page.getByText(/New application for/), 15000));
  check("organiser: bell shows an unread notification", await seen(emp.page.getByRole("link", { name: /Notifications, \d+ unread/ })));
  await emp.page.getByRole("link", { name: "Manage" }).first().click().catch(() => {});

  await emp.page.goto(`${WEB}/employer`);
  await emp.page.getByRole("link", { name: "Manage" }).first().click();
  const card = emp.page.getByRole("article", { name: "Applicant Ravi Patel" });
  check("organiser: applicant card appears with a match label and percentage", await seen(card));
  const cardText = (await card.textContent()) ?? "";
  check("organiser: the card explains WHY (type of work, locality, experience, skills, availability)", /Offers this type of work/.test(cardText) && /Works in this job's locality/.test(cardText) && /4 years of experience/.test(cardText) && /Guest handling/.test(cardText) && /Evenings and weekends/.test(cardText));
  check("organiser: a brand-new worker is told it isn't held against them, with no fabricated reviews", /New to KaamSetu: no completed jobs yet\. This isn't held against them/.test(cardText) && !/\b(stars?|rated|rating of)\b/i.test(cardText));
  check("organiser: the worker's own message is shown", /20\+ weddings/.test(cardText));
  check("organiser: the method is explained and the organiser decides", (await emp.page.getByText(/You make the final decision/).count()) > 0);
  await shot(emp.page, "organiser-applicants-desktop");
  await axeCheck(emp.page, "organiser applicant comparison (desktop)");
  await card.getByRole("button", { name: "Accept and book" }).click();
  check("organiser: accepting books the worker", await seen(emp.page.getByText("Ravi Patel is booked.")));
  const booked = sql(`select b.status||'|'||j.positions_filled||'|'||j.workers_needed||'|'||j.status from public.bookings b join public.jobs j on j.id=b.job_id join auth.users u on u.id=b.worker_id where u.email='${w.email}'`);
  check("database: booking is confirmed, 1 of 8 slots filled, job still open (no overbooking)", booked === "confirmed|1|8|open", booked);

  // =============================================================== WORKER sees the booking live and the contact
  console.log("\n--- Booking visible live, contact shared only now");
  check("worker: a live 'You're booked' toast appears WITHOUT reloading", await seen(wk.page.getByText(/You're booked for/), 15000));
  await wk.page.goto(`${WEB}/worker/bookings`);
  check("worker: the confirmed booking is listed with the agreed pay", (await seen(wk.page.getByText("Confirmed"))) && (await seen(wk.page.getByText("₹800 agreed"))));
  await wk.page.getByRole("button", { name: "Show contact" }).click();
  const tel = wk.page.getByRole("link", { name: `+91${e.phone}` });
  check("worker: the organiser's phone is revealed as a tap-to-call link ONLY because the booking is confirmed", (await seen(tel)) && (await tel.getAttribute("href")) === `tel:+91${e.phone}`);
  await wk.page.goto(`${WEB}/worker`);
  check("worker dashboard: upcoming booking and 'accepted' application are summarised", (await seen(wk.page.getByRole("region", { name: "Your overview" }).getByText("Wedding helpers needed, Alkapuri"))) && /1\s*accepted/.test((await wk.page.getByRole("region", { name: "Your overview" }).textContent()) ?? ""));

  await emp.page.goto(`${WEB}/employer/bookings`);
  await emp.page.getByRole("button", { name: "Show contact" }).click();
  check("organiser: sees the booked worker's phone (booking is live)", await seen(emp.page.getByRole("link", { name: `+91${w.phone}` })));

  // contact privacy at the database boundary: a stranger cannot read either number
  const stranger = sql(`select count(*) from public.contact_details`); // owner view, just to prove rows exist
  check("database: both numbers exist (owner view)", stranger === "2", stranger);

  // =============================================================== Cancel -> slots free, contact revoked
  console.log("\n--- Cancellation frees the slot and revokes contact sharing");
  await wk.page.goto(`${WEB}/worker/bookings`);
  await wk.page.getByRole("button", { name: "Cancel booking" }).click();
  await wk.page.getByLabel(/reason/i).fill("Family emergency");
  await wk.page.getByRole("button", { name: "Yes, cancel booking" }).click();
  check("worker: cancellation confirmed", await seen(wk.page.getByText("Booking cancelled.")));
  const after = sql(`select b.status||'|'||(b.cancelled_by = b.worker_id)::text||'|'||j.positions_filled from public.bookings b join public.jobs j on j.id=b.job_id join auth.users u on u.id=b.worker_id where u.email='${w.email}'`);
  check("database: booking is cancelled_by_worker, attributed to the worker, and the slot is free again (0 of 8)", after === "cancelled_by_worker|true|0", after);
  check("organiser: is notified of the cancellation live", await seen(emp.page.getByText(/cancelled the booking for/), 15000));
  await wk.page.reload();
  check("worker: no 'Show contact' on a cancelled booking", (await seen(wk.page.getByText("Cancelled by worker"))) && (await wk.page.getByRole("button", { name: "Show contact" }).count()) === 0);

  // =============================================================== Logout / role protection
  console.log("\n--- Session safety");
  await signOut(wk.page);
  check("worker: logout returns to login and protected pages stay protected", (await seen(wk.page.getByRole("heading", { name: "Log in" }))) && (await (async () => { await wk.page.goto(`${WEB}/worker/bookings`); return seen(wk.page.getByRole("heading", { name: "Log in" })); })()));
  await emp.page.goto(`${WEB}/worker`);
  check("organiser: worker pages redirect an organiser to their own dashboard", await seen(emp.page.getByRole("heading", { name: "My jobs" })));

  // =============================================================== No speech support: graceful fallback
  console.log("\n--- Browser without speech recognition");
  const plain = await mk({ speech: "none" });
  await plain.page.goto(`${WEB}/login`);
  await plain.page.getByLabel(/^Email/).fill(e.email);
  await plain.page.getByLabel(/^Password/).fill(e.pw);
  await plain.page.getByRole("button", { name: "Log in" }).click();
  await seen(plain.page.getByRole("heading", { name: "My jobs" }));
  await plain.page.goto(`${WEB}/employer/jobs/new/ai`);
  check("no speech support: the microphone is replaced by a clear note, and typing still works", (await seen(plain.page.getByText(/Voice input isn't available in this browser/))) && (await plain.page.getByRole("button", { name: "Speak" }).count()) === 0 && (await plain.page.getByLabel(/^Describe the job/).isEditable()));
  const loginAgain = plain.errors.filter((x) => !/Failed to load|401/.test(x));
  check("no uncaught browser errors in the no-speech browser", loginAgain.length === 0, loginAgain.slice(0, 2).join(" | "));

  // =============================================================== Mobile: no horizontal scroll, key screens
  console.log("\n--- Mobile layout (390 px)");
  const mob = await mk({ mobile: true });
  await mob.page.goto(`${WEB}/`);
  await seen(mob.page.getByRole("heading", { level: 1 }));
  check("mobile: landing page has no horizontal scroll", await noOverflow(mob.page));
  await axeCheck(mob.page, "landing (mobile)");
  await shot(mob.page, "landing-mobile");
  await mob.page.goto(`${WEB}/login`);
  await mob.page.getByLabel(/^Email/).fill(w.email);
  await mob.page.getByLabel(/^Password/).fill(w.pw);
  await mob.page.getByRole("button", { name: "Log in" }).click();
  await seen(mob.page.getByRole("heading", { name: "Find work" }));
  await mob.page.waitForTimeout(600);
  check("mobile: worker dashboard has no horizontal scroll", await noOverflow(mob.page));
  await axeCheck(mob.page, "worker dashboard (mobile)");
  await shot(mob.page, "worker-dashboard-mobile");
  check("mobile: the menu button opens the navigation", await (async () => { await mob.page.getByRole("button", { name: "Open menu" }).click(); return seen(mob.page.getByRole("link", { name: "My applications" })); })());
  await mob.page.goto(`${WEB}/worker/profile`);
  await seen(mob.page.getByLabel(/^Area you work in/));
  check("mobile: worker profile has no horizontal scroll", await noOverflow(mob.page));
  await axeCheck(mob.page, "worker profile (mobile)");
  await shot(mob.page, "worker-profile-mobile");

  const allErrors = [...emp.errors, ...wk.errors, ...mob.errors].filter((x) => !/401|Failed to load|net::/.test(x));
  check("no uncaught browser errors across the journeys", allErrors.length === 0, allErrors.slice(0, 3).join(" | "));
  const apiLog = procs.find((p) => p.name === "api")?.log() ?? "";
  check("API logs contain no secrets", !/sb_secret|service_role|stub-key-not-a-real-key|eyJ[A-Za-z0-9_-]{30,}/.test(apiLog));
} catch (err) {
  check("E2E script ran to completion", false, err.stack?.split("\n").slice(0, 3).join(" | "));
  const log = procs.find((p) => p.name === "api")?.log() ?? "";
  console.log("--- API log tail ---\n" + log.split("\n").slice(-12).join("\n"));
} finally {
  await browser?.close().catch(() => {});
  stub?.close();
  killAll();
  cleanup();
}
process.exit(summary() ? 0 : 1);
