// P0 audit: registration, email confirmation, session persistence, role onboarding, profiles, persistence.
import { WEB, check, cleanup, launch, logIn, password, seen, shot, signOut, signUpAndConfirm, summary, uniqueEmail, sql } from "./lib.mjs";

cleanup();
const { browser, page, errors } = await launch();
const w = { role: "worker", name: "Ravi Patel", email: uniqueEmail("worker"), pw: password() };
const e = { role: "employer", name: "Meera Shah", email: uniqueEmail("employer"), pw: password() };

try {
  // ---------------------------------------------------------------- worker
  await signUpAndConfirm(page, w);
  try {
    await page.getByRole("heading", { name: "Find work" }).waitFor({ timeout: 10000 });
    check("worker: email confirmation link signs the user in and opens the worker dashboard", true);
  } catch {
    check("worker: email confirmation link signs the user in and opens the worker dashboard", false, `url=${page.url()}`);
    await shot(page, "p0-worker-after-confirm");
  }

  await page.reload();
  check("worker: session survives a page reload", await seen(page.getByRole("heading", { name: "Find work" })), page.url());

  const row = sql(`select p.role||'|'||p.full_name||'|'||(select count(*) from public.worker_profiles wp where wp.user_id=p.id) from public.profiles p join auth.users u on u.id=p.id where u.email='${w.email}'`);
  check("worker: signup created a worker profile row in the database", row === "worker|Ravi Patel|1", row);

  await page.goto(`${WEB}/worker/profile`);
  await page.getByLabel(/^Area you work in/).waitFor();
  await page.getByRole("option", { name: "Alkapuri" }).waitFor({ state: "attached" });
  await page.getByLabel(/^Area you work in/).selectOption({ label: "Alkapuri" });
  await page.getByRole("checkbox", { name: "Loading & unloading" }).check();
  await page.getByRole("checkbox", { name: "Event help" }).check();
  await page.getByLabel(/Years of experience/).fill("4");
  await page.getByLabel(/About you/).fill("Reliable and punctual. Worked at weddings and warehouses.");
  await page.getByRole("button", { name: "Save profile" }).click();
  check("worker: saving the profile shows a success message", await seen(page.getByText("Profile saved.")));

  await page.reload();
  await page.getByLabel(/^Area you work in/).waitFor();
  await page.getByRole("option", { name: "Alkapuri" }).waitFor({ state: "attached" });
  const persisted =
    (await page.getByLabel(/^Area you work in/).inputValue()) !== "" &&
    (await page.getByRole("checkbox", { name: "Event help" }).isChecked()) &&
    (await page.getByLabel(/Years of experience/).inputValue()) === "4" &&
    (await page.getByLabel(/About you/).inputValue()).includes("Reliable");
  check("worker: profile values persist after a reload (read back from the database)", persisted);
  const db = sql(`select wp.years_experience||'|'||(select count(*) from public.worker_categories c where c.worker_id=wp.user_id) from public.worker_profiles wp join auth.users u on u.id=wp.user_id where u.email='${w.email}'`);
  check("worker: database holds the saved experience and 2 categories", db === "4|2", db);

  await signOut(page);
  check("worker: logout returns to the login page", await seen(page.getByRole("heading", { name: "Log in" })), page.url());
  await page.goto(`${WEB}/worker`);
  check("worker: protected page redirects to login after logout", await seen(page.getByRole("heading", { name: "Log in" })), page.url());

  await logIn(page, w);
  check("worker: logging back in works", await seen(page.getByRole("heading", { name: "Find work" })), page.url());

  // ---------------------------------------------------------------- employer (separate account, fresh context state)
  await page.evaluate(() => localStorage.clear());
  await page.context().clearCookies();
  await signUpAndConfirm(page, e);
  check("employer: confirmation opens the employer dashboard", await seen(page.getByRole("heading", { name: "My jobs" })), page.url());
  await page.goto(`${WEB}/worker`);
  check("employer: worker pages redirect to the employer dashboard", await seen(page.getByRole("heading", { name: "My jobs" })), page.url());

  await page.goto(`${WEB}/employer/profile`);
  await page.getByLabel(/Business or organisation/).fill("Shah Event Services");
  await page.getByRole("button", { name: "Save profile" }).click();
  check("employer: saving the profile shows a success message", await seen(page.getByText("Profile saved.")));
  await page.reload();
  check("employer: organisation name persists after reload", (await page.getByLabel(/Business or organisation/).inputValue({ timeout: 8000 }).catch(() => "")) === "Shah Event Services");
  const org = sql(`select p.org_name from public.profiles p join auth.users u on u.id=p.id where u.email='${e.email}'`);
  check("employer: database holds the organisation name", org === "Shah Event Services", org);

  const bad = errors.filter((x) => !/favicon|Failed to load resource/i.test(x));
  check("no uncaught browser errors during P0 flows", bad.length === 0, bad.slice(0, 3).join(" | "));
} catch (err) {
  check("audit script ran to completion", false, err.message);
  await shot(page, "p0-crash").catch(() => {});
} finally {
  await browser.close();
  cleanup();
}
process.exit(summary() ? 0 : 1);
