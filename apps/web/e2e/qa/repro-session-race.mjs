// Reproduction harness: rapid logout -> login cycles, watching for stale-session 401s and for a fresh login being undone.
import path from "node:path";
import { launch, seen } from "../lib.mjs";
import { API, QA_DOMAIN, WEB, authClient, cleanupQa, confirmViaMail, localEnv, mail, repo, startProc, stopAll, track, waitFor, net } from "./harness.mjs";

const CYCLES = Number(process.env.CYCLES ?? 12);
const email = `race.qa@${QA_DOMAIN}`;
const pw = `Qa-${Math.random().toString(36).slice(2, 10)}-7!`;
let browser;
try {
  cleanupQa();
  await mail.clear();
  const env = localEnv();
  startProc(["tsx", "src/index.ts"], path.join(repo, "apps/api"), { SUPABASE_URL: env.url, SUPABASE_ANON_KEY: env.anon, SUPABASE_SERVICE_ROLE_KEY: env.service, NODE_ENV: "development", PORT: "3001" });
  await waitFor(`${API}/api/health`);
  await waitFor(`${WEB}/`);
  const auth = authClient(env);
  await auth.signUp(email, pw, "employer", "Race QA");
  await confirmViaMail(email);
  browser = (await launch()).browser;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  track(page, "race");
  const kicked = [];
  page.setDefaultTimeout(8000);
  for (let i = 1; i <= CYCLES; i++) {
   try {
    net.current = `cycle-${i}`;
    // each cycle starts logged out (the previous one ends logged in, which would redirect /login)
    await page.goto(`${WEB}/login`);
    await page.evaluate(() => localStorage.clear());
    await page.goto(`${WEB}/login`);
    await page.getByLabel(/^Email/).fill(email);
    await page.getByLabel(/^Password/).fill(pw);
    await page.getByRole("button", { name: "Log in" }).click();
    if (!(await seen(page.getByRole("heading", { name: "My jobs" })))) { kicked.push(`cycle ${i}: never reached dashboard`); continue; }
    // log out as fast as a user could, while the dashboard's own requests may still be in flight
    await page.getByRole("button", { name: "Sign out" }).first().click();
    await seen(page.getByRole("heading", { name: "Log in" }));
    // and straight back in with no pause
    await page.getByLabel(/^Email/).fill(email);
    await page.getByLabel(/^Password/).fill(pw);
    await page.getByRole("button", { name: "Log in" }).click();
    const ok = await seen(page.getByRole("heading", { name: "My jobs" }));
    await page.waitForTimeout(1500); // a stale 401 handler would fire in this window
    const still = ok && (await page.getByRole("heading", { name: "My jobs" }).isVisible());
    if (!still) kicked.push(`cycle ${i}: logged in then immediately signed out again (url ${page.url()})`);
   } catch (e) {
    const f = path.join(repo, "apps/web/e2e/out", `race-cycle-${i}.png`);
    await page.screenshot({ path: f, fullPage: true }).catch(() => {});
    kicked.push(`cycle ${i}: ${String(e.message).split(String.fromCharCode(10))[0]} @ ${page.url().slice(0, 60)} -> ${f}`);
    break;
   }
  }
  const e401 = net.events.filter((e) => e.status === 401);
  console.log(`cycles: ${CYCLES}`);
  console.log(`fresh logins undone: ${kicked.length}`);
  kicked.forEach((k) => console.log("  " + k));
  console.log(`401 responses: ${e401.length}`);
  for (const e of e401.slice(0, 10)) console.log(`  ${e.method} ${e.url.replace(WEB, "")} in ${e.test}`);
  console.log(`page errors: ${net.pageErrors.length}`);
} finally {
  await browser?.close().catch(() => {});
  stopAll();
}
