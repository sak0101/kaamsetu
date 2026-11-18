// QA harness: test-case registry, failure screenshots, network/console tracking,
// Mailpit access and real-token API helpers. LOCAL ONLY (refuses non-local Supabase).
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAILPIT, WEB, sql } from "../lib.mjs";

export { MAILPIT, WEB, sql };
const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, "../../../..");
export const SHOTS = path.join(repo, "docs", "qa-screenshots");
export const OUT = path.join(here, "..", "out");
export const API = "http://localhost:3001";
fs.mkdirSync(SHOTS, { recursive: true });
fs.mkdirSync(OUT, { recursive: true });

const npx = process.platform === "win32" ? "npx.cmd" : "npx";

// ------------------------------------------------------------------ results
export class Blocked extends Error {}
export class NotImplemented extends Error {}
export const results = [];
let currentPage = null;
export const setPage = (p) => (currentPage = p);

export const ok = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
export const eq = (actual, expected, msg) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`${msg}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
};
export const block = (cond, why) => {
  if (!cond) throw new Blocked(why);
};
export const notImplemented = (why) => {
  throw new NotImplemented(why);
};

/** Run one test case. fn may return { evidence } describing what was verified (DB rows, API responses...). */
export async function tc(id, area, name, fn) {
  net.current = id;
  const rec = { id, area, name, status: "PASS", evidence: "", error: "", screenshot: "" };
  try {
    const out = await fn();
    rec.evidence = out?.evidence ?? "";
  } catch (e) {
    if (e instanceof Blocked) {
      rec.status = "BLOCKED";
      rec.error = e.message;
    } else if (e instanceof NotImplemented) {
      rec.status = "NOT IMPLEMENTED";
      rec.error = e.message;
    } else {
      rec.status = "FAIL";
      rec.error = (e.message ?? String(e)).split("\n")[0].slice(0, 400);
      if (currentPage && !currentPage.isClosed()) {
        const file = `${id}.png`;
        try {
          await currentPage.screenshot({ path: path.join(SHOTS, file), fullPage: true });
          rec.screenshot = `qa-screenshots/${file}`;
        } catch {
          /* page may be mid-navigation */
        }
      }
    }
  }
  results.push(rec);
  const mark = { PASS: "PASS", FAIL: "FAIL", BLOCKED: "BLOCK", "NOT IMPLEMENTED": "N/IMP" }[rec.status];
  console.log(`${mark.padEnd(5)} ${id.padEnd(8)} ${name}${rec.error ? `  -> ${rec.error}` : ""}`);
  return rec.status === "PASS";
}

export function saveResults(extra = {}) {
  fs.writeFileSync(path.join(OUT, "qa-results.json"), JSON.stringify({ at: new Date().toISOString(), results, ...extra }, null, 2));
}

// ------------------------------------------------------------ network / console
export const net = { current: "", expecting: false, events: [], consoleErrors: [], pageErrors: [] };

/** Run a block in which failing requests / console errors are EXPECTED (negative tests). */
export async function expecting(fn) {
  net.expecting = true;
  try {
    return await fn();
  } finally {
    // let in-flight responses land before the flag flips back
    await new Promise((r) => setTimeout(r, 250));
    net.expecting = false;
  }
}

export function track(page, label) {
  page.on("response", (r) => {
    const s = r.status();
    if (s >= 400) net.events.push({ label, kind: "http", status: s, method: r.request().method(), url: r.url().replace(/token=[^&]+/, "token=…"), expected: net.expecting, test: net.current });
  });
  page.on("requestfailed", (r) => {
    const f = r.failure()?.errorText ?? "";
    if (/ERR_ABORTED/.test(f)) return; // navigations / cancelled fetches
    net.events.push({ label, kind: "failed", status: 0, method: r.method(), url: r.url(), error: f, expected: net.expecting, test: net.current });
  });
  page.on("console", (m) => {
    if (m.type() === "error") net.consoleErrors.push({ label, text: m.text().slice(0, 300), expected: net.expecting, test: net.current, url: m.location()?.url ?? "" });
  });
  page.on("pageerror", (e) => net.pageErrors.push({ label, text: e.message.slice(0, 300) }));
}

// ------------------------------------------------------------------ local stack
const procs = [];
export function localEnv() {
  const out = execFileSync(npx, ["supabase", "status", "-o", "env"], { cwd: repo, encoding: "utf8", shell: process.platform === "win32" });
  const v = Object.fromEntries(out.split(/\r?\n/).map((l) => /^([A-Z_]+)="?(.*?)"?$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)/.test(v.API_URL ?? "")) throw new Error("Refusing to run QA against a non-local Supabase.");
  return { url: v.API_URL, anon: v.ANON_KEY, service: v.SERVICE_ROLE_KEY };
}

export function startProc(args, cwd, env) {
  const p = spawn(npx, args, { cwd, env: { ...process.env, ...env }, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  procs.push({ p, log: () => log, name: args[0] });
  return { log: () => log };
}
export function stopAll() {
  for (const { p } of procs) {
    try {
      if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
      else p.kill("SIGTERM");
    } catch {
      /* gone */
    }
  }
}
export async function waitFor(url, ms = 60000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* not yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timed out waiting for ${url}`);
}

