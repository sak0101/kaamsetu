// Real-browser end-to-end helpers. LOCAL ONLY: talks to the dev servers (Vite :5173, API :3001),
// the local Supabase stack and its Mailpit inbox (:54324). Drives the installed Microsoft Edge.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

export const WEB = process.env.E2E_WEB ?? "http://localhost:5173";
export const MAILPIT = "http://127.0.0.1:54324";
const here = path.dirname(fileURLToPath(import.meta.url));
export const OUT = path.join(here, "out");
fs.mkdirSync(OUT, { recursive: true });

const results = [];
export function check(name, ok, detail = "") {
  results.push({ name, ok });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${ok ? "" : `  -> ${detail}`}`);
  return ok;
}
export const summary = () => {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/${results.length} checks passed`);
  return results.every((r) => r.ok);
};

export async function launch({ mobile = false } = {}) {
  const browser = await chromium.launch({ channel: "msedge", headless: true });
  const context = await browser.newContext(
    mobile
      ? { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }
      : { viewport: { width: 1280, height: 900 } },
  );
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  page.on("console", (m) => m.type() === "error" && errors.push(`console: ${m.text()}`));
  return { browser, context, page, errors };
}

export const uniqueEmail = (prefix) => `${prefix}-${Math.random().toString(36).slice(2, 8)}@e2e.invalid`;
export const password = () => `Pw-${Math.random().toString(36).slice(2, 12)}-9`;

export async function shot(page, name) {
  const file = path.join(OUT, `${name}.png`);
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

/** Latest confirmation link sent to this address, read from the local Mailpit inbox. */
export async function confirmationLink(email, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const list = await (await fetch(`${MAILPIT}/api/v1/messages`)).json();
    const msg = (list.messages ?? []).find((m) => m.To?.some((t) => t.Address === email));
    if (msg) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${msg.ID}`)).json();
      const m = /href="([^"]*auth\/v1\/verify[^"]*)"/.exec(full.HTML ?? "");
      if (m) return m[1].replaceAll("&amp;", "&");
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error(`no confirmation email for ${email}`);
}

/** Remove everything the E2E run created (safe: only @e2e.invalid accounts). */
export function cleanup() {
  const sql = `
    delete from public.notifications where user_id in (select id from auth.users where email like '%@e2e.invalid');
    delete from public.bookings where employer_id in (select id from auth.users where email like '%@e2e.invalid');
    delete from public.job_applications where job_id in (select id from public.jobs where employer_id in (select id from auth.users where email like '%@e2e.invalid'));
    delete from public.jobs where employer_id in (select id from auth.users where email like '%@e2e.invalid');
    delete from auth.users where email like '%@e2e.invalid';`;
  execFileSync("docker", ["exec", "-i", "supabase_db_kaamsetu", "psql", "-U", "postgres", "-d", "postgres", "-q"], { input: sql, stdio: ["pipe", "ignore", "inherit"] });
}

export function sql(statement) {
  return execFileSync("docker", ["exec", "-i", "supabase_db_kaamsetu", "psql", "-U", "postgres", "-d", "postgres", "-At"], { input: statement, encoding: "utf8" }).trim();
}

/** Full sign-up -> email confirmation -> signed-in dashboard, exactly as a person would do it. */
export async function signUpAndConfirm(page, { role, name, email, pw }) {
  await page.goto(`${WEB}/signup?role=${role}`);
  await page.getByLabel(/^Full name/).fill(name);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(pw);
  await page.getByRole("button", { name: "Create account" }).click();
  await page.getByText("Check your email").waitFor({ timeout: 10000 });
  const link = await confirmationLink(email);
  await page.goto(link);
}

export async function logIn(page, { email, pw }) {
  await page.goto(`${WEB}/login`);
  await page.getByLabel(/^Email/).fill(email);
  await page.getByLabel(/^Password/).fill(pw);
  await page.getByRole("button", { name: "Log in" }).click();
}

/** True once the locator becomes visible (unlike isVisible(), this really waits). */
export const seen = (locator, ms = 10000) => locator.waitFor({ state: "visible", timeout: ms }).then(() => true, () => false);

/** Click "Sign out" in whichever nav is showing (desktop bar or mobile menu). */
export async function signOut(page) {
  const desktop = page.getByRole("button", { name: "Sign out" }).first();
  if (await desktop.isVisible()) return desktop.click();
  await page.getByRole("button", { name: "Open menu" }).click();
  await page.getByRole("button", { name: "Sign out" }).last().click();
}

import { createRequire } from "node:module";
const require_ = createRequire(import.meta.url);

/**
 * Run axe-core (WCAG 2.x A/AA rules, including colour contrast) on the current page.
 * Fails the check on any violation of impact serious or critical; lists lesser ones.
 */
export async function axeCheck(page, name) {
  await page.addScriptTag({ path: require_.resolve("axe-core/axe.min.js") });
  const result = await page.evaluate(async () =>
    // eslint-disable-next-line no-undef
    axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] }, resultTypes: ["violations"] }),
  );
  const bad = result.violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  const minor = result.violations.filter((v) => !(v.impact === "serious" || v.impact === "critical"));
  const detail = bad.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(" ")).join(", ")}`).join(" | ");
  check(`accessibility (axe, WCAG 2.1 AA): ${name}`, bad.length === 0, detail);
  if (minor.length) console.log(`  (minor, not failing: ${minor.map((v) => `${v.id}[${v.impact}]`).join(", ")})`);
  return result;
}