// ------------------------------------------------------------------ database
export const QA_DOMAIN = "kaamsetu.test";
export function cleanupQa() {
  const like = `'%@${QA_DOMAIN}'`;
  const q = `
    delete from public.notifications where user_id in (select id from auth.users where email like ${like});
    delete from public.bookings where employer_id in (select id from auth.users where email like ${like});
    delete from public.job_applications where job_id in (select id from public.jobs where employer_id in (select id from auth.users where email like ${like}));
    delete from public.jobs where employer_id in (select id from auth.users where email like ${like});
    delete from auth.users where email like ${like};`;
  execFileSync("docker", ["exec", "-i", "supabase_db_kaamsetu", "psql", "-U", "postgres", "-d", "postgres", "-q"], { input: q, stdio: ["pipe", "ignore", "inherit"] });
}
export const uid = (email) => sql(`select id from auth.users where email='${email}'`);

// -------------------------------------------------------------------- mailpit
export const mail = {
  async clear() {
    await fetch(`${MAILPIT}/api/v1/messages`, { method: "DELETE" });
  },
  async list() {
    return (await (await fetch(`${MAILPIT}/api/v1/messages?limit=200`)).json()).messages ?? [];
  },
  /** All messages addressed to `email`, newest first, with bodies. */
  async to(email, { wait = 0, min = 1 } = {}) {
    const end = Date.now() + wait;
    for (;;) {
      const mine = (await this.list()).filter((m) => m.To?.some((t) => t.Address === email));
      if (mine.length >= min || Date.now() >= end) {
        return Promise.all(mine.map(async (m) => ({ ...m, ...(await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json()) })));
      }
      await new Promise((r) => setTimeout(r, 400));
    }
  },
  link(msg) {
    const m = /href="([^"]*auth\/v1\/verify[^"]*)"/.exec(msg.HTML ?? "");
    return m ? m[1].replaceAll("&amp;", "&") : null;
  },
};

// ------------------------------------------------------------ supabase + api (real tokens)
export function authClient(env) {
  const h = { apikey: env.anon, "content-type": "application/json" };
  return {
    async signUp(email, password, role, name) {
      const r = await fetch(`${env.url}/auth/v1/signup`, { method: "POST", headers: h, body: JSON.stringify({ email, password, data: { role, full_name: name } }) });
      return { status: r.status, json: await r.json() };
    },
    async signIn(email, password) {
      const r = await fetch(`${env.url}/auth/v1/token?grant_type=password`, { method: "POST", headers: h, body: JSON.stringify({ email, password }) });
      const json = await r.json();
      return { status: r.status, token: json.access_token, json };
    },
    async logout(token, scope = "global") {
      return (await fetch(`${env.url}/auth/v1/logout?scope=${scope}`, { method: "POST", headers: { ...h, authorization: `Bearer ${token}` } })).status;
    },
    async recover(email) {
      return (await fetch(`${env.url}/auth/v1/recover`, { method: "POST", headers: h, body: JSON.stringify({ email }) })).status;
    },
    rest(token, pathAndQuery, init = {}) {
      return fetch(`${env.url}/rest/v1/${pathAndQuery}`, { ...init, headers: { apikey: env.anon, authorization: `Bearer ${token}`, "content-type": "application/json", ...(init.headers ?? {}) } });
    },
  };
}

export async function api(token, method, p, body) {
  const headers = {};
  if (token) headers.authorization = `Bearer ${token}`;
  if (body !== undefined) headers["content-type"] = "application/json";
  const res = await fetch(`${API}${p}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* 204 */
  }
  return { status: res.status, json, text };
}

/** Confirm an account through the REAL email flow without a browser: follow the Mailpit link. */
export async function confirmViaMail(email) {
  const [msg] = await mail.to(email, { wait: 15000 });
  const link = msg && mail.link(msg);
  if (!link) throw new Error(`no confirmation email for ${email}`);
  const r = await fetch(link, { redirect: "manual" });
  return { status: r.status, location: r.headers.get("location") ?? "", msg };
}

const IST_MS = 5.5 * 3_600_000;
/** ISO time with +05:30, `hours` from now (IST wall clock). */
export const ist = (hours) => new Date(Date.now() + hours * 3_600_000 + IST_MS).toISOString().replace(/\.\d{3}Z$/, "+05:30");
export const istDateIn = (days) => new Date(Date.now() + days * 86_400_000 + IST_MS).toISOString().slice(0, 10);
export const jobBody = (o = {}) => ({
  category_id: 4, locality_id: 1, title: "QA helpers needed", description: "QA test job", starts_at: ist(72), ends_at: ist(76),
  workers_needed: 1, pay_type: "fixed", pay_amount_paise: 80000, ...o,
});
